/**
 * T-009 merger pipeline baseline, extended in T-022.
 *
 * Pure transformation from per-lens outputs to a single `ReviewVerdict`.
 * No module-level state; no I/O. Callers hand in both the parsed per-lens
 * outputs AND the parseErrors / nextActions they collected at the per-lens
 * parse boundary in `complete.ts` (we can't re-run the safeParse here, so
 * the contract is "caller classifies what went wrong; merger shapes the
 * verdict").
 *
 * The shape is deliberate: `MergerInput` keeps `perLens` grouped so
 * T-010 (cross-lens dedup), T-011 (blocking policy + confidence filter),
 * T-012 (tension detection), and T-013 (verdict tightening) can drop in
 * as peer modules. The `ReviewVerdict` return stays flat because that is
 * the contract with the agent; internal grouping is the merger's business.
 */

import type { LensId } from "../lenses/prompts/index.js";
import {
  DEFAULT_MERGER_CONFIG,
  type LensOutput,
  type MergerConfig,
  type NextAction,
  type ParseError,
  type ReviewVerdict,
} from "../schema/index.js";

import { applyBlockingPolicy } from "./blocking-policy.js";
import { dedupeFindings } from "./dedup.js";
import { detectTensions } from "./tension.js";
import { computeVerdict } from "./verdict.js";

export interface LensRunResult {
  readonly lensId: LensId;
  readonly output: LensOutput;
}

export interface MergerInput {
  readonly reviewId: string;
  /**
   * Cross-round series id (T-014). Distinct from `reviewId`: reviewId
   * is per-round, sessionId groups rounds of the same review.
   */
  readonly sessionId: string;
  readonly perLens: readonly LensRunResult[];
  /** Optional merger-time config (T-011). Absent → `DEFAULT_MERGER_CONFIG`. */
  readonly mergerConfig?: MergerConfig;
  /**
   * T-022: parse errors classified by `complete.ts` at the per-lens
   * parse boundary (envelope / finding / internal). Empty when nothing
   * failed validation. The merger surfaces these verbatim in the
   * verdict `parseErrors[]` field rather than constructing a
   * `syntheticError` shape that would later vanish via the dedup
   * `status !== "ok"` filter.
   */
  readonly parseErrors?: readonly ParseError[];
  /**
   * T-022: cooperative-retry instructions emitted by `complete.ts`
   * when a lens returned `status: "error"` with attempt budget
   * remaining, or a finding-shape parse failure is retryable. Empty
   * when nothing is retryable.
   */
  readonly nextActions?: readonly NextAction[];
}

/**
 * T-022: merger emits a richer verdict. Computes `hadAnyFindings` over
 * the RAW per-lens outputs (before dedup / confidence filter / deferral)
 * so the L-003 disambiguation is accurate — "did any lens produce a
 * finding at parse time, regardless of what survived later filtering".
 *
 * Verdict tightening:
 *  - If `nextActions[]` is non-empty AND `computeVerdict` would return
 *    `approve`, downgrade to `revise`. The caller always sees a
 *    "retries pending → try again" signal rather than a false-approve.
 *  - Blocking findings still force `reject` — matches
 *    `ReviewVerdictSchema.superRefine`.
 *
 * `recommendNextRound` from `computeVerdict` is intentionally dropped
 * here: the wire schema does not carry it, and the boolean is derivable
 * from `blocking`/`major` on the receiver side if ever needed.
 */
export function runMergerPipeline(input: MergerInput): ReviewVerdict {
  const config = input.mergerConfig ?? DEFAULT_MERGER_CONFIG;
  const parseErrors: readonly ParseError[] = input.parseErrors ?? [];
  const nextActions: readonly NextAction[] = input.nextActions ?? [];

  let rawFindingCount = 0;
  for (const { output } of input.perLens) {
    if (output.status === "ok") rawFindingCount += output.findings.length;
  }
  const hadAnyFindings = rawFindingCount > 0;

  const deduped = dedupeFindings(input.perLens);
  const { kept, deferred } = applyBlockingPolicy(deduped, config);
  const tensions = detectTensions(kept);
  const { verdict: baseVerdict, counts } = computeVerdict(kept);

  // Downgrade verdict when retries are pending so the caller never
  // observes `approve` with non-empty `nextActions` (ReviewVerdictSchema
  // superRefine enforces this too; belt-and-suspenders here).
  const verdict =
    nextActions.length > 0 && baseVerdict === "approve" ? "revise" : baseVerdict;

  return {
    verdict,
    findings: kept,
    tensions,
    blocking: counts.blocking,
    major: counts.major,
    minor: counts.minor,
    suggestion: counts.suggestion,
    sessionId: input.sessionId,
    parseErrors: [...parseErrors],
    deferred,
    suppressedFindingCount: deferred.length,
    hadAnyFindings,
    nextActions: [...nextActions],
  };
}
