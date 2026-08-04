import { describe, expect, it } from "vitest";
import { AssetProbeBudget } from "./asset-probe-budget";

describe("asset probe in-flight budget", () => {
  it("prevents concurrent probe reservations from exceeding the configured ceiling", () => {
    const budget = new AssetProbeBudget(128);
    expect(budget.reserve("raster", 80)).toBe(true);
    expect(budget.reserve("font", 48)).toBe(true);
    expect(budget.reserve("svg", 1)).toBe(false);
    expect(budget.summary()).toEqual({ inFlightBytes: 128, requestCount: 2, limitBytes: 128 });
    budget.release("raster");
    expect(budget.reserve("svg", 1)).toBe(true);
    expect(budget.summary()).toEqual({ inFlightBytes: 49, requestCount: 2, limitBytes: 128 });
  });

  it("does not admit duplicate, malformed, or impossible reservations", () => {
    const budget = new AssetProbeBudget(10);
    expect(budget.reserve("a", 4)).toBe(true);
    expect(budget.reserve("a", 1)).toBe(false);
    expect(budget.reserve("", 1)).toBe(false);
    expect(budget.reserve("negative", -1)).toBe(false);
    expect(budget.reserve("fraction", 1.5)).toBe(false);
    budget.release("missing");
    expect(budget.summary()).toEqual({ inFlightBytes: 4, requestCount: 1, limitBytes: 10 });
  });
});
