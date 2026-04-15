import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cleanupStaleLensCache,
  CURRENT_LENS_CACHE_SCHEMA_VERSION,
  hashLensPrompt,
  readLensCache,
  writeLensCache,
} from "../src/cache/lens-cache.js";
import type { LensFinding } from "../src/schema/finding.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function finding(overrides: Partial<LensFinding> = {}): LensFinding {
  return {
    id: overrides.id ?? "f-1",
    severity: overrides.severity ?? "minor",
    category: overrides.category ?? "generic",
    file: overrides.file ?? null,
    line: overrides.line ?? null,
    description: overrides.description ?? "something",
    suggestion: overrides.suggestion ?? "fix it",
    confidence: overrides.confidence ?? 0.8,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lenses-lens-cache-"));
  process.env.LENSES_LENS_CACHE_DIR = dir;
  delete process.env.LENSES_LENS_CACHE_TTL_MS;
  delete process.env.LENSES_LENS_CACHE_DISABLE;
});

afterEach(() => {
  delete process.env.LENSES_LENS_CACHE_DIR;
  delete process.env.LENSES_LENS_CACHE_TTL_MS;
  delete process.env.LENSES_LENS_CACHE_DISABLE;
  rmSync(dir, { recursive: true, force: true });
});

describe("hashLensPrompt", () => {
  it("same input yields the same 64-char hex hash", () => {
    const h1 = hashLensPrompt("hello");
    const h2 = hashLensPrompt("hello");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("different inputs yield different hashes", () => {
    expect(hashLensPrompt("a")).not.toBe(hashLensPrompt("b"));
  });
});

describe("writeLensCache / readLensCache", () => {
  it("roundtrip: a written entry is readable and shape-equal", () => {
    const findings = [finding({ id: "f-1", severity: "major" })];
    writeLensCache({
      lensId: "security",
      promptHash: HASH_A,
      findings,
      notes: "hello",
    });
    const back = readLensCache("security", HASH_A);
    expect(back).toBeDefined();
    expect(back!.schemaVersion).toBe(CURRENT_LENS_CACHE_SCHEMA_VERSION);
    expect(back!.lensId).toBe("security");
    expect(back!.promptHash).toBe(HASH_A);
    expect(back!.findings).toEqual(findings);
    expect(back!.notes).toBe("hello");
    expect(Number.isFinite(back!.cachedAt)).toBe(true);
  });

  it("second write to the same (lensId, promptHash) overwrites", () => {
    writeLensCache({
      lensId: "security",
      promptHash: HASH_A,
      findings: [finding({ id: "first" })],
      notes: null,
    });
    writeLensCache({
      lensId: "security",
      promptHash: HASH_A,
      findings: [finding({ id: "second" })],
      notes: "updated",
    });
    const back = readLensCache("security", HASH_A);
    expect(back).toBeDefined();
    expect(back!.findings).toHaveLength(1);
    expect(back!.findings[0]!.id).toBe("second");
    expect(back!.notes).toBe("updated");
  });

  it("different (lensId, promptHash) pairs isolate", () => {
    writeLensCache({
      lensId: "security",
      promptHash: HASH_A,
      findings: [finding({ id: "sec-a" })],
      notes: null,
    });
    writeLensCache({
      lensId: "clean-code",
      promptHash: HASH_A,
      findings: [finding({ id: "cc-a" })],
      notes: null,
    });
    writeLensCache({
      lensId: "security",
      promptHash: HASH_B,
      findings: [finding({ id: "sec-b" })],
      notes: null,
    });
    expect(readLensCache("security", HASH_A)!.findings[0]!.id).toBe("sec-a");
    expect(readLensCache("clean-code", HASH_A)!.findings[0]!.id).toBe("cc-a");
    expect(readLensCache("security", HASH_B)!.findings[0]!.id).toBe("sec-b");
  });

  it("file is written with mode 0o600 (owner-only read/write)", () => {
    writeLensCache({
      lensId: "security",
      promptHash: HASH_A,
      findings: [],
      notes: null,
    });
    const st = statSync(join(dir, `security-${HASH_A}.json`));
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("leaves no `.tmp` leftover after a normal write", () => {
    writeLensCache({
      lensId: "security",
      promptHash: HASH_A,
      findings: [],
      notes: null,
    });
    expect(readdirSync(dir).filter((e) => e.endsWith(".tmp"))).toHaveLength(0);
  });
});

describe("readLensCache failure modes", () => {
  it("returns undefined for a missing file", () => {
    expect(readLensCache("security", HASH_A)).toBeUndefined();
  });

  it("returns undefined for a zero-byte file", () => {
    writeFileSync(join(dir, `security-${HASH_A}.json`), "");
    expect(readLensCache("security", HASH_A)).toBeUndefined();
  });

  it("returns undefined for a truncated JSON file", () => {
    writeFileSync(
      join(dir, `security-${HASH_A}.json`),
      '{"schemaVersion": 1, "lensId":',
    );
    expect(readLensCache("security", HASH_A)).toBeUndefined();
  });

  it("returns undefined for a record with a mismatched schemaVersion", () => {
    const future = {
      schemaVersion: 99,
      lensId: "security",
      promptHash: HASH_A,
      findings: [],
      notes: null,
      cachedAt: 1,
    };
    writeFileSync(join(dir, `security-${HASH_A}.json`), JSON.stringify(future));
    expect(readLensCache("security", HASH_A)).toBeUndefined();
  });

  it("returns undefined when the file is larger than MAX_LENS_CACHE_BYTES", () => {
    // 1 MB + 1 of padding inside a JSON-ish blob. The content is
    // bogus JSON, but we only get as far as the stat check before
    // rejecting it, so the body doesn't need to be valid.
    const blob = "x".repeat(1024 * 1024 + 1024);
    writeFileSync(join(dir, `security-${HASH_A}.json`), blob);
    expect(readLensCache("security", HASH_A)).toBeUndefined();
  });

  it("returns undefined when the record's lensId disagrees with the caller's key", () => {
    // Write a valid `clean-code` record into security's filename.
    // readLensCache("security", HASH_A) must refuse the cross-identity
    // hit -- the cross-check is defense-in-depth against a rename
    // drift.
    const rogue = {
      schemaVersion: 1,
      lensId: "clean-code",
      promptHash: HASH_A,
      findings: [],
      notes: null,
      cachedAt: 1,
    };
    writeFileSync(join(dir, `security-${HASH_A}.json`), JSON.stringify(rogue));
    expect(readLensCache("security", HASH_A)).toBeUndefined();
  });

  it("returns undefined when the record's promptHash disagrees with the caller's key", () => {
    const rogue = {
      schemaVersion: 1,
      lensId: "security",
      promptHash: HASH_B,
      findings: [],
      notes: null,
      cachedAt: 1,
    };
    writeFileSync(join(dir, `security-${HASH_A}.json`), JSON.stringify(rogue));
    expect(readLensCache("security", HASH_A)).toBeUndefined();
  });
});

describe("cleanupStaleLensCache", () => {
  it("removes files older than maxAgeMs and leaves fresher ones", () => {
    writeLensCache({
      lensId: "security",
      promptHash: HASH_A,
      findings: [],
      notes: null,
    });
    writeLensCache({
      lensId: "clean-code",
      promptHash: HASH_A,
      findings: [],
      notes: null,
    });
    // Spoof the A-record's cachedAt AND file mtime so both the
    // record path and the mtime-fallback path agree it's stale.
    const pathA = join(dir, `security-${HASH_A}.json`);
    const raw = JSON.parse(readFileSync(pathA, "utf8"));
    raw.cachedAt = Date.now() - 60_000;
    writeFileSync(pathA, JSON.stringify(raw));
    const stalePast = new Date(Date.now() - 60_000);
    utimesSync(pathA, stalePast, stalePast);

    const { removed } = cleanupStaleLensCache(30_000);
    expect(removed).toBe(1);
    expect(readLensCache("security", HASH_A)).toBeUndefined();
    expect(readLensCache("clean-code", HASH_A)).toBeDefined();
  });

  it("a corrupt file older than the TTL is still cleaned (mtime fallback)", () => {
    const corrupt = join(dir, `security-${HASH_A}.json`);
    writeFileSync(corrupt, "{broken");
    const stalePast = new Date(Date.now() - 60_000);
    utimesSync(corrupt, stalePast, stalePast);
    const { removed } = cleanupStaleLensCache(30_000);
    expect(removed).toBe(1);
  });

  it("non-.json entries are left alone", () => {
    writeFileSync(join(dir, "unrelated.txt"), "leave me");
    writeLensCache({
      lensId: "security",
      promptHash: HASH_A,
      findings: [],
      notes: null,
    });
    cleanupStaleLensCache(1);
    expect(readdirSync(dir)).toContain("unrelated.txt");
  });

  it("returns {removed: 0} when the cache directory is empty", () => {
    expect(cleanupStaleLensCache()).toEqual({ removed: 0 });
  });

  it("LENSES_LENS_CACHE_TTL_MS env override is honored by the default arg", () => {
    const pathA = join(dir, `security-${HASH_A}.json`);
    writeLensCache({
      lensId: "security",
      promptHash: HASH_A,
      findings: [],
      notes: null,
    });
    // Spoof both record cachedAt and mtime to ~2 seconds old.
    const raw = JSON.parse(readFileSync(pathA, "utf8"));
    raw.cachedAt = Date.now() - 2000;
    writeFileSync(pathA, JSON.stringify(raw));
    const past = new Date(Date.now() - 2000);
    utimesSync(pathA, past, past);

    process.env.LENSES_LENS_CACHE_TTL_MS = "1000";
    const { removed } = cleanupStaleLensCache();
    expect(removed).toBe(1);
  });
});

describe("env and schema invariants", () => {
  it("LENSES_LENS_CACHE_DIR override directs all I/O to the chosen dir", () => {
    writeLensCache({
      lensId: "security",
      promptHash: HASH_A,
      findings: [],
      notes: null,
    });
    expect(readdirSync(dir)).toContain(`security-${HASH_A}.json`);
  });

  it("LENSES_LENS_CACHE_DISABLE=1 makes readLensCache return undefined", () => {
    writeLensCache({
      lensId: "security",
      promptHash: HASH_A,
      findings: [finding({ id: "live" })],
      notes: null,
    });
    process.env.LENSES_LENS_CACHE_DISABLE = "1";
    expect(readLensCache("security", HASH_A)).toBeUndefined();
  });

  it("LENSES_LENS_CACHE_DISABLE=1 makes writeLensCache a no-op (no file created)", () => {
    process.env.LENSES_LENS_CACHE_DISABLE = "1";
    writeLensCache({
      lensId: "security",
      promptHash: HASH_A,
      findings: [finding()],
      notes: null,
    });
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("writeLensCache throws on an invalid finding (defense-in-depth parse)", () => {
    // Severity outside the enum fails LensFindingSchema. Cast
    // intentionally: this verifies the runtime schema check, not the
    // type check.
    const bad = {
      ...finding(),
      severity: "catastrophic" as unknown as LensFinding["severity"],
    };
    expect(() =>
      writeLensCache({
        lensId: "security",
        promptHash: HASH_A,
        findings: [bad],
        notes: null,
      }),
    ).toThrow();
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("atomicity: a failing second write leaves the first record intact", () => {
    writeLensCache({
      lensId: "security",
      promptHash: HASH_A,
      findings: [finding({ id: "first" })],
      notes: null,
    });
    const bad = {
      ...finding(),
      severity: "catastrophic" as unknown as LensFinding["severity"],
    };
    expect(() =>
      writeLensCache({
        lensId: "security",
        promptHash: HASH_A,
        findings: [bad],
        notes: null,
      }),
    ).toThrow();
    const back = readLensCache("security", HASH_A);
    expect(back).toBeDefined();
    expect(back!.findings[0]!.id).toBe("first");
    expect(readdirSync(dir).filter((e) => e.endsWith(".tmp"))).toHaveLength(0);
  });

  it("CURRENT_LENS_CACHE_SCHEMA_VERSION is 1 (breaking changes require a bump)", () => {
    expect(CURRENT_LENS_CACHE_SCHEMA_VERSION).toBe(1);
  });
});
