import { describe, expect, it } from "vitest";
import { imagePaintHasAlphaAtLocalPoint, type RasterAlpha } from "./image-alpha-hit";

const raster: RasterAlpha = {
  width: 2,
  height: 2,
  alpha: Uint8Array.of(0, 255, 255, 0),
};

const image = (scaleMode: "fill" | "fit" | "crop" | "tile") => ({
  assetId: "asset",
  scaleMode,
  transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
});

describe("image paint alpha hit", () => {
  it("samples transparent and opaque pixels through fill projection", () => {
    expect(imagePaintHasAlphaAtLocalPoint(image("fill"), 20, 20, raster, { x: 4, y: 4 })).toBe(false);
    expect(imagePaintHasAlphaAtLocalPoint(image("fill"), 20, 20, raster, { x: 14, y: 4 })).toBe(true);
  });

  it("leaves fit letterbox pixels transparent", () => {
    const wide = { width: 2, height: 1, alpha: Uint8Array.of(255, 255) };
    expect(imagePaintHasAlphaAtLocalPoint(image("fit"), 20, 20, wide, { x: 10, y: 2 })).toBe(false);
    expect(imagePaintHasAlphaAtLocalPoint(image("fit"), 20, 20, wide, { x: 10, y: 10 })).toBe(true);
  });

  it("applies paint transforms and repeating tile coordinates", () => {
    const translated = { ...image("fill"), transform: { a: 1, b: 0, c: 0, d: 1, e: 10, f: 0 } };
    expect(imagePaintHasAlphaAtLocalPoint(translated, 20, 20, raster, { x: 14, y: 4 })).toBe(false);
    expect(imagePaintHasAlphaAtLocalPoint(image("tile"), 20, 20, raster, { x: 3, y: 0 })).toBe(true);
  });

  it("uses the same centre rotation as Canvas and SVG", () => {
    const rotated = { ...image("fill"), rotationDegrees: 90 as const };
    expect(imagePaintHasAlphaAtLocalPoint(rotated, 20, 20, raster, { x: 16, y: 14 })).toBe(true);
    expect(imagePaintHasAlphaAtLocalPoint(rotated, 20, 20, raster, { x: 14, y: 4 })).toBe(false);
  });

  it("swaps the Fill/Fit layout box for a quarter-turn in a non-square node", () => {
    const wide = { width: 2, height: 1, alpha: Uint8Array.of(255, 0) };
    const fit = { ...image("fit"), rotationDegrees: 90 as const };
    expect(imagePaintHasAlphaAtLocalPoint(fit, 100, 50, wide, { x: 50, y: 10 })).toBe(true);
    expect(imagePaintHasAlphaAtLocalPoint(fit, 100, 50, wide, { x: 20, y: 25 })).toBe(false);
  });
});
