import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { nodeContainsWorldPoint } from "./hit-test";
import { parametricShapePath, parametricShapePoints } from "./parametric-shape";
import { exportPageToSvg } from "./svg-export";

describe("parametric regular shapes", () => {
  it("generates top-anchored clockwise outlines and preserves star concavity", () => {
    const polygon = parametricShapePoints(100, 100, { kind: "polygon", pointCount: 5 });
    const star = parametricShapePoints(100, 100, { kind: "star", pointCount: 5, innerRatio: .4 });
    expect(polygon[0]).toEqual({ x: 50, y: 0 });
    expect(star).toHaveLength(10);
    expect(star[1].y).toBeGreaterThan(star[0].y);
    expect(parametricShapePath(polygon)).toContain("Z");
  });

  it("uses the same outline for hit testing and SVG export", () => {
    const node = { ...createNode("star", 0, 0), id: "00000000-0000-0000-0000-000000000002", pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000002:00000000000000000000000000000000" };
    expect(nodeContainsWorldPoint(node, { x: 80, y: 80 })).toBe(true);
    expect(nodeContainsWorldPoint(node, { x: 0, y: 159 })).toBe(false);
    const result = exportPageToSvg([node], { pageId: node.pageId, defaultPageId: node.pageId, padding: 0 });
    expect(result.svg).toContain("<path d=\"M 80 0");
  });

  it("uses a frozen Core-derived outline for SVG when supplied", () => {
    const node = { ...createNode("polygon", 0, 0), id: "00000000-0000-4000-8000-000000000071", pageId: "00000000-0000-4000-8000-000000000001", width: 100, height: 80 };
    const result = exportPageToSvg([node], {
      pageId: node.pageId,
      defaultPageId: node.pageId,
      padding: 0,
      parametricShapePaths: new Map([[node.id, [{ x: 50, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 }]]]),
    });
    expect(result.svg).toContain("<path d=\"M 50 0 L 100 80 L 0 80 Z\"");
  });
});
