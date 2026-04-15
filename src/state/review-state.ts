/**
 * In-memory state machine for the two-hop lens review flow. Tracks each
 * review by its `reviewId` so that `lens_review_complete` (T-009) can
 * enforce: (1) the reviewId came from a real `lens_review_start`, (2) the
 * agent returned a result for every expected lens, (3) the same reviewId
 * is never completed twice. Schema validation of per-lens payloads is
 * Zod's responsibility in T-009 -- this module tracks identity, not
 * content.
 *
 * Storage is a process-local `Map`, keyed by the per-round `reviewId`.
 * The payload carries the cross-round `sessionId` (T-014) so
 * `complete.ts` can stitch round records onto the disk cache without
 * reparsing the start-time envelope. T-014's disk cache is a separate
 * module (`src/cache/session.ts`) -- identity lives here; persistence
 * lives there.
 */

import type { LensId } from "../lenses/prompts/index.js";
import type { DeferralKey, LensFinding, Stage } from "../schema/index.js";

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

export type ReviewStatus = "started" | "complete";

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
   * map when T-015 is disabled or all lenses miss. `validateAndComplete`
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
}

/**
 * Result of `validateAndComplete`. Fully discriminated on `code` so
 * `exactOptionalPropertyTypes` callers can read `missing` directly after
 * narrowing to `"missing_lenses"` without `?? []` boilerplate.
 */
export type CompleteValidationResult =
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
    // T-015: defaults ensure pre-T-015 call sites (and tests that
    // don't care about caching) see the same shape without having to
    // pass empty maps everywhere.
    cachedResults: params.cachedResults ?? new Map(),
    promptHashes: params.promptHashes ?? new Map(),
  });
}

/** Look up without mutation. Undefined means "never registered or
 * already evicted" -- this module doesn't evict, so for T-020 the only
 * reason is "never registered". */
export function getReview(reviewId: string): ReviewSession | undefined {
  return sessions.get(reviewId);
}

/**
 * Validate a `lens_review_complete` submission and, on success, atomically
 * transition `started → complete`. Returns a discriminated union so T-009
 * can `switch (v.code)` exhaustively instead of parsing a string message.
 *
 * Extra lens ids beyond `expectedLensIds` are ignored here -- T-009's
 * Zod pass owns unknown-id rejection, and reporting the same mistake
 * from two layers would produce noisy overlapping errors.
 */
export function validateAndComplete(params: {
  readonly reviewId: string;
  readonly providedLensIds: readonly LensId[];
}): CompleteValidationResult {
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
  // T-015: a lens present in `session.cachedResults` was already
  // resolved at hop-1 time from the disk cache, so the agent was
  // instructed NOT to spawn it. The submission legitimately omits
  // those lenses; treat them as covered here alongside the agent's
  // fresh results. Fresh wins on overlap -- that tie-break is a
  // merger-layer concern; at this boundary we only care whether the
  // union covers the expected set.
  const provided = new Set<string>(params.providedLensIds);
  for (const lensId of session.cachedResults.keys()) provided.add(lensId);
  const missing = session.expectedLensIds.filter((id) => !provided.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      code: "missing_lenses",
      message: `review state: submission missing ${missing.length} expected lens result(s): ${missing.join(", ")}`,
      missing,
    };
  }
  const next: ReviewSession = { ...session, status: "complete" };
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
