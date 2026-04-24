/**
 * In-memory state machine for the two-hop lens review flow. Tracks each
 * review by its `reviewId` so that `lens_review_complete` (T-009) can
 * enforce: (1) the reviewId came from a real `lens_review_start`, (2) the
 * agent returned a result for every expected lens, (3) the same reviewId
 * is never completed twice (pre-T-022) OR (post-T-022) that retry
 * submissions advance `perLensAttempts` monotonically.
 *
 * Storage is a process-local `Map`, keyed by the per-round `reviewId`.
 * The payload carries the cross-round `sessionId` (T-014) so
 * `complete.ts` can stitch round records onto the disk cache without
 * reparsing the start-time envelope. T-014's disk cache is a separate
 * module (`src/cache/session.ts`) -- identity lives here; persistence
 * lives there. T-024 will move the retry state this file tracks onto
 * disk; T-022 keeps it in-memory so the state-machine correctness is
 * settled before adding the disk format.
 */

import type { LensId } from "../lenses/prompts/index.js";
import type {
  DeferralKey,
  LensFinding,
  LensOutput,
  Stage,
} from "../schema/index.js";

/**
 * Cached lens output rehydrated at hop-1 from `lens-cache.ts`. Mirrors
 * the shape of a live `LensOutput` with `status: "ok"` (cached error
 * outputs are not persisted by design -- see lens-cache.ts header).
 * Carried on the session so hop-2 can re-inject these entries into
 * `perLens` without an additional disk read.
 */
export interface CachedLensEntry {
  readonly findings: readonly LensFinding[];
  readonly notes: string | null;
}

/**
 * Session lifecycle:
 *  - `started`    — hop-1 done; no hop-2 submission seen yet.
 *  - `awaiting_retry` — at least one hop-2 call succeeded but produced
 *                   `nextActions[]`; the caller may resubmit the named
 *                   lenses with incremented `attempt`.
 *  - `complete`   — terminal; either all nextActions resolved OR any
 *                   retry exhausted `maxAttempts`.
 *
 * Status transitions are owned by `applyCompletion` so the rules live
 * next to the attempt-advancement logic.
 */
export type ReviewStatus = "started" | "awaiting_retry" | "complete";

/**
 * A single in-flight review session. Every field is `readonly` so the
 * whole record acts as an immutable value -- state transitions REPLACE
 * the Map entry via spread (`{ ...session, status: "complete" }`), they
 * never mutate in place. References handed out by a prior `getReview`
 * call therefore keep observing the state that was current at lookup
 * time, which is the contract the test suite pins.
 */
export interface ReviewSession {
  readonly reviewId: string;
  readonly sessionId: string;
  readonly stage: Stage;
  readonly expectedLensIds: readonly LensId[];
  readonly reviewRound: number;
  readonly priorDeferrals: readonly DeferralKey[];
  readonly startedAt: number;
  readonly status: ReviewStatus;
  /**
   * T-015: lens results resolved from the disk cache at hop-1. Empty
   * map when T-015 is disabled or all lenses miss. `applyCompletion`
   * treats any lens with an entry here as already-provided so the
   * agent only has to submit results for the spawned (non-cached)
   * lenses. `complete.ts` re-injects these into `perLens` before
   * running the merger so cached findings pass through dedup,
   * confidence-filter, tension, and blocking-policy the same way
   * fresh findings do.
   */
  readonly cachedResults: ReadonlyMap<LensId, CachedLensEntry>;
  /**
   * T-015: SHA-256 prompt hash for every activated lens (cached OR
   * spawned). `complete.ts` reads this map to know what hash to write
   * against each lensId on cache update. Mapped value is the hex
   * string as produced by `hashLensPrompt(prompt)`.
   */
  readonly promptHashes: ReadonlyMap<LensId, string>;
  /**
   * T-022: the ORIGINAL per-lens prompt text for every spawned lens,
   * keyed by lensId. `lens_review_get_prompt` reads off this map.
   * Cached lenses are not in this map (they have no prompt to fetch;
   * their findings are inlined in hop-1 `cached[]`).
   *
   * Held in memory only; T-024 moves prompts to disk records.
   */
  readonly prompts: ReadonlyMap<LensId, string>;
  /**
   * T-022: wall-clock expiry (epoch ms) per activated lens. Computed
   * once at hop-1 via `resolveLensTimeoutMs(model, config)`. `complete.ts`
   * rejects any submission whose server-receive time exceeds this
   * value with `REVIEW_EXPIRED`. Cached lenses are not in this map
   * (their results were produced before hop-1 and carry no retry
   * deadline).
   */
  readonly perLensExpiresAt: ReadonlyMap<LensId, number>;
  /**
   * T-022: highest `attempt` seen per lens. `0` (or absent) means no
   * submission yet. Advances atomically by exactly 1 per successful
   * `applyCompletion` call. Double-submits (equal attempt) and
   * non-contiguous attempts (skipping numbers) are hard-rejected.
   */
  readonly perLensAttempts: ReadonlyMap<LensId, number>;
  /**
   * T-022: the latest successfully-parsed `LensOutput` per lens. On a
   * retry this value is overwritten; the merger runs over the latest
   * view plus `cachedResults` plus any lenses still pending retry
   * (which surface as status="error" placeholders until they land).
   */
  readonly perLensLatestOutput: ReadonlyMap<LensId, LensOutput>;
}

/**
 * Result of `applyCompletion`. Fully discriminated on `code` so
 * `exactOptionalPropertyTypes` callers can read `missing` directly
 * after narrowing to `"missing_lenses"` without `?? []` boilerplate.
 */
export type ApplyCompletionResult =
  | { readonly ok: true; readonly session: ReviewSession }
  | {
      readonly ok: false;
      readonly code: "unknown";
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly code: "already_complete";
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly code: "missing_lenses";
      readonly message: string;
      readonly missing: readonly LensId[];
    }
  | {
      readonly ok: false;
      readonly code: "stale_attempt";
      readonly message: string;
      readonly lensId: LensId;
      readonly highestSeen: number;
      readonly submittedAttempt: number;
    }
  | {
      readonly ok: false;
      readonly code: "non_contiguous_attempt";
      readonly message: string;
      readonly lensId: LensId;
      readonly expected: number;
      readonly submittedAttempt: number;
    }
  | {
      readonly ok: false;
      readonly code: "review_expired";
      readonly message: string;
      readonly lensId: LensId;
      readonly expiresAt: number;
    };

const sessions = new Map<string, ReviewSession>();

/**
 * Record a fresh session after `lens_review_start` built prompts. Throws
 * on a duplicate `reviewId` -- with `crypto.randomUUID()` a collision is
 * a programmer error, not an expected condition. The throw propagates
 * into `buildResponse`, where the existing outer try/catch in
 * `handleLensReviewStart` converts it into an MCP isError response.
 */
export function registerReview(params: {
  readonly reviewId: string;
  readonly sessionId: string;
  readonly stage: Stage;
  readonly expectedLensIds: readonly LensId[];
  readonly reviewRound: number;
  readonly priorDeferrals: readonly DeferralKey[];
  readonly cachedResults?: ReadonlyMap<LensId, CachedLensEntry>;
  readonly promptHashes?: ReadonlyMap<LensId, string>;
  readonly prompts?: ReadonlyMap<LensId, string>;
  readonly perLensExpiresAt?: ReadonlyMap<LensId, number>;
}): void {
  if (sessions.has(params.reviewId)) {
    throw new Error(
      `review state: reviewId already registered: ${params.reviewId}`,
    );
  }
  sessions.set(params.reviewId, {
    reviewId: params.reviewId,
    sessionId: params.sessionId,
    stage: params.stage,
    expectedLensIds: params.expectedLensIds,
    reviewRound: params.reviewRound,
    priorDeferrals: params.priorDeferrals,
    startedAt: Date.now(),
    status: "started",
    cachedResults: params.cachedResults ?? new Map(),
    promptHashes: params.promptHashes ?? new Map(),
    prompts: params.prompts ?? new Map(),
    perLensExpiresAt: params.perLensExpiresAt ?? new Map(),
    perLensAttempts: new Map(),
    perLensLatestOutput: new Map(),
  });
}

/** Look up without mutation. */
export function getReview(reviewId: string): ReviewSession | undefined {
  return sessions.get(reviewId);
}

/**
 * T-022 submission apply. Validates a hop-2 batch (possibly a partial
 * retry batch), advances per-lens attempt counters atomically under
 * Node's single-threaded event loop, and returns the updated session
 * for the merger pipeline to run over.
 *
 * Success transitions:
 *  - `started` → `awaiting_retry` when caller advances; caller passes
 *    `finalize: false` so the session remains open for retry submissions.
 *  - `started` / `awaiting_retry` → `complete` when caller passes
 *    `finalize: true` (no more retries expected).
 *
 * Rejections (see `ApplyCompletionResult.code`):
 *  - `unknown`: reviewId not registered.
 *  - `already_complete`: caller trying to mutate a terminal session.
 *  - `missing_lenses`: first call does not cover the expected set
 *    (union of submitted lenses + cachedResults). Only enforced when
 *    the session has not yet transitioned out of `started` — retry
 *    batches may legitimately cover a subset.
 *  - `stale_attempt`: submitted attempt ≤ highest seen for that lens
 *    (double-submit or an out-of-order arrival).
 *  - `non_contiguous_attempt`: submitted attempt skipped a number.
 *  - `review_expired`: `now > expiresAt[lensId]` at receive time.
 *
 * Synchronous body; the surrounding async handler serializes concurrent
 * calls at this boundary, so no lock or generation counter is needed.
 */
export interface SubmittedResult {
  readonly lensId: LensId;
  readonly output: LensOutput;
  readonly attempt: number;
}

export function applyCompletion(params: {
  readonly reviewId: string;
  readonly results: readonly SubmittedResult[];
  readonly finalize: boolean;
  readonly now?: number;
}): ApplyCompletionResult {
  const session = sessions.get(params.reviewId);
  if (!session) {
    return {
      ok: false,
      code: "unknown",
      message: `review state: unknown reviewId: ${params.reviewId}`,
    };
  }
  if (session.status === "complete") {
    return {
      ok: false,
      code: "already_complete",
      message: `review state: reviewId already completed: ${params.reviewId}`,
    };
  }

  const now = params.now ?? Date.now();

  // Attempt validation across the batch first — reject the whole batch
  // if any entry is invalid, so we never half-apply.
  const nextAttempts = new Map(session.perLensAttempts);
  for (const r of params.results) {
    const highestSeen = session.perLensAttempts.get(r.lensId) ?? 0;
    if (r.attempt <= highestSeen) {
      return {
        ok: false,
        code: "stale_attempt",
        message: `review state: stale attempt ${r.attempt} for lens '${r.lensId}' (highest seen: ${highestSeen})`,
        lensId: r.lensId,
        highestSeen,
        submittedAttempt: r.attempt,
      };
    }
    if (r.attempt !== highestSeen + 1) {
      return {
        ok: false,
        code: "non_contiguous_attempt",
        message: `review state: non-contiguous attempt for lens '${r.lensId}' (expected ${highestSeen + 1}, got ${r.attempt})`,
        lensId: r.lensId,
        expected: highestSeen + 1,
        submittedAttempt: r.attempt,
      };
    }
    const expires = session.perLensExpiresAt.get(r.lensId);
    if (expires !== undefined && now > expires) {
      return {
        ok: false,
        code: "review_expired",
        message: `review state: REVIEW_EXPIRED for lens '${r.lensId}' (expired at ${new Date(expires).toISOString()})`,
        lensId: r.lensId,
        expiresAt: expires,
      };
    }
    nextAttempts.set(r.lensId, r.attempt);
  }

  // Coverage check only fires on the FIRST submission (status === "started").
  // Retry batches legitimately cover only the subset named in
  // `nextActions[]` — the other lenses were already accepted in prior
  // batches, so their coverage is implied by `perLensLatestOutput`.
  if (session.status === "started") {
    const provided = new Set<string>(params.results.map((r) => r.lensId));
    for (const lensId of session.cachedResults.keys()) provided.add(lensId);
    const missing = session.expectedLensIds.filter(
      (id) => !provided.has(id),
    );
    if (missing.length > 0) {
      return {
        ok: false,
        code: "missing_lenses",
        message: `review state: submission missing ${missing.length} expected lens result(s): ${missing.join(", ")}`,
        missing,
      };
    }
  }

  // Update latest output map.
  const nextOutputs = new Map(session.perLensLatestOutput);
  for (const r of params.results) nextOutputs.set(r.lensId, r.output);

  const nextStatus: ReviewStatus = params.finalize ? "complete" : "awaiting_retry";
  const next: ReviewSession = {
    ...session,
    status: nextStatus,
    perLensAttempts: nextAttempts,
    perLensLatestOutput: nextOutputs,
  };
  sessions.set(session.reviewId, next);
  return { ok: true, session: next };
}

/**
 * @internal Test-only reset. Imported directly by test files; NOT
 * re-exported from the package barrel so production code cannot reach it.
 */
export function _resetForTests(): void {
  sessions.clear();
}
