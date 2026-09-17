import { describe, expect, it } from "vitest";
import { projectGpuTextGlyphs, type GpuTextProjectionRun } from "./gpu-text-projection";

describe("GPU text projection", () => {
  const raster = { width: 4, height: 5, bearingX: 1, bearingY: 4, ascent: 8, advanceX: 5, alphaMask: Uint8Array.from(Array(20).fill(255)) };
  const run = (overrides: Partial<GpuTextProjectionRun> = {}): GpuTextProjectionRun => ({
    fontAssetId: "font", faceIndex: 0, variationAxesKey: "[]", syntheticStyleKey: "400:normal", fontSize: 20, pixelSize: 20,
    rasters: new Map([[7, raster]]),
    ...overrides,
  });

  it("uses shaped advances and font bearings to place line-local glyph quads", () => {
    const glyphs = projectGpuTextGlyphs({
      nodeId: "text", runs: [run()],
      x: 10, y: 20, width: 100, rotation: 0, fill: "#000000", opacity: 1, lineHeight: 25,
      layout: { unitsPerEm: 1000, lines: [
        { start: 0, end: 2, direction: "ltr", advance: 1000, visualRuns: [], glyphs: [
          { glyphId: 7, runIndex: 0, cluster: 0, xAdvance: 500, yAdvance: 0, xOffset: 0, yOffset: 0 },
          { glyphId: 7, runIndex: 0, cluster: 1, xAdvance: 500, yAdvance: 0, xOffset: 0, yOffset: 0 },
        ] },
        { start: 2, end: 3, direction: "ltr", advance: 500, visualRuns: [], glyphs: [{ glyphId: 7, runIndex: 0, cluster: 2, xAdvance: 500, yAdvance: 0, xOffset: 0, yOffset: 0 }] },
      ] },
    });
    expect(glyphs?.map((glyph) => [glyph.x, glyph.y])).toEqual([[11, 24], [21, 24], [11, 49]]);
    expect(glyphs?.[0]?.textureKey).toBe("font:0:[]:400:normal:7:20");
  });

  it("preserves tracking already baked into Rust glyph advances", () => {
    const glyphs = projectGpuTextGlyphs({
      nodeId: "tracked", runs: [run()],
      x: 0, y: 0, width: 100, rotation: 0, fill: "#000000", opacity: 1, lineHeight: 25,
      layout: { unitsPerEm: 1000, lines: [{ start: 0, end: 2, direction: "ltr", advance: 1200, visualRuns: [], glyphs: [
        { glyphId: 7, runIndex: 0, cluster: 0, xAdvance: 700, yAdvance: 0, xOffset: 0, yOffset: 0 },
        { glyphId: 7, runIndex: 0, cluster: 1, xAdvance: 500, yAdvance: 0, xOffset: 0, yOffset: 0 },
      ] }] },
    });

    expect(glyphs?.map((glyph) => glyph.x)).toEqual([1, 15]);
  });

  it("selects each glyph's font resource and preserves a primary-run baseline", () => {
    const largeRaster = { ...raster, width: 8, height: 10, bearingX: 2, bearingY: 8, ascent: 16, alphaMask: Uint8Array.from(Array(80).fill(255)) };
    const glyphs = projectGpuTextGlyphs({
      nodeId: "mixed",
      runs: [
        run({ fontAssetId: "font-a", fontSize: 16, pixelSize: 16 }),
        run({ fontAssetId: "font-b", faceIndex: 2, fontSize: 24, pixelSize: 32, rasters: new Map([[7, largeRaster]]) }),
      ],
      x: 0, y: 0, width: 100, rotation: 0, fill: "#123456", opacity: .75, lineHeight: 30,
      layout: { unitsPerEm: 1000, lines: [{ start: 0, end: 2, direction: "ltr", advance: 1000, visualRuns: [], glyphs: [
        { glyphId: 7, runIndex: 0, cluster: 0, xAdvance: 500, yAdvance: 0, xOffset: 0, yOffset: 0 },
        { glyphId: 7, runIndex: 1, cluster: 1, xAdvance: 500, yAdvance: 0, xOffset: 0, yOffset: 0 },
      ] }] },
    });

    expect(glyphs?.map(({ textureKey, x, y, width, height, maskWidth, maskHeight }) =>
      ({ textureKey, x, y, width, height, maskWidth, maskHeight }))).toEqual([
      { textureKey: "font-a:0:[]:400:normal:7:16", x: 1, y: 4, width: 4, height: 5, maskWidth: 4, maskHeight: 5 },
      { textureKey: "font-b:2:[]:400:normal:7:32", x: 9.5, y: 2, width: 6, height: 7.5, maskWidth: 8, maskHeight: 10 },
    ]);
    expect(glyphs?.map((glyph) => glyph.paintRunIndex)).toEqual([0, 1]);
  });

  it("right-anchors a physical left-to-right RTL glyph stream inside the text box", () => {
    const glyphs = projectGpuTextGlyphs({
      nodeId: "rtl", runs: [run()],
      x: 10, y: 20, width: 100, rotation: 0, fill: "#000000", opacity: 1, lineHeight: 25,
      layout: { unitsPerEm: 1000, lines: [{ start: 0, end: 4, direction: "rtl", advance: 1000, visualRuns: [], glyphs: [
        { glyphId: 7, runIndex: 0, cluster: 2, xAdvance: 500, yAdvance: 0, xOffset: 0, yOffset: 0 },
        { glyphId: 7, runIndex: 0, cluster: 0, xAdvance: 500, yAdvance: 0, xOffset: 0, yOffset: 0 },
      ] }] },
    });

    expect(glyphs?.map((glyph) => glyph.x)).toEqual([91, 101]);
  });

  it("preserves Canvas overflow semantics when an RTL line is wider than its text box", () => {
    const glyphs = projectGpuTextGlyphs({
      nodeId: "rtl-overflow", runs: [run()],
      x: 0, y: 0, width: 10, rotation: 0, fill: "#000000", opacity: 1, lineHeight: 25,
      layout: { unitsPerEm: 1000, lines: [{ start: 0, end: 2, direction: "rtl", advance: 1000, visualRuns: [], glyphs: [
        { glyphId: 7, runIndex: 0, cluster: 0, xAdvance: 1000, yAdvance: 0, xOffset: 0, yOffset: 0 },
      ] }] },
    });

    expect(glyphs?.[0]?.x).toBe(-9);
  });

  it("keeps Variable Font instances in separate atlas identities", () => {
    const common = {
      nodeId: "text", x: 0, y: 0, width: 100, rotation: 0, fill: "#000000", opacity: 1, lineHeight: 25,
      layout: { unitsPerEm: 1000, lines: [{ start: 0, end: 1, direction: "ltr" as const, advance: 500, visualRuns: [], glyphs: [{ glyphId: 7, runIndex: 0, cluster: 0, xAdvance: 500, yAdvance: 0, xOffset: 0, yOffset: 0 }] }] },
    };
    const thin = projectGpuTextGlyphs({ ...common, runs: [run({ variationAxesKey: '[{"tag":"wght","value":100}]' })] });
    const bold = projectGpuTextGlyphs({ ...common, runs: [run({ variationAxesKey: '[{"tag":"wght","value":800}]' })] });
    expect(thin?.[0]?.textureKey).not.toEqual(bold?.[0]?.textureKey);
  });

  it("keeps synthetic weight and italic rasters in separate atlas identities", () => {
    const common = {
      nodeId: "text", x: 0, y: 0, width: 100, rotation: 0, fill: "#000000", opacity: 1, lineHeight: 25,
      layout: { unitsPerEm: 1000, lines: [{ start: 0, end: 1, direction: "ltr" as const, advance: 500, visualRuns: [], glyphs: [{ glyphId: 7, runIndex: 0, cluster: 0, xAdvance: 500, yAdvance: 0, xOffset: 0, yOffset: 0 }] }] },
    };
    const regular = projectGpuTextGlyphs({ ...common, runs: [run()] });
    const boldItalic = projectGpuTextGlyphs({ ...common, runs: [run({ syntheticStyleKey: "700:italic" })] });
    expect(regular?.[0]?.textureKey).not.toEqual(boldItalic?.[0]?.textureKey);
  });

  it("keeps Canvas as the fallback for missing rasters and unknown run indices", () => {
    const layout = { unitsPerEm: 1000, lines: [{ start: 0, end: 1, direction: "ltr" as const, advance: 1, visualRuns: [], glyphs: [{ glyphId: 7, runIndex: 1, cluster: 0, xAdvance: 1, yAdvance: 0, xOffset: 0, yOffset: 0 }] }] };
    const input = { nodeId: "text", x: 0, y: 0, width: 100, rotation: 0, fill: "#000000", opacity: 1, lineHeight: 25 };
    expect(projectGpuTextGlyphs({ ...input, runs: [run()], layout })).toBeUndefined();
    expect(projectGpuTextGlyphs({ ...input, runs: [run({ rasters: new Map() })], layout: { ...layout, lines: [{ ...layout.lines[0]!, glyphs: [{ ...layout.lines[0]!.glyphs[0]!, runIndex: 0 }] }] } })).toBeUndefined();
  });
});
