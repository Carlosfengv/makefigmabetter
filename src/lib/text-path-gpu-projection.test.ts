import { describe, expect, it } from "vitest";
import { createNode, type DocumentTextProperties } from "./editor-protocol";
import type { RustTextLayout } from "./rust-text-layout";
import { projectTextPathGpuGlyphs, projectTextPathLocalGlyphs, type TextPathGpuProjectionRun } from "./text-path-gpu-projection";

const properties: DocumentTextProperties = {
  runs: [{ start: 0, end: 2, font: { assetId: "font-a", faceIndex: 0 }, fontSize: 10, fontWeight: 400, italic: false, letterSpacing: 0 }],
  paragraph: { alignment: "left", lineHeight: 12, paragraphSpacing: 0 },
  autoSize: "fixed",
};

function node() {
  return {
    ...createNode("textPath", 10, 20),
    id: "text-path-a",
    text: "AB",
    width: 100,
    height: 40,
    textProperties: properties,
    vectorPath: { fillRule: "nonZero" as const, subpaths: [{ closed: false, points: [
      { id: "a", x: 0, y: 20, pointType: "corner" as const },
      { id: "b", x: 100, y: 20, pointType: "corner" as const },
    ] }] },
  };
}

const raster = { width: 4, height: 8, bearingX: 1, bearingY: 7, ascent: 8, advanceX: 10, alphaMask: Uint8Array.from(Array(32).fill(255)) };
const runs: TextPathGpuProjectionRun[] = [{
  fontAssetId: "font-a", faceIndex: 0, variationAxesKey: "[]", syntheticStyleKey: "400:normal",
  fontSize: 10, pixelSize: 10, rasters: new Map([[7, raster], [8, raster]]), fill: "#123456", opacity: .5,
}];
const layout: RustTextLayout = {
  unitsPerEm: 1_000,
  lines: [{
    start: 0, end: 2, direction: "ltr", advance: 2_000,
    visualRuns: [{ start: 0, end: 2, direction: "ltr" }],
    glyphs: [
      { glyphId: 7, runIndex: 0, cluster: 0, xAdvance: 1_000, yAdvance: 0, xOffset: 0, yOffset: 0 },
      { glyphId: 8, runIndex: 0, cluster: 1, xAdvance: 1_000, yAdvance: 0, xOffset: 0, yOffset: 0 },
    ],
  }],
};

describe("TextPath GPU projection", () => {
  it("places Rust glyph rasters by their exact advances and path tangents", () => {
    const glyphs = projectTextPathGpuGlyphs({ node: node(), runs, layout });
    expect(glyphs).toMatchObject([
      { nodeId: "text-path-a", x: 11, y: 37, width: 4, height: 8, rotation: 0, fill: "#123456", opacity: .5 },
      { nodeId: "text-path-a", x: 21, y: 37, width: 4, height: 8, rotation: 0, fill: "#123456", opacity: .5 },
    ]);
    expect(glyphs?.map((glyph) => glyph.textureKey)).toEqual([
      "font-a:0:[]:400:normal:7:10",
      "font-a:0:[]:400:normal:8:10",
    ]);
  });

  it("keeps Rust visual glyph order and clips overflow at the path boundary", () => {
    const visualGlyphs = [...layout.lines[0]!.glyphs].reverse().map((glyph) => ({ ...glyph, xAdvance: 60_000 }));
    const visual = { ...layout, lines: [{ ...layout.lines[0]!, advance: 120_000, glyphs: visualGlyphs }] };
    const glyphs = projectTextPathGpuGlyphs({ node: node(), runs, layout: visual });
    expect(glyphs).toHaveLength(1);
    expect(glyphs?.[0]?.textureKey).toContain(":8:");
  });

  it("composes path tangents with a legacy node rotation for WebGPU", () => {
    const glyphs = projectTextPathGpuGlyphs({ node: { ...node(), rotation: 90 }, runs, layout });
    expect(glyphs).toHaveLength(2);
    expect(glyphs?.[0]?.x).toBeCloseTo(57);
    expect(glyphs?.[0]?.y).toBeCloseTo(-11);
    expect(glyphs?.[0]?.rotation).toBeCloseTo(90);
    expect(glyphs?.[0]?.quadTransform?.a).toBeCloseTo(0);
    expect(glyphs?.[0]?.quadTransform?.b).toBeCloseTo(4);
    expect(glyphs?.[0]?.quadTransform?.c).toBeCloseTo(-8);
    expect(glyphs?.[0]?.quadTransform?.d).toBeCloseTo(0);
    expect(glyphs?.[0]?.quadTransform?.e).toBeCloseTo(63);
    expect(glyphs?.[0]?.quadTransform?.f).toBeCloseTo(-9);
    expect(glyphs?.[1]?.x).toBeCloseTo(57);
    expect(glyphs?.[1]?.y).toBeCloseTo(-1);
  });

  it("projects arbitrary affine TextPath glyphs into complete WebGPU quads while retaining Canvas-local glyphs", () => {
    const affineNode = { ...node(), relativeTransform: { a: -1, b: .2, c: .35, d: 1, e: 330, f: 70 } };
    const gpuGlyphs = projectTextPathGpuGlyphs({ node: affineNode, runs, layout });
    expect(gpuGlyphs?.[0]?.quadTransform).toEqual({ a: -4, b: .8, c: 2.8, d: 8, e: 334.95, f: 87.2 });
    expect(gpuGlyphs?.[1]?.quadTransform).toEqual({ a: -4, b: .8, c: 2.8, d: 8, e: 324.95, f: 89.2 });
    expect(projectTextPathLocalGlyphs({ node: affineNode, runs, layout })).toMatchObject([
      { x: 1, y: 17, width: 4, height: 8, rotation: 0 },
      { x: 11, y: 17, width: 4, height: 8, rotation: 0 },
    ]);
  });

  it("uses the resolved world transform for nested Relative-v1 ancestry", () => {
    const child = { ...node(), parentId: "group-a", relativeTransform: { a: 1, b: 0, c: .25, d: 1, e: 10, f: 20 } };
    const worldTransform = { a: 0, b: 2, c: -3, d: 0, e: 400, f: 50 };
    const glyphs = projectTextPathGpuGlyphs({ node: child, runs, layout, worldTransform });
    expect(glyphs?.[0]?.quadTransform).toEqual({ a: 0, b: 8, c: -24, d: 0, e: 349, f: 52 });
  });

  it("rejects wrapped shaping before a partial glyph pass can render", () => {
    expect(projectTextPathGpuGlyphs({ node: node(), runs, layout: { ...layout, lines: [...layout.lines, layout.lines[0]!] } })).toBeUndefined();
  });
});
