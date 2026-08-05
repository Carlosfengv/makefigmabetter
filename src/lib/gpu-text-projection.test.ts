import { describe, expect, it } from "vitest";
import { projectGpuTextGlyphs } from "./gpu-text-projection";

describe("GPU text projection", () => {
  const raster = { width: 4, height: 5, bearingX: 1, bearingY: 4, ascent: 8, advanceX: 5, alphaMask: Uint8Array.from(Array(20).fill(255)) };

  it("uses shaped advances and font bearings to place line-local glyph quads", () => {
    const glyphs = projectGpuTextGlyphs({
      nodeId: "text", fontAssetId: "font", faceIndex: 0, fontSize: 20, pixelSize: 20,
      x: 10, y: 20, rotation: 0, fill: "#000000", opacity: 1, lineHeight: 25,
      layout: { unitsPerEm: 1000, lines: [
        { start: 0, end: 2, direction: "ltr", advance: 1000, glyphs: [
          { glyphId: 7, cluster: 0, xAdvance: 500, yAdvance: 0, xOffset: 0, yOffset: 0 },
          { glyphId: 7, cluster: 1, xAdvance: 500, yAdvance: 0, xOffset: 0, yOffset: 0 },
        ] },
        { start: 2, end: 3, direction: "ltr", advance: 500, glyphs: [{ glyphId: 7, cluster: 2, xAdvance: 500, yAdvance: 0, xOffset: 0, yOffset: 0 }] },
      ] },
      rasters: new Map([[7, raster]]),
    });
    expect(glyphs?.map((glyph) => [glyph.x, glyph.y])).toEqual([[11, 24], [21, 24], [11, 49]]);
  });

  it("keeps Canvas as the fallback when any shaped glyph cannot be rasterized", () => {
    const base = { nodeId: "text", fontAssetId: "font", faceIndex: 0, fontSize: 20, pixelSize: 20, x: 0, y: 0, rotation: 0, fill: "#000000", opacity: 1, lineHeight: 25, layout: { unitsPerEm: 1000, lines: [{ start: 0, end: 1, direction: "ltr" as const, advance: 1, glyphs: [{ glyphId: 0, cluster: 0, xAdvance: 1, yAdvance: 0, xOffset: 0, yOffset: 0 }] }] } };
    expect(projectGpuTextGlyphs({ ...base, rasters: new Map() })).toBeUndefined();
  });
});
