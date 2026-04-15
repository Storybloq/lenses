/**
 * T-015 per-lens result cache. Disk-backed store keyed by the SHA-256
 * of the full lens prompt string. Parallel to T-014's `session.ts` in
 * filesystem conventions (atomic tmp+rename, mode 0o600 files, 0o700
 * dir, safeParse-on-read, best-effort cleanup) but with a different
 * identity model: one file per `(lensId, promptHash)` pair, globally
 * shared across sessions.
 *
 * Scope boundary: this module owns storage, schema, and hashing. It
 * does NOT decide when to write or read the cache -- that's hop-1
 * (`tools/start.ts`) and hop-2 (`tools/complete.ts`). Keeping policy
 * out of here means cache disable / error-output skip decisions stay
 * co-located with their call sites.
 *
 * Failure mode policy (mirrors session.ts):
 *  - `writeLensCache` throws on real I/O failures; caller wraps in
 *    try/catch per RULES.md §4. `LENSES_LENS_CACHE_DISABLE` makes it
 *    a silent no-op instead.
 *  - `readLensCache` returns `undefined` for every recoverable
 *    failure (missing, truncated, schemaVersion mismatch, size cap,
 *    lensId/promptHash mismatch between filename and record). Also
 *    `undefined` when DISABLE is set.
 *  - `cleanupStaleLensCache` swallows per-file errors.
 *
 * Why a 24h TTL (vs session.ts's 7d): a stale lens cache hit silently
 * returns prior findings instead of re-running the lens. Staleness
 * here has a direct correctness cost (may miss a regression that
 * would have been caught on a re-run). Bias toward fresh over stale.
 *
 * Why SHA-256 of the full prompt (not a structured key tuple): the
 * prompt is the only thing the lens operates on. Two runs with the
 * same prompt are definitionally reviewing the same thing. Any
 * upstream change (artifact edit, stage flip, preamble tweak, lens
 * version bump, projectContext drift, activation-reason change) that
 * affects review semantics propagates into the prompt string, and
 * therefore into the hash. There is no "forgot to invalidate when X
 * changed" failure mode.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { LensIdSchema } from "../lenses/registry.js";
import type { LensId } from "../lenses/prompts/index.js";
import { LensFindingSchema, type LensFinding } from "../schema/finding.js";

/**
 * Single cached entry. `lensId` and `promptHash` are duplicated in
 * the filename AND the record body so a filename/content drift (e.g.,
 * a manual mv, a rename bug) is detectable -- `readLensCache`
 * cross-checks both on read. `findings` reuses `LensFindingSchema`
 * directly, so any evolution of that shape propagates into the cache
 * by construction; stale-shaped files fail `safeParse` and are
 * treated as a miss.
 */
export const CachedLensResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    lensId: LensIdSchema,
    promptHash: z.string().regex(/^[a-f0-9]{64}$/),
    findings: z.array(LensFindingSchema),
    notes: z.string().nullable(),
    cachedAt: z.number().int().min(0),
  })
  .strict();
export type CachedLensResult = z.infer<typeof CachedLensResultSchema>;

export const CURRENT_LENS_CACHE_SCHEMA_VERSION = 1 as const;

/** Default TTL. Override via `LENSES_LENS_CACHE_TTL_MS`. */
const DEFAULT_LENS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Hard per-entry cap. `findingBudget: 50` × reasonable description
 * length stays well under 1 MB; a larger file is treated as
 * malformed. Checked via `stat` BEFORE `readFileSync` so a
 * pathological multi-GB file cannot blow up memory.
 */
const MAX_LENS_CACHE_BYTES = 1 * 1024 * 1024;

/**
 * `true` when the caller has opted out of both reads and writes.
 * Evaluated on every call (not cached) so a test can toggle the env
 * var without a module reload.
 */
function isDisabled(): boolean {
  const raw = process.env.LENSES_LENS_CACHE_DISABLE;
  return raw !== undefined && raw.length > 0;
}

/**
 * Resolve and create-if-missing the cache directory. Mirrors
 * session.ts's pattern: every call re-reads the env override, re-runs
 * `mkdirSync({recursive: true, mode: 0o700})`, and force-chmods to
 * 0o700 (mkdir's mode is ignored on pre-existing dirs). Chmod is
 * swallowed because operator-provided override paths may not be
 * chown'd to us.
 */
export function lensCacheDir(): string {
  const override = process.env.LENSES_LENS_CACHE_DIR;
  const dir =
    override !== undefined && override.length > 0
      ? override
      : join(tmpdir(), "lenses-lens-cache");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort: non-owned dir is still usable, just not re-locked.
  }
  return dir;
}

/**
 * SHA-256 hex digest of the input prompt. Used as both the cache key
 * and the `promptHash` field on the stored record. Stable across
 * runs (`buildLensPrompt` is pure) so identical prompts collide
 * deliberately.
 */
export function hashLensPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

function lensCacheFilePath(lensId: LensId, promptHash: string): string {
  return join(lensCacheDir(), `${lensId}-${promptHash}.json`);
}

/**
 * Look up a cached result. Returns `undefined` for every recoverable
 * failure (missing file, truncated, schema-mismatched, size-cap
 * exceeded, lensId or promptHash inside the record disagrees with
 * the filename-derived key). A hit means the caller may skip
 * spawning the lens and use `findings` + `notes` directly.
 */
export function readLensCache(
  lensId: LensId,
  promptHash: string,
): CachedLensResult | undefined {
  if (isDisabled()) return undefined;
  const path = lensCacheFilePath(lensId, promptHash);
  if (!existsSync(path)) return undefined;
  try {
    const st = statSync(path);
    if (st.size > MAX_LENS_CACHE_BYTES) return undefined;
  } catch {
    return undefined;
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  if (raw.length === 0) return undefined;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = CachedLensResultSchema.safeParse(parsedJson);
  if (!result.success) return undefined;
  // Cross-check: the record's self-declared identity must match the
  // caller-provided key. A mismatch indicates filename drift (e.g.,
  // manual rename) or a collision attempt -- either way, treat as a
  // miss rather than a hit on a misidentified entry.
  if (result.data.lensId !== lensId) return undefined;
  if (result.data.promptHash !== promptHash) return undefined;
  return result.data;
}

/**
 * Persist a lens result. Overwrites any prior entry for the same
 * `(lensId, promptHash)` -- unlike session.ts's append model, each
 * file here holds exactly one entry. Atomic via tmp+rename with a
 * per-write nonce (`<lensId>-<promptHash>.<uuid>.tmp`) so a crashed
 * writer or concurrent caller cannot leave a stale file that looks
 * like a valid target, and the final path cannot be partially
 * written.
 *
 * `DISABLE=1` short-circuits to a no-op -- no file created. Note this
 * means round-1 writes are skipped under DISABLE, so round-2 with
 * DISABLE=0 will still miss. Documented in plan §3.
 */
export function writeLensCache(input: {
  readonly lensId: LensId;
  readonly promptHash: string;
  readonly findings: readonly LensFinding[];
  readonly notes: string | null;
}): void {
  if (isDisabled()) return;
  // Resolve dir ONCE per write so `tmp` and `final` are guaranteed
  // to share a filesystem. Same rationale as T-014's equivalent fix.
  const dir = lensCacheDir();
  const final = join(dir, `${input.lensId}-${input.promptHash}.json`);
  const record: CachedLensResult = {
    schemaVersion: CURRENT_LENS_CACHE_SCHEMA_VERSION,
    lensId: input.lensId,
    promptHash: input.promptHash,
    findings: [...input.findings],
    notes: input.notes,
    cachedAt: Date.now(),
  };
  // Defense-in-depth: re-validate before writing so a caller-built
  // record with an invalid severity (e.g., from a compromised merger
  // path) cannot pollute the cache.
  CachedLensResultSchema.parse(record);
  const tmp = join(
    dir,
    `${input.lensId}-${input.promptHash}.${randomUUID()}.tmp`,
  );
  writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  try {
    renameSync(tmp, final);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort: nothing to do if even unlink fails.
    }
    throw err;
  }
}

/**
 * Sweep the cache directory, deleting any `*.json` whose `cachedAt`
 * (or mtime fallback) is older than `maxAgeMs`. Per-file errors are
 * swallowed so one unreadable file does not block the rest. `.tmp`
 * files are NOT swept here (writer unlinks them on rename failure);
 * a crashed process could leave a `.tmp` behind but the nonce
 * ensures it cannot be confused with a valid target.
 */
export function cleanupStaleLensCache(
  maxAgeMs: number = resolveLensCacheTtl(),
): { removed: number } {
  const dir = lensCacheDir();
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { removed: 0 };
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      // Size-cap defense: a pathological multi-GB file must not
      // blow up memory during a sweep. Mirrors `readLensCache`'s
      // own cap. When over-cap, we still evaluate staleness via
      // mtime -- so the cleaner can evict an oversized file instead
      // of leaving it to grow forever.
      let cachedAt: number;
      if (st.size > MAX_LENS_CACHE_BYTES) {
        cachedAt = st.mtimeMs;
      } else {
        let raw: string;
        try {
          raw = readFileSync(full, "utf8");
        } catch {
          continue;
        }
        try {
          const parsed = CachedLensResultSchema.safeParse(JSON.parse(raw));
          cachedAt = parsed.success ? parsed.data.cachedAt : st.mtimeMs;
        } catch {
          cachedAt = st.mtimeMs;
        }
      }
      if (cachedAt < cutoff) {
        unlinkSync(full);
        removed += 1;
      }
    } catch {
      // swallow per-file errors; next sweep will retry.
    }
  }
  return { removed };
}

function resolveLensCacheTtl(): number {
  const raw = process.env.LENSES_LENS_CACHE_TTL_MS;
  if (raw === undefined || raw.length === 0) return DEFAULT_LENS_CACHE_TTL_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LENS_CACHE_TTL_MS;
}
