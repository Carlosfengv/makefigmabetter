import { describe, expect, it } from "vitest";
import { cssLineBoxBaseline, leadingTrimLineBox } from "./text-baseline";

describe("cssLineBoxBaseline", () => {
  it("centers the font bounding box within the declared CSS line box", () => {
    expect(cssLineBoxBaseline(10, 30, { fontBoundingBoxAscent: 12, fontBoundingBoxDescent: 8 }, 16)).toBe(27);
  });

  it("uses stable font-size proportions when a browser omits bounding metrics", () => {
    expect(cssLineBoxBaseline(0, 20, { fontBoundingBoxAscent: 0, fontBoundingBoxDescent: 0 }, 10)).toBe(13);
  });
});

describe("leadingTrimLineBox", () => {
  it("preserves the CSS line box for NONE", () => {
    expect(leadingTrimLineBox(10, 30, { fontBoundingBoxAscent: 12, fontBoundingBoxDescent: 8 }, { actualBoundingBoxAscent: 10 }, 16, undefined))
      .toEqual({ baseline: 27, trimStart: 0, trimEnd: 0 });
  });

  it("aligns CAP_HEIGHT to the upper edge and removes outer bottom leading", () => {
    expect(leadingTrimLineBox(10, 30, { fontBoundingBoxAscent: 12, fontBoundingBoxDescent: 8 }, { actualBoundingBoxAscent: 10 }, 16, "capHeight"))
      .toEqual({ baseline: 20, trimStart: 7, trimEnd: 13 });
  });

  it("uses a stable cap-height fallback when actual metrics are unavailable", () => {
    expect(leadingTrimLineBox(0, 20, { fontBoundingBoxAscent: 0, fontBoundingBoxDescent: 0 }, { actualBoundingBoxAscent: 0 }, 10, "capHeight").baseline)
      .toBe(7);
  });
});
