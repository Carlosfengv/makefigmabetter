import { describe, expect, it } from "vitest";
import type { WebGpuTextGlyph } from "./webgpu-scene";
import { textGlyphContainsPoint, textGlyphPaintRunAtPoint } from "./text-glyph-hit";

const glyph = (overrides: Partial<WebGpuTextGlyph> = {}): WebGpuTextGlyph => ({
  textureKey: "font:0:[]:400:normal:7:16",
  nodeId: "text",
  x: 10,
  y: 20,
  width: 8,
  height: 4,
  rotation: 0,
  paintRunIndex: 0,
  fill: "#000000",
  opacity: 1,
  maskWidth: 8,
  maskHeight: 4,
  alphaMask: new Uint8Array(32),
  ...overrides,
});

describe("shaped text glyph hit testing", () => {
  it("tests a rotated raster around its projected centre", () => {
    const rotated = glyph({ rotation: 90 });
    expect(textGlyphContainsPoint(rotated, { x: 14, y: 25 })).toBe(true);
    expect(textGlyphContainsPoint(rotated, { x: 18, y: 22 })).toBe(false);
  });

  it("inverts the complete affine used by a TextPath WebGPU quad", () => {
    const affine = glyph({ quadTransform: { a: 8, b: 2, c: -1, d: 4, e: 30, f: 40 } });
    expect(textGlyphContainsPoint(affine, { x: 33.5, y: 43 })).toBe(true);
    expect(textGlyphContainsPoint(affine, { x: 40, y: 50 })).toBe(false);
  });

  it("returns the last painted linked run and ignores unindexed glyphs", () => {
    expect(textGlyphPaintRunAtPoint([
      glyph({ paintRunIndex: 2 }),
      glyph({ paintRunIndex: undefined }),
      glyph({ paintRunIndex: 7 }),
    ], { x: 12, y: 21 })).toBe(7);
    expect(textGlyphPaintRunAtPoint([glyph()], { x: 40, y: 40 })).toBeUndefined();
  });
});
