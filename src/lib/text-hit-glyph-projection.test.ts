import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import type { GpuTextProjectionRun } from "./gpu-text-projection";
import type { RustTextLayout } from "./rust-text-layout";
import { projectTextHitGlyphs } from "./text-hit-glyph-projection";

const raster = { width: 4, height: 8, bearingX: 0, bearingY: 8, ascent: 8, advanceX: 10, alphaMask: new Uint8Array(32) };
const runs: GpuTextProjectionRun[] = [{ fontAssetId: "font", faceIndex: 0, variationAxesKey: "[]", syntheticStyleKey: "400:normal", fontSize: 10, pixelSize: 10, rasters: new Map([[7, raster]]) }];
const layout: RustTextLayout = { unitsPerEm: 1_000, lines: [{ start: 0, end: 1, direction: "ltr", advance: 1_000, visualRuns: [], glyphs: [{ glyphId: 7, runIndex: 0, cluster: 0, xAdvance: 1_000, yAdvance: 0, xOffset: 0, yOffset: 0 }] }] };

describe("Text interaction glyph projection", () => {
  it("keeps authored rotation and position out of node-local hit glyphs", () => {
    const text = { ...createNode("text", 120, 240), id: "rotated", width: 100, rotation: 67 };
    expect(projectTextHitGlyphs({ node: text, runs, layout, lineHeight: 12 })).toMatchObject([
      { nodeId: "rotated", x: 0, y: 1, width: 4, height: 8, rotation: 0, paintRunIndex: 0 },
    ]);
  });

  it("uses the explicit cap-height baseline for leading-trim hit ink", () => {
    const text = {
      ...createNode("text", 0, 0), id: "trimmed", text: "A", width: 100,
      textProperties: {
        runs: [{ start: 0, end: 1, fontSize: 10, fontWeight: 400, italic: false, letterSpacing: 0, leadingTrim: "capHeight" as const }],
        paragraph: { alignment: "left" as const, lineHeight: 12, paragraphSpacing: 0 },
        autoSize: "fixed" as const,
      },
    };
    const metricRuns = [{ ...runs[0]!, rasters: new Map([[7, { ...raster, descent: 2, capHeight: 7 }]]) }];
    expect(projectTextHitGlyphs({ node: text, runs: metricRuns, layout, lineHeight: 12 })?.[0]?.y).toBe(-1);
  });

  it("preserves physical centering for a shaped RTL line", () => {
    const text = {
      ...createNode("text", 0, 0), id: "centered", width: 100,
      textProperties: { runs: [], paragraph: { alignment: "center" as const, lineHeight: 12, paragraphSpacing: 0 }, autoSize: "fixed" as const },
    };
    const rtl = { ...layout, lines: [{ ...layout.lines[0]!, direction: "rtl" as const }] };
    expect(projectTextHitGlyphs({ node: text, runs, layout: rtl, lineHeight: 12 })?.[0]?.x).toBe(45);
  });

  it("centers the first line inside its indented line box", () => {
    const text = {
      ...createNode("text", 0, 0), id: "indented", text: "A", width: 100,
      textProperties: {
        runs: [],
        paragraph: { alignment: "center" as const, lineHeight: 12, paragraphSpacing: 0, paragraphIndent: 20 },
        autoSize: "fixed" as const,
      },
    };
    expect(projectTextHitGlyphs({ node: text, runs, layout, lineHeight: 12 })?.[0]?.x).toBe(55);
  });

  it("places linked glyphs after the shaped list marker column", () => {
    const text = {
      ...createNode("text", 0, 0), id: "listed", text: "A", width: 100,
      textProperties: {
        runs: [],
        paragraph: { alignment: "left" as const, lineHeight: 12, paragraphSpacing: 0, listType: "ordered" as const },
        autoSize: "fixed" as const,
      },
    };
    expect(projectTextHitGlyphs({ node: text, runs, layout, lineHeight: 12, listMarkerGutter: 20 })?.[0]?.x).toBe(20);
  });

  it("rejects non-Text nodes", () => {
    expect(projectTextHitGlyphs({ node: createNode("shapeWithText", 0, 0), runs, layout, lineHeight: 12 })).toBeUndefined();
  });
});
