import { describe, expect, it } from "vitest";

import { applyBlockingPolicy } from "../src/merger/blocking-policy.js";
import {
  DEFAULT_MERGER_CONFIG,
  MergerConfigSchema,
  type MergedFinding,
  type MergerConfig,
  type Severity,
} from "../src/schema/index.js";

function mf(
  severity: Severity,
  overrides: Partial<MergedFinding> = {},
): MergedFinding {
  return {
    id: overrides.id ?? `f-${severity}`,
    severity,
    category: overrides.category ?? "generic",
    file: overrides.file ?? "src/x.ts",
    line: overrides.line ?? 1,
    description: overrides.description ?? "",
    suggestion: overrides.suggestion ?? "",
    confidence: overrides.confidence ?? 0.8,
    contributingLenses: overrides.contributingLenses ?? ["clean-code"],
  };
}

function withPolicy(
  overrides: Partial<{
    confidenceFloor: number;
    alwaysBlock: string[];
    neverBlock: string[];
  }>,
): MergerConfig {
  return MergerConfigSchema.parse({
    confidenceFloor: overrides.confidenceFloor,
    blockingPolicy: {
      alwaysBlock: overrides.alwaysBlock,
      neverBlock: overrides.neverBlock,
    },
  });
}

describe("applyBlockingPolicy", () => {
  it("empty findings array returns empty kept and empty deferred", () => {
    const out = applyBlockingPolicy([], DEFAULT_MERGER_CONFIG);
    expect(out.kept).toEqual([]);
    expect(out.deferred).toEqual([]);
    const out2 = applyBlockingPolicy(
      [],
      withPolicy({
        confidenceFloor: 0.9,
        alwaysBlock: ["x"],
        neverBlock: ["y"],
      }),
    );
    expect(out2.kept).toEqual([]);
    expect(out2.deferred).toEqual([]);
  });

  it("default config keeps findings >= 0.6 confidence and defers < 0.6 (T-022)", () => {
    const keep = mf("minor", { id: "k", category: "style", confidence: 0.6 });
    const dropped = mf("minor", {
      id: "d",
      category: "style",
      confidence: 0.59,
    });
    const { kept, deferred } = applyBlockingPolicy(
      [keep, dropped],
      DEFAULT_MERGER_CONFIG,
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]!.id).toBe("k");
    // T-022: the dropped finding now surfaces via deferred[] instead of
    // vanishing silently.
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.finding.id).toBe("d");
    expect(deferred[0]!.reason).toBe("below_confidence_floor");
  });

  it("confidence floor is strict-less-than (exactly 0.6 passes at default)", () => {
    const f = mf("minor", { confidence: 0.6, category: "style" });
    const { kept, deferred } = applyBlockingPolicy([f], DEFAULT_MERGER_CONFIG);
    expect(kept).toEqual([f]);
    expect(deferred).toEqual([]);
  });

  it("alwaysBlock category bypasses the confidence floor and is promoted to blocking", () => {
    const f = mf("suggestion", {
      category: "auth-bypass",
      confidence: 0.1,
      contributingLenses: ["security"],
    });
    const { kept, deferred } = applyBlockingPolicy([f], DEFAULT_MERGER_CONFIG);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.severity).toBe("blocking");
    expect(kept[0]!.confidence).toBe(0.1);
    expect(deferred).toEqual([]);
  });

  it("alwaysBlock promotes a minor category-matched finding to blocking", () => {
    const f = mf("minor", { category: "injection", confidence: 0.9 });
    const { kept } = applyBlockingPolicy([f], DEFAULT_MERGER_CONFIG);
    expect(kept[0]!.severity).toBe("blocking");
  });

  it("neverBlock demotes blocking -> major when ALL contributingLenses are in neverBlock", () => {
    const f = mf("blocking", {
      category: "style",
      confidence: 0.9,
      contributingLenses: ["clean-code", "performance"],
    });
    const { kept } = applyBlockingPolicy(
      [f],
      withPolicy({ neverBlock: ["clean-code", "performance"] }),
    );
    expect(kept[0]!.severity).toBe("major");
  });

  it("neverBlock does NOT demote when at least one contributingLens is outside neverBlock", () => {
    const f = mf("blocking", {
      category: "style",
      confidence: 0.9,
      contributingLenses: ["clean-code", "security"],
    });
    const { kept } = applyBlockingPolicy(
      [f],
      withPolicy({ neverBlock: ["clean-code"] }),
    );
    expect(kept[0]!.severity).toBe("blocking");
  });

  it("alwaysBlock beats neverBlock when category matches", () => {
    const f = mf("minor", {
      category: "injection",
      confidence: 0.9,
      contributingLenses: ["clean-code"],
    });
    const { kept } = applyBlockingPolicy(
      [f],
      withPolicy({
        alwaysBlock: ["injection"],
        neverBlock: ["clean-code"],
      }),
    );
    expect(kept[0]!.severity).toBe("blocking");
  });

  it("neverBlock leaves non-blocking severities alone (major from neverBlock stays major)", () => {
    const f = mf("major", {
      category: "style",
      confidence: 0.9,
      contributingLenses: ["clean-code"],
    });
    const { kept } = applyBlockingPolicy(
      [f],
      withPolicy({ neverBlock: ["clean-code"] }),
    );
    expect(kept[0]!.severity).toBe("major");
  });

  it("preserves reference identity when severity is unchanged", () => {
    const f = mf("minor", { category: "style", confidence: 0.9 });
    const { kept } = applyBlockingPolicy([f], DEFAULT_MERGER_CONFIG);
    expect(kept[0]).toBe(f);
  });

  it("already-blocking alwaysBlock finding below the floor is kept AND returns the same reference (no-op severity path)", () => {
    const f = mf("blocking", {
      category: "injection",
      confidence: 0.1,
      contributingLenses: ["security"],
    });
    const { kept, deferred } = applyBlockingPolicy([f], DEFAULT_MERGER_CONFIG);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toBe(f);
    expect(kept[0]!.severity).toBe("blocking");
    expect(deferred).toEqual([]);
  });

  it("produces a fresh object when severity changes (does not mutate input)", () => {
    const f = mf("minor", { category: "injection", confidence: 0.9 });
    const inputSeverity = f.severity;
    const { kept } = applyBlockingPolicy([f], DEFAULT_MERGER_CONFIG);
    expect(kept[0]).not.toBe(f);
    expect(kept[0]!.severity).toBe("blocking");
    expect(f.severity).toBe(inputSeverity);
  });

  it("empty alwaysBlock: confidence floor applies to everything, no promotion", () => {
    const keep = mf("minor", { category: "injection", confidence: 0.9 });
    const drop = mf("minor", { category: "injection", confidence: 0.1 });
    const { kept, deferred } = applyBlockingPolicy(
      [keep, drop],
      withPolicy({ alwaysBlock: [] }),
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]!.id).toBe(keep.id);
    expect(kept[0]!.severity).toBe("minor");
    // T-022: dropped finding surfaces via deferred[] instead of silent continue.
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.finding.id).toBe(drop.id);
    expect(deferred[0]!.reason).toBe("below_confidence_floor");
  });

  it("custom confidenceFloor=0.9 defers findings at 0.85", () => {
    const f = mf("major", { category: "style", confidence: 0.85 });
    const { kept, deferred } = applyBlockingPolicy(
      [f],
      withPolicy({ confidenceFloor: 0.9 }),
    );
    expect(kept).toHaveLength(0);
    // T-022: deferred carries the rejected finding with reason.
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.finding).toBe(f);
    expect(deferred[0]!.reason).toBe("below_confidence_floor");
  });

  it("contributingLenses content is preserved unchanged by the policy", () => {
    const f = mf("blocking", {
      category: "style",
      confidence: 0.9,
      contributingLenses: ["security", "performance"],
    });
    const { kept } = applyBlockingPolicy(
      [f],
      withPolicy({ neverBlock: ["security", "performance"] }),
    );
    expect(kept[0]!.contributingLenses).toBe(f.contributingLenses);
  });

  it("does not mutate the input array or finding objects", () => {
    const a = mf("minor", { id: "a", category: "injection", confidence: 0.9 });
    const b = mf("major", { id: "b", category: "style", confidence: 0.3 });
    const input: readonly MergedFinding[] = [a, b];
    const snapshot = { aSev: a.severity, bSev: b.severity };
    const { kept, deferred } = applyBlockingPolicy(input, DEFAULT_MERGER_CONFIG);
    expect(input).toHaveLength(2);
    expect(a.severity).toBe(snapshot.aSev);
    expect(b.severity).toBe(snapshot.bSev);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.id).toBe("a");
    expect(kept[0]!.severity).toBe("blocking");
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.finding.id).toBe("b");
  });
});
