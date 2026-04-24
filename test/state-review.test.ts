import { beforeEach, describe, expect, it } from "vitest";

import type { LensId } from "../src/lenses/prompts/index.js";
import type { LensOutput } from "../src/schema/index.js";
import {
  _resetForTests,
  applyCompletion,
  getReview,
  registerReview,
  type SubmittedResult,
} from "../src/state/review-state.js";

const RID = "11111111-1111-4111-8111-111111111111";
// T-014: ReviewSession now carries a cross-round sessionId. Pinned to
// a textually-distinct value from RID so any regression that
// accidentally uses reviewId as sessionId fails loudly.
const SID = "22222222-2222-4222-8222-222222222222";
const LENSES: readonly LensId[] = ["security", "clean-code", "performance"];

/**
 * Minimal registerReview caller. Keeps the per-test call sites focused
 * on the invariant under test (state-machine behavior) rather than on
 * the T-014 boilerplate (sessionId / reviewRound / priorDeferrals),
 * all of which the state machine simply stashes and hands back.
 */
function register(
  overrides: Partial<Parameters<typeof registerReview>[0]> = {},
): void {
  registerReview({
    reviewId: RID,
    sessionId: SID,
    stage: "PLAN_REVIEW",
    expectedLensIds: LENSES,
    reviewRound: 1,
    priorDeferrals: [],
    ...overrides,
  });
}

/**
 * T-022 helper: build a SubmittedResult for a lens with a clean `ok`
 * payload. Tests that need a specific `status: "error"` / findings list
 * override via the second arg.
 */
function ok(
  lensId: LensId,
  attempt = 1,
  overrides: Partial<LensOutput> = {},
): SubmittedResult {
  return {
    lensId,
    attempt,
    output: {
      status: "ok",
      findings: [],
      error: null,
      notes: null,
      ...overrides,
    } as LensOutput,
  };
}

beforeEach(() => {
  _resetForTests();
});

describe("registerReview", () => {
  it("stores a session in started state with a finite startedAt near now", () => {
    const before = Date.now();
    register();
    const after = Date.now();
    const s = getReview(RID);
    expect(s).toBeDefined();
    if (!s) throw new Error();
    expect(s.status).toBe("started");
    expect(s.reviewId).toBe(RID);
    expect(s.stage).toBe("PLAN_REVIEW");
    expect(Number.isFinite(s.startedAt)).toBe(true);
    expect(s.startedAt).toBeGreaterThanOrEqual(before);
    expect(s.startedAt).toBeLessThanOrEqual(after);
  });

  it("preserves expectedLensIds order and length exactly", () => {
    register({ stage: "CODE_REVIEW" });
    expect(getReview(RID)?.expectedLensIds).toEqual(LENSES);
  });

  it("throws on re-registration of the same reviewId", () => {
    register();
    expect(() => register()).toThrow(/already registered/);
  });

  // T-014: the new fields (sessionId, reviewRound, priorDeferrals) are
  // stashed on the session so complete.ts can build a RoundRecord
  // without reparsing the start-time envelope.
  it("stashes sessionId, reviewRound, and priorDeferrals on the session", () => {
    register({
      reviewRound: 3,
      priorDeferrals: [
        {
          lensId: "security",
          file: "src/x.ts",
          line: 42,
          category: "auth",
        },
      ],
    });
    const s = getReview(RID);
    expect(s).toBeDefined();
    if (!s) throw new Error();
    expect(s.sessionId).toBe(SID);
    expect(s.reviewRound).toBe(3);
    expect(s.priorDeferrals).toHaveLength(1);
    expect(s.priorDeferrals[0]?.lensId).toBe("security");
  });

  // T-022: the new fields (prompts, perLensExpiresAt) default to empty
  // maps when registerReview is called without them.
  it("defaults new T-022 maps to empty when not provided", () => {
    register();
    const s = getReview(RID);
    if (!s) throw new Error();
    expect(s.prompts.size).toBe(0);
    expect(s.perLensExpiresAt.size).toBe(0);
    expect(s.perLensAttempts.size).toBe(0);
    expect(s.perLensLatestOutput.size).toBe(0);
  });
});

describe("getReview", () => {
  it("returns undefined for an unregistered id", () => {
    expect(getReview("not-a-real-id")).toBeUndefined();
  });

  it("returns a session that reflects the fields passed to registerReview", () => {
    register({ stage: "CODE_REVIEW" });
    const s = getReview(RID);
    expect(s).toMatchObject({
      reviewId: RID,
      stage: "CODE_REVIEW",
      expectedLensIds: LENSES,
      status: "started",
    });
  });
});

describe("applyCompletion", () => {
  it("rejects an unknown reviewId without mutating state", () => {
    const v = applyCompletion({
      reviewId: "unknown-id",
      results: LENSES.map((l) => ok(l)),
      finalize: true,
    });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error();
    expect(v.code).toBe("unknown");
    expect(getReview("unknown-id")).toBeUndefined();
  });

  it("transitions started -> complete on finalize=true exact match", () => {
    register();
    const v = applyCompletion({
      reviewId: RID,
      results: LENSES.map((l) => ok(l)),
      finalize: true,
    });
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error();
    expect(v.session.status).toBe("complete");
    expect(getReview(RID)?.status).toBe("complete");
    expect(v.session.perLensAttempts.get("security")).toBe(1);
  });

  it("transitions started -> awaiting_retry on finalize=false", () => {
    register();
    const v = applyCompletion({
      reviewId: RID,
      results: LENSES.map((l) => ok(l)),
      finalize: false,
    });
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error();
    expect(v.session.status).toBe("awaiting_retry");
  });

  it("rejects a first submission missing a lens (missing_lenses)", () => {
    register();
    const v = applyCompletion({
      reviewId: RID,
      results: [ok("security"), ok("clean-code")],
      finalize: true,
    });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error();
    expect(v.code).toBe("missing_lenses");
    if (v.code !== "missing_lenses") throw new Error();
    expect(v.missing).toEqual(["performance"]);
    expect(getReview(RID)?.status).toBe("started");
  });

  it("rejects a double submission of the same attempt as stale_attempt", () => {
    register();
    const first = applyCompletion({
      reviewId: RID,
      results: LENSES.map((l) => ok(l)),
      finalize: false,
    });
    expect(first.ok).toBe(true);
    const dup = applyCompletion({
      reviewId: RID,
      results: [ok("security", 1)],
      finalize: false,
    });
    expect(dup.ok).toBe(false);
    if (dup.ok) throw new Error();
    expect(dup.code).toBe("stale_attempt");
    if (dup.code !== "stale_attempt") throw new Error();
    expect(dup.highestSeen).toBe(1);
    expect(dup.submittedAttempt).toBe(1);
  });

  it("accepts an attempt=2 retry for a lens with highest=1", () => {
    register();
    applyCompletion({
      reviewId: RID,
      results: LENSES.map((l) => ok(l)),
      finalize: false,
    });
    const retry = applyCompletion({
      reviewId: RID,
      results: [ok("security", 2)],
      finalize: true,
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error();
    expect(retry.session.status).toBe("complete");
    expect(retry.session.perLensAttempts.get("security")).toBe(2);
  });

  it("rejects a non-contiguous attempt (skip from 1 to 3)", () => {
    register();
    applyCompletion({
      reviewId: RID,
      results: LENSES.map((l) => ok(l)),
      finalize: false,
    });
    const skip = applyCompletion({
      reviewId: RID,
      results: [ok("security", 3)],
      finalize: true,
    });
    expect(skip.ok).toBe(false);
    if (skip.ok) throw new Error();
    expect(skip.code).toBe("non_contiguous_attempt");
    if (skip.code !== "non_contiguous_attempt") throw new Error();
    expect(skip.expected).toBe(2);
    expect(skip.submittedAttempt).toBe(3);
  });

  it("rejects a submission past expiresAt with review_expired", () => {
    const past = Date.now() - 1000;
    register({
      perLensExpiresAt: new Map<LensId, number>([["security", past]]),
    });
    const v = applyCompletion({
      reviewId: RID,
      results: LENSES.map((l) => ok(l)),
      finalize: true,
    });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error();
    expect(v.code).toBe("review_expired");
    if (v.code !== "review_expired") throw new Error();
    expect(v.lensId).toBe("security");
  });

  it("rejects a double-complete with already_complete", () => {
    register();
    const first = applyCompletion({
      reviewId: RID,
      results: LENSES.map((l) => ok(l)),
      finalize: true,
    });
    expect(first.ok).toBe(true);
    const second = applyCompletion({
      reviewId: RID,
      results: [ok("security", 2)],
      finalize: true,
    });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error();
    expect(second.code).toBe("already_complete");
  });

  it("preserves the immutable-record invariant across transitions", () => {
    register();
    const snapshot = getReview(RID);
    expect(snapshot?.status).toBe("started");
    applyCompletion({
      reviewId: RID,
      results: LENSES.map((l) => ok(l)),
      finalize: true,
    });
    expect(snapshot?.status).toBe("started");
    expect(getReview(RID)?.status).toBe("complete");
  });

  it("rejects the entire batch if any entry fails validation (no half-apply)", () => {
    register();
    applyCompletion({
      reviewId: RID,
      results: LENSES.map((l) => ok(l)),
      finalize: false,
    });
    // Mixed batch: security at stale attempt, clean-code at valid
    // attempt. The whole batch must be rejected.
    const mixed = applyCompletion({
      reviewId: RID,
      results: [ok("security", 1), ok("clean-code", 2)],
      finalize: true,
    });
    expect(mixed.ok).toBe(false);
    // clean-code should NOT have advanced.
    expect(getReview(RID)?.perLensAttempts.get("clean-code")).toBe(1);
  });
});

/**
 * T-015: cached lenses are treated as already-provided by the state
 * machine, so the agent's submission only needs to cover the spawned
 * (non-cached) subset of expectedLensIds. These three cases pin the
 * relaxed union semantics at the unit level (plan §8b') instead of
 * relying solely on the integration coverage in tools-complete.test.
 */
describe("applyCompletion with T-015 cachedResults", () => {
  it("providedLensIds partial but cachedLensIds covers the gap → ok", () => {
    register({
      cachedResults: new Map([
        [
          "performance",
          { findings: [], notes: null },
        ],
      ]),
    });
    const v = applyCompletion({
      reviewId: RID,
      results: [ok("security"), ok("clean-code")],
      finalize: true,
    });
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error();
    expect(v.session.status).toBe("complete");
  });

  it("neither provided nor cached covers an expected lens → missing_lenses", () => {
    register({
      cachedResults: new Map([
        [
          "performance",
          { findings: [], notes: null },
        ],
      ]),
    });
    const v = applyCompletion({
      reviewId: RID,
      results: [ok("security")],
      finalize: true,
    });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error();
    expect(v.code).toBe("missing_lenses");
    if (v.code !== "missing_lenses") throw new Error();
    expect(v.missing).toEqual(["clean-code"]);
    expect(getReview(RID)?.status).toBe("started");
  });

  it("overlap between provided and cached is accepted (fresh-wins is merger-layer)", () => {
    register({
      cachedResults: new Map([
        [
          "security",
          { findings: [], notes: null },
        ],
      ]),
    });
    const v = applyCompletion({
      reviewId: RID,
      results: LENSES.map((l) => ok(l)),
      finalize: true,
    });
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error();
    expect(v.session.status).toBe("complete");
  });
});
