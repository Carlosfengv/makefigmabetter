import { describe, expect, it } from "vitest";
import { parseRustGlyphRaster } from "./rust-glyph-raster";

describe("Rust glyph raster boundary", () => {
  it("accepts only bounded, exact alpha-mask payloads", () => {
    expect(parseRustGlyphRaster(JSON.stringify({ width: 2, height: 2, bearingX: 0, bearingY: 2, ascent: 3, advanceX: 2, pixels: [0, 255, 255, 0] }))).toEqual({
      width: 2, height: 2, bearingX: 0, bearingY: 2, ascent: 3, advanceX: 2, alphaMask: Uint8Array.from([0, 255, 255, 0]),
    });
    expect(parseRustGlyphRaster(JSON.stringify({ width: 2, height: 2, bearingX: 0, bearingY: 2, ascent: 3, descent: 1, capHeight: 2, advanceX: 2, pixels: [0, 255, 255, 0] }))).toMatchObject({
      ascent: 3, descent: 1, capHeight: 2,
    });
    expect(parseRustGlyphRaster(JSON.stringify({ width: 2, height: 2, bearingX: 0, bearingY: 2, ascent: 3, descent: 1, advanceX: 2, pixels: [0, 255, 255, 0] }))).toBeUndefined();
    expect(parseRustGlyphRaster(JSON.stringify({ width: 2, height: 2, bearingX: 0, bearingY: 2, ascent: 3, advanceX: 2, pixels: [0] }))).toBeUndefined();
    expect(parseRustGlyphRaster(JSON.stringify({ width: 513, height: 1, bearingX: 0, bearingY: 0, ascent: 0, advanceX: 0, pixels: [] }))).toBeUndefined();
  });
});
