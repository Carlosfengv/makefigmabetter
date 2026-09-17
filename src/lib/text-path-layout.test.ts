import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { specialNodeFallback } from "./special-node-fallback";
import { exportPageToSvg } from "./svg-export";
import { layoutTextPath, textPathCharacterAtLocalPoint } from "./text-path-layout";

const pageId = "00000000-0000-4000-8000-00000000e001";

function textPath() {
  return {
    ...createNode("textPath", 10, 20), id: "00000000-0000-4000-8000-00000000e002", pageId, text: "AB", width: 120, height: 80,
    vectorPath: { fillRule: "nonZero" as const, subpaths: [{ closed: false, points: [{ id: "a", x: 0, y: 20, pointType: "corner" as const }, { id: "b", x: 100, y: 20, pointType: "corner" as const }, { id: "c", x: 100, y: 70, pointType: "corner" as const }] }] },
  };
}

describe("M6 TextPath layout", () => {
  it("produces shared deterministic glyph poses for an open Canonical polyline", () => {
    const node = textPath();
    expect(layoutTextPath(node, 10)).toEqual([
      { text: "A", x: 5, y: 24, angle: 0 },
      { text: "B", x: 15, y: 24, angle: 0 },
    ]);
    expect(specialNodeFallback(node, "canvas")).toBeUndefined();
    const exported = exportPageToSvg([node], { pageId, defaultPageId: pageId, padding: 0 });
    expect(exported.svg).toContain('dominant-baseline="central"');
    expect(exported.svg).toContain(">A</text>");
    expect(exported.compatibilityFallbacks).toEqual([]);
  });

  it("maps rotated fallback glyph boxes back to UTF-16 source characters", () => {
    const node = { ...textPath(), text: "A😀" };
    expect(textPathCharacterAtLocalPoint(node, { x: 5, y: 24 }, {
      advance: 10,
      glyphHeight: 12,
      measure: () => 8,
    })).toBe(0);
    expect(textPathCharacterAtLocalPoint(node, { x: 15, y: 24 }, {
      advance: 10,
      glyphHeight: 12,
      measure: () => 8,
    })).toBe(1);
    expect(textPathCharacterAtLocalPoint(node, { x: 30, y: 24 }, {
      advance: 10,
      glyphHeight: 12,
      measure: () => 8,
    })).toBeUndefined();

    const vertical = {
      ...node,
      text: "A",
      textPathMetadata: { ...node.textPathMetadata!, startSegment: 1, startPosition: 0, textAlignVertical: "CENTER" as const },
    };
    expect(textPathCharacterAtLocalPoint(vertical, { x: 100, y: 25 }, {
      advance: 10,
      glyphHeight: 12,
      measure: () => 8,
    })).toBe(0);
    expect(textPathCharacterAtLocalPoint(vertical, { x: 93, y: 25 }, {
      advance: 10,
      glyphHeight: 12,
      measure: () => 8,
    })).toBeUndefined();
  });

  it("samples open Canonical cubic segments while retaining malformed offsets as an explicit fallback", () => {
    const node = textPath();
    const curved = { ...node, vectorPath: { ...node.vectorPath!, subpaths: [{ ...node.vectorPath!.subpaths[0]!, points: [{ ...node.vectorPath!.subpaths[0]!.points[0]!, handleOut: { x: 20, y: -40 } }, { ...node.vectorPath!.subpaths[0]!.points[1]!, handleIn: { x: -20, y: -40 } }, ...node.vectorPath!.subpaths[0]!.points.slice(2)] }] } };
    const glyphs = layoutTextPath(curved, 10)!;
    expect(glyphs).toHaveLength(2);
    expect(glyphs[0]!.y).toBeLessThan(20);
    expect(glyphs[0]!.angle).toBeLessThan(0);
    expect(specialNodeFallback(curved, "svg")).toBeUndefined();
    expect(exportPageToSvg([curved], { pageId, defaultPageId: pageId, padding: 0 }).compatibilityFallbacks).toEqual([]);
    const invalidOffset = { ...node, textPathMetadata: { ...node.textPathMetadata!, startPosition: Number.NaN } };
    expect(layoutTextPath(invalidOffset, 10)).toBeUndefined();
    expect(specialNodeFallback(invalidOffset, "canvas")).toMatchObject({ code: "M6_TEXT_PATH_LAYOUT_FALLBACK" });
  });

  it("wraps closed source contours from the selected segment", () => {
    const node = textPath();
    const closed = {
      ...node,
      text: "ABCD",
      vectorPath: {
        fillRule: "nonZero" as const,
        subpaths: [{
          closed: true,
          points: [
            { id: "a", x: 0, y: 0, pointType: "corner" as const },
            { id: "b", x: 100, y: 0, pointType: "corner" as const },
            { id: "c", x: 100, y: 80, pointType: "corner" as const },
            { id: "d", x: 0, y: 80, pointType: "corner" as const },
          ],
        }],
      },
      textPathMetadata: { ...node.textPathMetadata!, startSegment: 3, startPosition: 0, textAlignVertical: "CENTER" as const },
    };

    expect(layoutTextPath(closed, 20)).toEqual([
      { text: "A", x: 0, y: 70, angle: -Math.PI / 2 },
      { text: "B", x: 0, y: 50, angle: -Math.PI / 2 },
      { text: "C", x: 0, y: 30, angle: -Math.PI / 2 },
      { text: "D", x: 0, y: 10, angle: -Math.PI / 2 },
    ]);
    expect(specialNodeFallback(closed, "canvas")).toBeUndefined();
    expect(exportPageToSvg([closed], { pageId, defaultPageId: pageId, padding: 0 }).compatibilityFallbacks).toEqual([]);
  });

  it("exports frozen rich-run metrics through one native SVG textPath", () => {
    const assetId = "00000000-0000-4000-8000-00000000e0f0";
    const node = {
      ...textPath(),
      textProperties: {
        runs: [
          { start: 0, end: 1, font: { assetId, faceIndex: 0 }, fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0, color: { space: "srgb" as const, components: [1, 0, 0] as [number, number, number], alpha: 1 } },
          { start: 1, end: 2, font: { assetId, faceIndex: 0 }, fontSize: 30, fontWeight: 700, italic: true, letterSpacing: 1, color: { space: "srgb" as const, components: [0, 0, 1] as [number, number, number], alpha: 1 } },
        ],
        paragraph: { alignment: "left" as const, lineHeight: 32, paragraphSpacing: 0 },
        autoSize: "fixed" as const,
        fallbackFonts: [],
      },
    };
    const exported = exportPageToSvg([node], {
      pageId, defaultPageId: pageId, padding: 0,
      fontDataUris: new Map([[assetId, "data:font/woff2;base64,AA=="]]),
      textLayouts: new Map([[node.id, { unitsPerEm: 1_000, lines: [{ start: 0, end: 2, direction: "ltr", advance: 1_500 }] }]]),
    });

    expect(exported.svg).toContain('<path id="makefigma-text-path-');
    expect(exported.svg).toContain('<textPath href="#makefigma-text-path-');
    expect(exported.svg).toContain('textLength="30"');
    expect(exported.svg).toContain('font-size="20"');
    expect(exported.svg).toContain('font-size="30"');
    expect(exported.svg).toContain('fill="#ff0000"');
    expect(exported.svg).toContain('fill="#0000ff"');
    expect(exported.compatibilityFallbacks).toEqual([]);
  });
});
