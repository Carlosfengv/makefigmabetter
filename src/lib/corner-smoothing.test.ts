import { describe, expect, it } from "vitest";
import { cornerSmoothingExponent, resolveCornerSmoothing } from "./corner-smoothing";

describe("corner smoothing", () => {
  it("retains circular corners at zero and clamps read-only legacy values", () => {
    expect(resolveCornerSmoothing(undefined)).toBe(0);
    expect(resolveCornerSmoothing(-1)).toBe(0);
    expect(resolveCornerSmoothing(2)).toBe(1);
    expect(resolveCornerSmoothing(.5)).toBe(.5);
    expect(cornerSmoothingExponent(0)).toBe(2);
    expect(cornerSmoothingExponent(1)).toBe(8);
  });
});
