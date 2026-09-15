import { describe, expect, it } from "vitest";
import { applyImageFiltersToRgba, imageFiltersAreNeutral, imageFiltersKey } from "./image-filters";

describe("image filters", () => {
  it("keeps alpha byte-exact and applies all seven adjustments deterministically", () => {
    const pixels = new Uint8ClampedArray([32, 96, 224, 17, 240, 120, 24, 203]);
    expect(Array.from(applyImageFiltersToRgba(pixels, {
      exposure: .25, contrast: -.2, saturation: .4, temperature: .3,
      tint: -.15, highlights: .5, shadows: -.35,
    }))).toEqual([39, 122, 255, 17, 255, 146, 0, 203]);
  });

  it("treats absent, empty, and explicit zero filters as visually neutral while retaining stable keys", () => {
    expect(imageFiltersAreNeutral(undefined)).toBe(true);
    expect(imageFiltersAreNeutral({})).toBe(true);
    expect(imageFiltersAreNeutral({ exposure: 0, shadows: 0 })).toBe(true);
    expect(imageFiltersAreNeutral({ tint: .1 })).toBe(false);
    expect(imageFiltersKey({ tint: .1 })).toBe(imageFiltersKey({ exposure: 0, tint: .1 }));
  });
});
