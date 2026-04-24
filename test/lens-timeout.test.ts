import { describe, expect, it } from "vitest";

import {
  DEFAULT_LENS_TIMEOUT_MS,
  LensConfigSchema,
  LensTimeoutSchema,
  resolveLensTimeoutMs,
} from "../src/lenses/registry.js";

describe("LensTimeoutSchema", () => {
  it("accepts a positive integer scalar", () => {
    expect(LensTimeoutSchema.parse(30_000)).toBe(30_000);
  });

  it("accepts the { default, opus } object form", () => {
    expect(
      LensTimeoutSchema.parse({ default: 60_000, opus: 120_000 }),
    ).toEqual({ default: 60_000, opus: 120_000 });
  });

  it("rejects zero", () => {
    expect(() => LensTimeoutSchema.parse(0)).toThrow();
  });

  it("rejects a negative scalar", () => {
    expect(() => LensTimeoutSchema.parse(-1000)).toThrow();
  });

  it("rejects a non-integer scalar", () => {
    expect(() => LensTimeoutSchema.parse(1.5)).toThrow();
  });

  it("rejects an empty object", () => {
    expect(() => LensTimeoutSchema.parse({})).toThrow();
  });

  it("rejects extra keys in the object form (strict)", () => {
    expect(() =>
      LensTimeoutSchema.parse({
        default: 60_000,
        opus: 120_000,
        haiku: 30_000,
      }),
    ).toThrow();
  });
});

describe("LensConfigSchema.lensTimeout", () => {
  it("is optional", () => {
    expect(LensConfigSchema.parse({})).toEqual({});
  });

  it("accepts a scalar", () => {
    expect(LensConfigSchema.parse({ lensTimeout: 45_000 })).toEqual({
      lensTimeout: 45_000,
    });
  });

  it("accepts the object form", () => {
    expect(
      LensConfigSchema.parse({
        lensTimeout: { default: 60_000, opus: 180_000 },
      }),
    ).toEqual({ lensTimeout: { default: 60_000, opus: 180_000 } });
  });

  it("rejects zero via the LensConfig boundary", () => {
    expect(() =>
      LensConfigSchema.parse({ lensTimeout: 0 }),
    ).toThrow();
  });
});

describe("resolveLensTimeoutMs", () => {
  it("returns the default (60s) for sonnet when config is absent", () => {
    expect(resolveLensTimeoutMs("sonnet", undefined)).toBe(
      DEFAULT_LENS_TIMEOUT_MS.default,
    );
    expect(resolveLensTimeoutMs("sonnet", undefined)).toBe(60_000);
  });

  it("returns the opus default (120s) for opus when config is absent", () => {
    expect(resolveLensTimeoutMs("opus", undefined)).toBe(
      DEFAULT_LENS_TIMEOUT_MS.opus,
    );
    expect(resolveLensTimeoutMs("opus", undefined)).toBe(120_000);
  });

  it("returns the model defaults when lensTimeout is unset", () => {
    expect(resolveLensTimeoutMs("sonnet", {})).toBe(60_000);
    expect(resolveLensTimeoutMs("opus", {})).toBe(120_000);
  });

  it("applies a scalar override to every model", () => {
    const config = { lensTimeout: 45_000 };
    expect(resolveLensTimeoutMs("sonnet", config)).toBe(45_000);
    expect(resolveLensTimeoutMs("opus", config)).toBe(45_000);
  });

  it("applies the object-form override per model", () => {
    const config = {
      lensTimeout: { default: 60_000, opus: 180_000 },
    };
    expect(resolveLensTimeoutMs("sonnet", config)).toBe(60_000);
    expect(resolveLensTimeoutMs("opus", config)).toBe(180_000);
  });
});
