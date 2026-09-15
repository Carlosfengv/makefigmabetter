import { describe, expect, it } from "vitest";
import { connectorPathContains, connectorPathEndpointPose, connectorPathForNode, connectorPathLocalBounds, connectorPathSvgD } from "./connector-path";
import { connectorDecorationContains, connectorDecorationTriangles, connectorEndpointDecorations, connectorLabelLayout, connectorPresentationBounds, scaledConnectorDecorationTriangles } from "./connector-presentation";
import { createNode } from "./editor-protocol";
import { exportPageToSvg } from "./svg-export";
import { findTopmostHit, nodeContainsWorldPoint } from "./hit-test";
import { specialNodeFallback } from "./special-node-fallback";
import { worldLineVisualBounds } from "./line-world-bounds";
import { worldTransformsForNodes } from "./scene-transform";

const pageId = "00000000-0000-4000-8000-00000000c001";

function connector(lineType: "ELBOWED" | "STRAIGHT" | "CURVED") {
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

  it("derives magnet anchors from live target geometry without mutating Canonical fallback points", () => {
    const target = {
      ...createNode("rectangle", 250, 60),
      id: "00000000-0000-4000-8000-00000000c003",
      pageId,
      width: 100,
      height: 80,
    };
    const attached = {
      ...connector("ELBOWED"),
      connectorMetadata: {
        ...connector("ELBOWED").connectorMetadata!,
        end: { x: 200, y: 80, endpointNodeId: target.id, magnet: "LEFT" as const },
      },
    };
    const nodes = [target, attached];
    const path = connectorPathForNode(attached, { nodes })!;
    expect(connectorPathSvgD(path, String)).toBe("M 0 0 L 120 0 L 120 80 L 240 80");
    expect(attached.connectorMetadata.end).toMatchObject({ x: 200, y: 80, magnet: "LEFT" });
    expect(worldLineVisualBounds(nodes, attached)).toMatchObject({ right: 254, bottom: 104 });
    expect(findTopmostHit(nodes, { x: 250, y: 100 })?.id).toBe(attached.id);
    const exported = exportPageToSvg(nodes, { pageId, defaultPageId: pageId, padding: 0 });
    expect(exported.svg).toContain('d="M 0 0 L 120 0 L 120 80 L 240 80"');

    const movedTarget = { ...target, x: 300, y: 100 };
    const movedPath = connectorPathForNode(attached, { nodes: [movedTarget, attached] })!;
    expect(connectorPathSvgD(movedPath, String)).toBe("M 0 0 L 145 0 L 145 120 L 290 120");

    const center = { ...attached, connectorMetadata: { ...attached.connectorMetadata, end: { ...attached.connectorMetadata.end, magnet: "CENTER" as const } } };
    expect(connectorPathSvgD(connectorPathForNode(center, { nodes: [movedTarget, center] })!, String)).toBe("M 0 0 L 170 0 L 170 120 L 340 120");
    const expectedAnchors = {
      TOP: { x: 340, y: 80 }, RIGHT: { x: 390, y: 120 }, BOTTOM: { x: 340, y: 160 }, LEFT: { x: 290, y: 120 }, CENTER: { x: 340, y: 120 }, AUTO: { x: 290, y: 120 },
    } as const;
    Object.entries(expectedAnchors).forEach(([magnet, expected]) => {
      const variant = { ...attached, connectorMetadata: { ...attached.connectorMetadata, end: { ...attached.connectorMetadata.end, magnet: magnet as keyof typeof expectedAnchors } } };
      expect(connectorPathEndpointPose(connectorPathForNode(variant, { nodes: [movedTarget, variant] })!, "end")?.point).toEqual(expected);
    });
    const none = { ...attached, connectorMetadata: { ...attached.connectorMetadata, end: { ...attached.connectorMetadata.end, magnet: "NONE" as const } } };
    expect(connectorPathSvgD(connectorPathForNode(none, { nodes: [movedTarget, none] })!, String)).toBe("M 0 0 L 100 0 L 100 80 L 200 80");
  });

  it("reuses caller-owned node and transform indexes without rescanning the scene", () => {
    const target = {
      ...createNode("rectangle", 250, 60),
      id: "00000000-0000-4000-8000-00000000c003",
      pageId,
      width: 100,
      height: 80,
    };
    const attached = {
      ...connector("STRAIGHT"),
      connectorMetadata: {
        ...connector("STRAIGHT").connectorMetadata!,
        end: { x: 200, y: 80, endpointNodeId: target.id, magnet: "LEFT" as const },
      },
    };
    const nodes = [target, attached];
    const indexedNodes = new Proxy(nodes, {
      get(source, property, receiver) {
        if (property === "map") throw new Error("Connector route rescanned the complete node list.");
        return Reflect.get(source, property, receiver);
      },
    });
    const path = connectorPathForNode(attached, {
      nodes: indexedNodes,
      nodeById: new Map(nodes.map((node) => [node.id, node])),
      worldTransformByNodeId: worldTransformsForNodes(nodes),
    });
    expect(connectorPathSvgD(path!, String)).toBe("M 0 0 L 240 80");
  });

  it("resolves affine anchors only within the same explicit or implicit page", () => {
    const implicitPageId = "00000000-0000-4000-8000-00000000c010";
    const target = {
      ...createNode("rectangle", 0, 0),
      id: "00000000-0000-4000-8000-00000000c003",
      pageId,
      width: 100,
      height: 80,
      relativeTransform: { a: 0, b: 2, c: -1, d: 0, e: 300, f: 100 },
    };
    const attached = {
      ...connector("STRAIGHT"),
      relativeTransform: { a: 1, b: 0, c: .5, d: 1, e: 10, f: 20 },
      connectorMetadata: {
        ...connector("STRAIGHT").connectorMetadata!,
        end: { x: 200, y: 80, endpointNodeId: target.id, magnet: "LEFT" as const },
      },
    };
    const nodes = [target, attached];
    expect(connectorPathEndpointPose(connectorPathForNode(attached, { nodes })!, "end")?.point).toEqual({ x: 210, y: 80 });

    const crossPageTarget = { ...target, pageId: "00000000-0000-4000-8000-00000000c011" };
    expect(connectorPathEndpointPose(connectorPathForNode(attached, { nodes: [crossPageTarget, attached] })!, "end")?.point).toEqual({ x: 200, y: 80 });

    const legacyTarget = { ...target, pageId: undefined };
    expect(connectorPathEndpointPose(connectorPathForNode(attached, { nodes: [legacyTarget, attached], defaultPageId: implicitPageId })!, "end")?.point).toEqual({ x: 200, y: 80 });
    const defaultPageConnector = { ...attached, pageId: implicitPageId };
    expect(connectorPathEndpointPose(connectorPathForNode(defaultPageConnector, { nodes: [legacyTarget, defaultPageConnector], defaultPageId: implicitPageId })!, "end")?.point).toEqual({ x: 210, y: 80 });

    const singularConnector = { ...attached, relativeTransform: { a: 1, b: 0, c: 0, d: 0, e: 0, f: 0 } };
    expect(connectorPathEndpointPose(connectorPathForNode(singularConnector, { nodes: [target, singularConnector] })!, "end")?.point).toEqual({ x: 200, y: 80 });
    const singularTarget = { ...target, relativeTransform: { a: 0, b: 0, c: 0, d: 1, e: 300, f: 100 } };
    expect(connectorPathEndpointPose(connectorPathForNode(attached, { nodes: [singularTarget, attached] })!, "end")?.point).toEqual({ x: 200, y: 80 });
    const selfAttached = { ...attached, connectorMetadata: { ...attached.connectorMetadata, end: { ...attached.connectorMetadata.end, endpointNodeId: attached.id } } };
    expect(connectorPathEndpointPose(connectorPathForNode(selfAttached, { nodes: [target, selfAttached] })!, "end")?.point).toEqual({ x: 200, y: 80 });
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

  it("uses one deterministic crow-foot mesh for all six ERD connector caps", () => {
    const caps = ["ERD_ZERO_OR_ONE", "ERD_EXACTLY_ONE", "ERD_ZERO_OR_MORE", "ERD_ONE_OR_MORE", "ERD_ONE", "ERD_MANY"] as const;
    caps.forEach((cap) => {
      const node = {
        ...connector("STRAIGHT"),
        connectorMetadata: { ...connector("STRAIGHT").connectorMetadata!, endStrokeCap: cap },
      };
      const path = connectorPathForNode(node)!;
      const decoration = connectorEndpointDecorations(node, path)[0]!;
      const triangles = connectorDecorationTriangles(decoration, node.strokeWidth);
      expect(triangles.length).toBeGreaterThan(0);
      const [a, b, c] = triangles[0]!;
      const sample = { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 };
      expect(connectorDecorationContains(node, path, sample)).toBe(true);
      expect(connectorPresentationBounds(node, path).right).toBeGreaterThan(200);
      const exported = exportPageToSvg([node], { pageId, defaultPageId: pageId, padding: 0 });
      expect(exported.svg).toContain("fill-rule=\"nonzero\"");
      expect(exported.compatibilityFallbacks).toEqual([]);
    });
  });

  it("orients Connector caps once before applying the Canvas device scale", () => {
    const node = {
      ...connector("STRAIGHT"),
      connectorMetadata: {
        ...connector("STRAIGHT").connectorMetadata!,
        start: { x: 10, y: 20 },
        end: { x: 10, y: 120 },
        endStrokeCap: "ARROW_EQUILATERAL",
      },
    };
    const path = connectorPathForNode(node)!;
    const decoration = connectorEndpointDecorations(node, path)[0]!;
    const local = connectorDecorationTriangles(decoration, node.strokeWidth);
    const scaled = scaledConnectorDecorationTriangles(decoration, node.strokeWidth, 2.5);
    expect(scaled).toEqual(local.map((triangle) => triangle.map((point) => ({ x: point.x * 2.5, y: point.y * 2.5 }))));
    expect(local.flat().some((point) => point.y > 120)).toBe(true);
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
