import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { specialNodeFallback } from "./special-node-fallback";
import { exportPageToSvg } from "./svg-export";
import { layoutTextPath } from "./text-path-layout";

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
});
