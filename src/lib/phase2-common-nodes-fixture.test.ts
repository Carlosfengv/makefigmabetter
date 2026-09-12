import { NodeKind, ResolvedOperationBatch, StrokeAlign, StrokeCap } from "@makefigma/protocol-types";
import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/documents/phase2-common-nodes.fixture.json";
import type { CanvasNode } from "./editor-protocol";
import { worldLineVisualBounds } from "./line-world-bounds";
import { encodeCoreBatchPayload, idBytes } from "./protocol-operation-codec";
import { worldTransformForNode } from "./scene-transform";
import { resolveCoreBatch } from "./transaction-batch";

describe("F-PHASE2-COMMON-NODES fixture", () => {
  const nodes = fixture.nodes as CanvasNode[];

  it("covers the Phase 2 common-node hierarchy and exact transform cases", () => {
    expect(fixture.format).toBe("makefigma-phase2-common-nodes-fixture-v1");
    expect(fixture.name).toBe("F-PHASE2-COMMON-NODES");
    expect(nodes.map((node) => node.kind)).toEqual(expect.arrayContaining(["frame", "group", "rectangle", "ellipse", "line", "section", "text", "slice"]));
    const nestedFrame = nodes.find((node) => node.name === "Rotated Frame")!;
    const group = nodes.find((node) => node.name === "Content Group")!;
    const arrow = nodes.find((node) => node.name === "Independent-cap Arrow")!;
    expect(group.parentId).toBe(nestedFrame.id);
    expect(arrow.height).toBe(0);
    expect(arrow.strokeCapStart).toBe("square");
    expect(arrow.strokeCapEnd).toBe("arrowLines");
    expect(worldTransformForNode(nodes, arrow.id)).toBeDefined();
    expect(worldLineVisualBounds(nodes, arrow)).toEqual(expect.objectContaining({ left: expect.any(Number), top: expect.any(Number), right: expect.any(Number), bottom: expect.any(Number) }));
    const slice = nodes.find((node) => node.name === "Rotated Export Slice")!;
    expect(slice.kind).toBe("slice");
    expect(slice.strokeWidth).toBe(0);
    expect(worldTransformForNode(nodes, slice.id)).toBeDefined();
  });

  it("keeps every parent reference within the fixture and supplies valid finite geometry", () => {
    const ids = new Set(nodes.map((node) => node.id));
    for (const node of nodes) {
      expect(node.parentId === undefined || ids.has(node.parentId)).toBe(true);
      expect([node.x, node.y, node.width, node.height, node.rotation, node.opacity].every(Number.isFinite)).toBe(true);
      expect(node.kind === "line" ? node.height === 0 && node.width >= 0 : node.width > 0 && node.height > 0).toBe(true);
    }
  });

  it("round-trips every Phase 2 common node through the resolved operation payload", () => {
    const resolved = resolveCoreBatch([], nodes.map((node) => ({ type: "create" as const, node })));
    expect(resolved?.nextNodes).toEqual(nodes);

    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));
    const created = batch.operations.flatMap((operation) => operation.createNode?.node ? [operation.createNode.node] : []);
    expect(created).toHaveLength(nodes.length);
    expect(created.map((node) => node.name)).toEqual(nodes.map((node) => node.name));

    for (const source of nodes) {
      const persisted = created.find((node) => node.name === source.name)!;
      expect(persisted.nodeId).toEqual(idBytes(source.id));
      expect(persisted.parentId).toEqual(source.parentId ? idBytes(source.parentId) : undefined);
      expect(persisted).toMatchObject({
        kind: kindFor(source.kind),
        x: source.x,
        y: source.y,
        width: source.width,
        height: source.height,
        rotation: source.rotation,
        visible: true,
      });
    }

    expect(created.find((node) => node.name === "Asymmetric Card")).toMatchObject({
      kind: NodeKind.NODE_KIND_RECTANGLE,
      cornerRadius: 0,
      cornerRadii: [18, 4, 26, 10],
      cornerSmoothing: .5,
      strokeWeights: [2, 6, 3, 5],
    });
    expect(created.find((node) => node.name === "Asymmetric Card")?.effectStack).toHaveLength(2);
    expect(created.find((node) => node.name === "Independent-cap Arrow")).toMatchObject({
      kind: NodeKind.NODE_KIND_LINE,
      height: 0,
      strokeCapStart: StrokeCap.STROKE_CAP_SQUARE,
      strokeCapEnd: StrokeCap.STROKE_CAP_ARROW_LINES,
      strokeDashPattern: [12, 6],
    });
    expect(created.find((node) => node.name === "Donut Ellipse")?.arcData).toMatchObject({ startingAngle: 20, endingAngle: 320, innerRadius: .45 });
    expect(created.find((node) => node.name === "Outside Ellipse")).toMatchObject({
      kind: NodeKind.NODE_KIND_ELLIPSE,
      strokeWidth: 6,
      strokeAlign: StrokeAlign.STROKE_ALIGN_OUTSIDE,
      arcData: undefined,
    });
    expect(created.find((node) => node.name === "Root Frame")?.clipsContent).toBe(true);
    expect(created.find((node) => node.name === "Section")?.contentsHidden).toBe(false);
    expect(created.find((node) => node.name === "Fixture label")?.text).toBe("Phase 2 common nodes");
    expect(created.find((node) => node.name === "Rotated Export Slice")).toMatchObject({ kind: NodeKind.NODE_KIND_SLICE, strokeWidth: 0, fill: { solid: { alpha: 0 } } });
  });
});

function kindFor(kind: CanvasNode["kind"]) {
  return kind === "frame" ? NodeKind.NODE_KIND_FRAME : kind === "group" ? NodeKind.NODE_KIND_GROUP : kind === "section" ? NodeKind.NODE_KIND_SECTION : kind === "rectangle" ? NodeKind.NODE_KIND_RECTANGLE : kind === "ellipse" ? NodeKind.NODE_KIND_ELLIPSE : kind === "polygon" ? NodeKind.NODE_KIND_POLYGON : kind === "star" ? NodeKind.NODE_KIND_STAR : kind === "vector" ? NodeKind.NODE_KIND_VECTOR : kind === "booleanOperation" ? NodeKind.NODE_KIND_BOOLEAN_OPERATION : kind === "slice" ? NodeKind.NODE_KIND_SLICE : kind === "line" ? NodeKind.NODE_KIND_LINE : kind === "text" ? NodeKind.NODE_KIND_TEXT : kind === "codeBlock" ? NodeKind.NODE_KIND_CODE_BLOCK : NodeKind.NODE_KIND_IMAGE;
}
