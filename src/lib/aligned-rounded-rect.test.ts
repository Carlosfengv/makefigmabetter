import { describe, expect, it } from "vitest";
import { resolveCornerRadii } from "./corner-radii";
import { insetRoundedRectRadii, outsetRoundedRectRadii } from "./aligned-rounded-rect";

describe("aligned rounded-rect stroke radii", () => {
  it("returns undefined without an explicit per-corner array so callers use the scalar radius", () => {
    expect(insetRoundedRectRadii(100, 60, 12, undefined, 4)).toBeUndefined();
    expect(outsetRoundedRectRadii(100, 60, 12, undefined, 4)).toBeUndefined();
  });

  it("insets each corner independently then re-resolves against the shrunken box", () => {
    // Corners resolve unchanged on this box, so each simply loses the inset.
    expect(insetRoundedRectRadii(100, 60, 0, [20, 10, 8, 4], 4)).toEqual([16, 6, 4, 0]);
  });

  it("never drives a corner negative when the inset exceeds its radius", () => {
    const result = insetRoundedRectRadii(100, 60, 0, [3, 10, 8, 4], 6)!;
    expect(result[0]).toBe(0);
    expect(result.every((value) => value >= 0)).toBe(true);
  });

  it("outsets each corner and keeps neighbouring corners non-overlapping on the grown box", () => {
    expect(outsetRoundedRectRadii(100, 60, 0, [20, 10, 8, 4], 4)).toEqual([24, 14, 12, 8]);
  });

  it("re-resolves so an outset that would overlap is scaled to fit the grown box", () => {
    const width = 20;
    const height = 20;
    const outset = 4;
    const result = outsetRoundedRectRadii(width, height, 0, [30, 30, 30, 30], outset)!;
    // Two equal top corners cannot exceed the grown width between them.
    const grownWidth = width + outset * 2;
    expect(result[0] + result[1]).toBeLessThanOrEqual(grownWidth + 1e-9);
    // The shared resolver is the authority for that clamp.
    expect(result).toEqual(resolveCornerRadii(grownWidth, height + outset * 2, outset, [34, 34, 34, 34]));
  });
});
