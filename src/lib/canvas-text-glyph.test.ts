import { describe, expect, it } from "vitest";
import { canvasTextGlyphBitmap, canvasTextGlyphPose, canvasTextGlyphSurfaceByteLength, MAX_CANVAS_TEXT_GLYPH_SURFACE_BYTES } from "./canvas-text-glyph";

describe("Canvas text glyph projection", () => {
  it("colorizes a straight alpha mask without baking node opacity", () => {
    const bitmap = canvasTextGlyphBitmap({
      fill: "#369c",
      maskWidth: 3,
      maskHeight: 1,
      alphaMask: Uint8Array.of(0, 128, 255),
    });

    expect(bitmap).toEqual({
      width: 3,
      height: 1,
      rgba: Uint8ClampedArray.of(
        51, 102, 153, 0,
        51, 102, 153, 102,
        51, 102, 153, 204,
      ),
    });
  });

  it("rejects malformed masks and non-canonical colors", () => {
    expect(canvasTextGlyphBitmap({ fill: "rgb(1 2 3)", maskWidth: 1, maskHeight: 1, alphaMask: Uint8Array.of(255) })).toBeUndefined();
    expect(canvasTextGlyphBitmap({ fill: "#fff", maskWidth: 2, maskHeight: 1, alphaMask: Uint8Array.of(255) })).toBeUndefined();
  });

  it("accounts exact RGBA bytes and rejects one glyph above the cache ceiling", () => {
    expect(canvasTextGlyphSurfaceByteLength({ maskWidth: 512, maskHeight: 512 })).toBe(1_048_576);
    expect(canvasTextGlyphSurfaceByteLength({ maskWidth: MAX_CANVAS_TEXT_GLYPH_SURFACE_BYTES / 4 + 1, maskHeight: 1 })).toBeUndefined();
    expect(canvasTextGlyphSurfaceByteLength({ maskWidth: Number.MAX_SAFE_INTEGER, maskHeight: 2 })).toBeUndefined();
  });

  it("maps a node-local quad to the center used by Canvas", () => {
    expect(canvasTextGlyphPose({ x: 20, y: 30, width: 20, height: 30, rotation: -45, opacity: .6 })).toEqual({
      centerX: 30,
      centerY: 45,
      width: 20,
      height: 30,
      rotationRadians: -Math.PI / 4,
      opacity: .6,
    });
  });
});
