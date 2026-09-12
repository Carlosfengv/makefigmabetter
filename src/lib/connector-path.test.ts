import { describe, expect, it } from "vitest";
import { connectorPathContains, connectorPathForNode, connectorPathLocalBounds, connectorPathSvgD } from "./connector-path";
import { connectorDecorationContains, connectorEndpointDecorations, connectorLabelLayout, connectorPresentationBounds } from "./connector-presentation";
import { createNode } from "./editor-protocol";
import { exportPageToSvg } from "./svg-export";
import { nodeContainsWorldPoint } from "./hit-test";
import { specialNodeFallback } from "./special-node-fallback";
import { worldLineVisualBounds } from "./line-world-bounds";

const pageId = "00000000-0000-4000-8000-00000000c001";

function connector(lineType: "ELBOWED" | "CURVED") {
  return {
    ...createNode("connector", 10, 20), id: "00000000-0000-4000-8000-00000000c002", pageId, width: 200, height: 80, stroke: "#334155", strokeWidth: 4,
    connectorMetadata: { lineType, start: { x: 0, y: 0, magnet: "AUTO" as const }, end: { x: 200, y: 80, magnet: "AUTO" as const }, startStrokeCap: "NONE", endStrokeCap: "NONE", text: "" },
  };
}

describe("M6 Connector routing", () => {
  it("derives stable elbow segments shared by SVG, hit test, and visual bounds", () => {
    const node = connector("ELBOWED");
    const path = connectorPathForNode(node)!;
    expect(path).toEqual({ kind: "polyline", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 200, y: 80 }] });
    expect(connectorPathSvgD(path, (value) => String(value))).toBe("M 0 0 L 100 0 L 100 80 L 200 80");
    expect(connectorPathContains(path, { x: 100, y: 40 }, 2)).toBe(true);
    expect(connectorPathLocalBounds(path, node.strokeWidth, 4)).toEqual({ left: -4, top: -4, right: 204, bottom: 84 });
    expect(nodeContainsWorldPoint(node, { x: 110, y: 60 })).toBe(true);
    expect(nodeContainsWorldPoint(node, { x: 150, y: 60 })).toBe(false);
    expect(worldLineVisualBounds([node], node)).toEqual({ left: 6, top: 16, right: 214, bottom: 104 });
    expect(specialNodeFallback(node, "canvas")).toBeUndefined();

    const exported = exportPageToSvg([node], { pageId, defaultPageId: pageId, padding: 0 });
    expect(exported.svg).toContain('d="M 0 0 L 100 0 L 100 80 L 200 80"');
    expect(exported.compatibilityFallbacks).toEqual([]);
  });

  it("uses deterministic cubic controls", () => {
    const node = connector("CURVED");
    const path = connectorPathForNode(node)!;
    expect(connectorPathSvgD(path, (value) => String(value))).toBe("M 0 0 C 100 0 100 80 200 80");
    expect(specialNodeFallback(node, "svg")).toBeUndefined();
  });

  it("rounds Canonical elbow corners in the same route geometry", () => {
    const node = { ...connector("ELBOWED"), connectorMetadata: { ...connector("ELBOWED").connectorMetadata!, cornerRadius: 20 } };
    const path = connectorPathForNode(node)!;
    expect(connectorPathSvgD(path, (value) => String(value))).toBe("M 0 0 L 80 0 Q 100 0 100 20 L 100 60 Q 100 80 120 80 L 200 80");
    expect(connectorPathContains(path, { x: 100, y: 40 }, 2)).toBe(true);
    expect(specialNodeFallback(node, "canvas")).toBeUndefined();
  });

  it("shares Canonical label and dedicated caps across SVG, hit testing, and visual bounds", () => {
    const node = {
      ...connector("ELBOWED"),
      connectorMetadata: { ...connector("ELBOWED").connectorMetadata!, startStrokeCap: "ARROW_EQUILATERAL", endStrokeCap: "DIAMOND_FILLED", text: "Review" },
    };
    const path = connectorPathForNode(node)!;
    expect(connectorEndpointDecorations(node, path)).toHaveLength(2);
    expect(connectorLabelLayout(node, path)).toMatchObject({ text: "Review", x: 100, y: 30 });
    expect(connectorDecorationContains(node, path, { x: -2, y: 0 })).toBe(true);
    expect(connectorPresentationBounds(node, path, 4)).toMatchObject({ left: -16, right: 216 });
    expect(nodeContainsWorldPoint(node, { x: 8, y: 20 })).toBe(true);
    expect(worldLineVisualBounds([node], node)).toMatchObject({ left: -6, right: 226 });

    const exported = exportPageToSvg([node], { pageId, defaultPageId: pageId, padding: 0 });
    expect(exported.svg).toContain(">Review</tspan>");
    expect(exported.svg).toContain('d="M 0 0 L -16');
    expect(exported.compatibilityFallbacks).toEqual([]);
    expect(specialNodeFallback(node, "svg")).toBeUndefined();
  });

  it("keeps multiline plain-text labels aligned across SVG, hit testing, and bounds", () => {
    const node = { ...connector("ELBOWED"), connectorMetadata: { ...connector("ELBOWED").connectorMetadata!, text: "Review\napprover" } };
    const path = connectorPathForNode(node)!;
    const label = connectorLabelLayout(node, path)!;
    expect(label).toMatchObject({ lines: ["Review", "approver"], width: 69.6, height: 36, x: 100, y: 30 });
    expect(nodeContainsWorldPoint(node, { x: 90, y: 34 })).toBe(true);

    const exported = exportPageToSvg([node], { pageId, defaultPageId: pageId, padding: 0 });
    expect(exported.svg).toContain(">Review</tspan>");
    expect(exported.svg).toContain(">approver</tspan>");
    expect(exported.compatibilityFallbacks).toEqual([]);
  });
});
