/**
 * T-011 post-dedup transform (extended in T-022 to surface dropped findings).
 *
 * Applies two merger-time policies to deduplicated findings:
 *
 *  1. Confidence floor. Findings with `confidence < floor` are dropped into
 *     `deferred[]` with reason `below_confidence_floor` UNLESS their category
 *     is in `alwaysBlock` (safety-critical categories bypass the floor and
 *     still surface in `kept`).
 *  2. Blocking policy.
 *     - `alwaysBlock`: category match forces `severity = "blocking"`.
 *     - `neverBlock`: a `blocking`-severity finding whose every
 *       `contributingLens` is in `neverBlock` is demoted to `major`.
 *       A single non-muted lens agreeing means the blocking signal stands.
 *
 * Precedence: `alwaysBlock > confidenceFloor > neverBlock`.
 *
 * Structural asymmetry worth flagging: `dedup.ts` never merges findings
 * with `file === null`, so those always carry a singleton
 * `contributingLenses`. A lens in `neverBlock` therefore trivially
 * satisfies the all-contributors check for its own null-file findings --
 * there is no other lens on the list that could "protect" them. This is
 * intentional: null-file findings are non-localized, and a neverBlock
 * lens's own non-localized concerns are exactly what the opt-out is
 * meant to silence.
 *
 * T-022: the function now returns `{kept, deferred}`. Callers that only
 * want the kept array can destructure. The deferred collection is what
 * surfaces to the caller via `ReviewVerdict.deferred[]`, closing leak #2
 * from the 2026-04-23 handover (silent confidence-floor drop).
 *
 * Pure function: no throws (the config is Zod-parsed upstream), no I/O,
 * no module-level state, and the input array / findings are never mutated.
 */

import type {
  DeferredFinding,
  MergedFinding,
  MergerConfig,
} from "../schema/index.js";

export interface BlockingPolicyResult {
  readonly kept: MergedFinding[];
  readonly deferred: DeferredFinding[];
}

export function applyBlockingPolicy(
  findings: readonly MergedFinding[],
  config: MergerConfig,
): BlockingPolicyResult {
  const alwaysBlockSet = new Set(config.blockingPolicy.alwaysBlock);
  const neverBlockSet = new Set(config.blockingPolicy.neverBlock);
  const floor = config.confidenceFloor;

  const kept: MergedFinding[] = [];
  const deferred: DeferredFinding[] = [];
  for (const f of findings) {
    const isAlwaysBlock = alwaysBlockSet.has(f.category);

    // alwaysBlock beats the confidence floor. Any other category below
    // the floor is deferred (recorded, not silently dropped — T-022).
    if (f.confidence < floor && !isAlwaysBlock) {
      deferred.push({ finding: f, reason: "below_confidence_floor" });
      continue;
    }

    let severity = f.severity;
    if (isAlwaysBlock) {
      severity = "blocking";
    } else if (
      severity === "blocking" &&
      f.contributingLenses.every((id) => neverBlockSet.has(id))
    ) {
      severity = "major";
    }

    // Preserve reference identity on no-op to avoid gratuitous garbage;
    // emit a fresh object only when severity actually changed. Never
    // mutate the input finding.
    if (severity === f.severity) {
      kept.push(f);
    } else {
      kept.push({ ...f, severity });
    }
  }
  return { kept, deferred };
}
