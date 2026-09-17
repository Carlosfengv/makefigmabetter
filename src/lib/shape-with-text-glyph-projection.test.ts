import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import type { GpuTextProjectionRun } from "./gpu-text-projection";
import type { RustTextLayout } from "./rust-text-layout";
import { projectShapeWithTextHitGlyphs } from "./shape-with-text-glyph-projection";

const raster = { width: 4, height: 8, bearingX: 0, bearingY: 8, ascent: 8, advanceX: 10, alphaMask: new Uint8Array(32) };
const runs: GpuTextProjectionRun[] = [{
  fontAssetId: "font", faceIndex: 0, variationAxesKey: "[]", syntheticStyleKey: "400:normal",
  fontSize: 10, pixelSize: 10, rasters: new Map([[7, raster]]),
}];
const layout: RustTextLayout = {
  unitsPerEm: 1_000,
  lines: [{ start: 0, end: 1, direction: "ltr", advance: 1_000, visualRuns: [], glyphs: [
    { glyphId: 7, runIndex: 0, cluster: 0, xAdvance: 1_000, yAdvance: 0, xOffset: 0, yOffset: 0 },
  ] }],
};

describe("ShapeWithText shaped-glyph hit projection", () => {
  it("uses the ten-pixel inset and centers the visible line on both axes", () => {
    const node = {
      ...createNode("shapeWithText", 100, 200),
      id: "shape",
      width: 100,
      height: 60,
      textProperties: {
        runs: [{ start: 0, end: 1, fontSize: 10, fontWeight: 400, italic: false, letterSpacing: 0 }],
        paragraph: { alignment: "center" as const, lineHeight: 12, paragraphSpacing: 0 },
        autoSize: "fixed" as const,
      },
    };
    expect(projectShapeWithTextHitGlyphs({ node, runs, layout, lineHeight: 12 })).toMatchObject([
      { nodeId: "shape", x: 45, y: 25, width: 4, height: 8, paintRunIndex: 0 },
    ]);
  });

  it("centers the trimmed cap-height block while allowing ink overflow", () => {
    const node = {
      ...createNode("shapeWithText", 0, 0), id: "trimmed-shape", text: "A", width: 100, height: 60,
      textProperties: {
        runs: [{ start: 0, end: 1, fontSize: 10, fontWeight: 400, italic: false, letterSpacing: 0, leadingTrim: "capHeight" as const }],
        paragraph: { alignment: "center" as const, lineHeight: 12, paragraphSpacing: 0 },
        autoSize: "fixed" as const,
      },
    };
    const metricRuns = [{ ...runs[0]!, rasters: new Map([[7, { ...raster, descent: 2, capHeight: 7 }]]) }];
    expect(projectShapeWithTextHitGlyphs({ node, runs: metricRuns, layout, lineHeight: 12 })?.[0]?.y).toBe(25.5);
  });

  it("right-anchors RTL inside the inset content box", () => {
    const node = {
      ...createNode("shapeWithText", 0, 0),
      id: "rtl-shape",
      width: 100,
      height: 40,
      textProperties: {
        runs: [{ start: 0, end: 1, fontSize: 10, fontWeight: 400, italic: false, letterSpacing: 0 }],
        paragraph: { alignment: "right" as const, lineHeight: 12, paragraphSpacing: 0 },
        autoSize: "fixed" as const,
      },
    };
    const rtl = { ...layout, lines: [{ ...layout.lines[0]!, direction: "rtl" as const }] };
    expect(projectShapeWithTextHitGlyphs({ node, runs, layout: rtl, lineHeight: 12 })?.[0]?.x).toBe(80);
  });

  it("centers linked list glyphs inside the marker-adjusted content box", () => {
    const node = {
      ...createNode("shapeWithText", 0, 0), id: "listed-shape", text: "A", width: 100, height: 60,
      textProperties: {
        runs: [],
        paragraph: { alignment: "center" as const, lineHeight: 12, paragraphSpacing: 0, listType: "ordered" as const },
        autoSize: "fixed" as const,
      },
    };
    expect(projectShapeWithTextHitGlyphs({ node, runs, layout, lineHeight: 12, listMarkerGutter: 20 })?.[0]?.x).toBe(55);
  });

  it("rejects unrelated node kinds and invalid line metrics", () => {
    expect(projectShapeWithTextHitGlyphs({ node: createNode("text", 0, 0), runs, layout, lineHeight: 12 })).toBeUndefined();
    expect(projectShapeWithTextHitGlyphs({ node: createNode("shapeWithText", 0, 0), runs, layout, lineHeight: 0 })).toBeUndefined();
  });
});
