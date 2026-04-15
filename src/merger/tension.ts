/**
 * T-012 cross-lens tension detection.
 *
 * Two different lenses flagging different categories at the same location
 * can indicate a real design trade-off (security vs performance, etc.).
 * This module detects those cases and emits a `Tension` describing both
 * sides without trying to resolve -- resolution lives in later tickets.
 *
 * Scope (T-012):
 *  - Detection only, driven by a server-authored `TENSION_PAIRS` table.
 *  - One tension per `(pair, file)` hit -- a file with five performance
 *    findings and three security findings produces ONE
 *    `security-vs-performance` tension, not fifteen.
 *  - Per-file granularity (line-granularity would explode the output and
 *    is not more actionable).
 *  - `file === null` (artifact-level) tensions are emitted as their own
 *    bucket, sorted AFTER concrete-file tensions.
 *  - Strict cross-attribution: both lenses must have at least one finding
 *    that the other did NOT attribute. This rules out pure agreement
 *    (`contributingLenses: [A, B]` at the same category).
 *
 * Detection runs on the post-blocking-policy `MergedFinding[]` -- i.e.
 * post-dedup and post-confidence-floor. A finding dropped by the policy
 * is treated as not weight-bearing for tensions either; see
 * "Post-policy silence" in the T-012 plan for the rationale.
 *
 * Pure function: no I/O, no module-level mutable state; input never
 * mutated.
 */

import type { LensId } from "../lenses/prompts/index.js";
import type { MergedFinding, Tension } from "../schema/index.js";

export interface TensionPair {
  readonly label: string;
  readonly lensA: LensId;
  readonly lensB: LensId;
  readonly sideA: string;
  readonly sideB: string;
}

/**
 * Ordered list of well-known conflicts. Order is load-bearing: the
 * emitted tensions array sorts by pair-table position first, then file.
 *
 * Four of the five pairs involve `performance` because that is the
 * dominant conflict axis in review: defense-in-depth vs hot-path, retry
 * vs fail-fast, safety vs throughput, WCAG vs bundle size. The fifth
 * (`error-handling` ↔ `clean-code`) covers the defensive-boilerplate vs
 * duplication tension that does not touch performance.
 *
 * Typed as `readonly TensionPair[]` where `lensA`/`lensB` are `LensId`,
 * so a lens rename or removal raises a TS error at compile time.
 */
export const TENSION_PAIRS: readonly TensionPair[] = [
  {
    label: "security-vs-performance",
    lensA: "security",
    lensB: "performance",
    sideA: "security raises defense-in-depth concerns",
    sideB: "performance flags hot-path overhead",
  },
  {
    label: "error-handling-vs-performance",
    lensA: "error-handling",
    lensB: "performance",
    sideA: "error-handling asks for retries or safety nets",
    sideB: "performance prefers fail-fast on the hot path",
  },
  {
    label: "concurrency-vs-performance",
    lensA: "concurrency",
    lensB: "performance",
    sideA: "concurrency wants stricter synchronization",
    sideB: "performance wants less locking on the hot path",
  },
  {
    label: "accessibility-vs-performance",
    lensA: "accessibility",
    lensB: "performance",
    sideA: "accessibility asks for richer semantics and affordances",
    sideB: "performance pushes back on bundle size or render cost",
  },
  {
    label: "error-handling-vs-clean-code",
    lensA: "error-handling",
    lensB: "clean-code",
    sideA: "error-handling wants explicit defensive branches",
    sideB: "clean-code flags the boilerplate or duplication",
  },
] as const;

/**
 * Group findings by file path, preserving `null` as a distinct key
 * (artifact-level findings never alias with any concrete file).
 */
function groupByFile(
  findings: readonly MergedFinding[],
): Map<string | null, MergedFinding[]> {
  const out = new Map<string | null, MergedFinding[]>();
  for (const f of findings) {
    const bucket = out.get(f.file);
    if (bucket === undefined) out.set(f.file, [f]);
    else bucket.push(f);
  }
  return out;
}

/**
 * Sort file keys lexicographically, with `null` LAST so artifact-level
 * tensions come after concrete-file tensions (concrete files are usually
 * the more actionable surface).
 */
function compareBucketKey(
  a: string | null,
  b: string | null,
): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

function formatSummary(pair: TensionPair, file: string | null): string {
  const location = file === null ? "artifact-level" : `in ${file}`;
  return `${pair.sideA}; ${pair.sideB} (${location})`;
}

/**
 * Emit a `Tension` for each `(pair, file)` where both lenses in the pair
 * have at least one finding that the other lens did NOT attribute at the
 * same file. Pure agreement does not produce a tension.
 *
 * Output order:
 *  1. Pair-table order (security-vs-performance first, etc.).
 *  2. File path lexicographic, with `null` LAST.
 *
 * `.includes` on `contributingLenses` is fine at this scale -- arrays
 * are ≤3 elements in practice (8 lenses max, typical findings have 1-2
 * contributors), and the merger is not a hot path.
 */
export function detectTensions(
  findings: readonly MergedFinding[],
): Tension[] {
  if (findings.length === 0) return [];
  const fileToFindings = groupByFile(findings);
  const sortedBuckets: Array<[string | null, MergedFinding[]]> = [
    ...fileToFindings.entries(),
  ].sort(([a], [b]) => compareBucketKey(a, b));

  const out: Tension[] = [];
  for (const pair of TENSION_PAIRS) {
    for (const [file, atFile] of sortedBuckets) {
      const aDissent = atFile.some(
        (f) =>
          f.contributingLenses.includes(pair.lensA) &&
          !f.contributingLenses.includes(pair.lensB),
      );
      if (!aDissent) continue;
      const bDissent = atFile.some(
        (f) =>
          f.contributingLenses.includes(pair.lensB) &&
          !f.contributingLenses.includes(pair.lensA),
      );
      if (!bDissent) continue;
      out.push({
        category: pair.label,
        lenses: [pair.lensA, pair.lensB],
        summary: formatSummary(pair, file),
      });
    }
  }
  return out;
}
