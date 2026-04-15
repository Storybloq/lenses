/**
 * T-013 verdict computation.
 *
 * Pure function from a post-policy `MergedFinding[]` to a
 * `VerdictComputation`:
 *
 *  - `verdict`: `blocking > 0 → "reject"`, `major > 0 → "revise"`,
 *    otherwise `"approve"`. Unchanged from the T-009 baseline.
 *  - `counts`: one entry per `Severity`, always all four keys present
 *    and zero-filled.
 *  - `recommendNextRound`: `true` iff `blocking > 0 || major > 0`.
 *    Equivalent to `verdict !== "approve"`; exposed as its own field so
 *    a later ticket (T-014+) can swap in round-over-round logic without
 *    callers having to recompute.
 *
 * `computeVerdict` takes ONLY the findings array: by the time findings
 * reach here, every severity and category already reflects the final
 * post-policy state (dedup → blocking policy → tensions). Feeding
 * `MergerConfig` back in would put blocking rules in two places.
 *
 * Pure: no I/O, no module-level state, input never mutated. Output
 * depends solely on the multiset of `f.severity` values; order does
 * not matter. `counts` is a freshly-allocated object on every call so
 * a caller mutating it cannot corrupt the next call.
 */

import type { MergedFinding, Severity, Verdict } from "../schema/index.js";

export interface VerdictComputation {
  readonly verdict: Verdict;
  readonly counts: Readonly<Record<Severity, number>>;
  readonly recommendNextRound: boolean;
}

export function computeVerdict(
  findings: readonly MergedFinding[],
): VerdictComputation {
  const counts: Record<Severity, number> = {
    blocking: 0,
    major: 0,
    minor: 0,
    suggestion: 0,
  };
  for (const f of findings) {
    counts[f.severity] += 1;
  }

  const verdict: Verdict =
    counts.blocking > 0
      ? "reject"
      : counts.major > 0
        ? "revise"
        : "approve";

  const recommendNextRound = counts.blocking > 0 || counts.major > 0;

  return { verdict, counts, recommendNextRound };
}
