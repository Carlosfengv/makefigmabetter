import { BlendMode, ConstraintType, LayoutAlignment, LayoutMode, LayoutSizing, NodeKind, ResolvedOperationBatch, StrokeAlign, StrokeCap } from "@makefigma/protocol-types";
import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { encodeCoreBatchPayload, encodeCreatePagePayload, encodeRegisterResourcePayload, idBytes } from "./protocol-operation-codec";
import { resolveCoreBatch } from "./transaction-batch";

const id = "00000000-0000-4000-8000-000000000001";

describe("protocol operation codec", () => {
  it("serializes worker-resolved creates as generated protobuf operations", () => {
    const node = { ...createNode("rectangle", 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000" };
    const resolved = resolveCoreBatch([], [{ type: "create", node }]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));
    expect(batch.operations).toHaveLength(1);
    expect(batch.operations[0].createNode?.node).toMatchObject({ name: node.name, kind: NodeKind.NODE_KIND_RECTANGLE, nodeId: idBytes(id), pageId: idBytes(node.pageId!) });
  });

  it("serializes a zero-height line with the generated Line node kind", () => {
    const node = { ...createNode("line", 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000" };
    const resolved = resolveCoreBatch([], [{ type: "create", node }]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));

    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_LINE, height: 0 });
  });

  it("serializes a non-painting Slice with its dedicated generated node kind", () => {
    const node = { ...createNode("slice", 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000" };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));

    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_SLICE, width: 320, height: 220, strokeWidth: 0 });
  });

  it("serializes Blend Mode for both a created node and an appearance update", () => {
    const node = { ...createNode("rectangle", 10, 20), id, blendMode: "multiply" as const };
    const created = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    const updated = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([node], [{ type: "update", id, patch: { blendMode: "screen" } }])!.batch));

    expect(created.operations[0].createNode?.node?.blendMode).toBe(BlendMode.BLEND_MODE_MULTIPLY);
    expect(updated.operations[2].setAppearance?.blendMode).toBe(BlendMode.BLEND_MODE_SCREEN);
  });

  it("serializes a live BooleanOperation selector on the created structural node", () => {
    const node = { ...createNode("booleanOperation", 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000", booleanOperation: "subtract" as const };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));

    expect(batch.operations[0].createNode?.node).toMatchObject({
      nodeId: idBytes(id), kind: NodeKind.NODE_KIND_BOOLEAN_OPERATION, booleanOperation: 3,
    });
  });

  it("serializes a Boolean selector change as a dedicated replayable operation", () => {
    const node = { ...createNode("booleanOperation", 10, 20), id, booleanOperation: "exclude" as const };
    const firstOperand = { ...createNode("rectangle", 10, 20), id: "00000000-0000-4000-8000-000000000002", parentId: id };
    const secondOperand = { ...createNode("rectangle", 30, 20), id: "00000000-0000-4000-8000-000000000003", parentId: id };
    const batch = ResolvedOperationBatch.decode(
      encodeCoreBatchPayload(resolveCoreBatch([node, firstOperand, secondOperand], [{ type: "update", id, patch: { booleanOperation: "exclude" } }])!.batch),
    );

    expect(batch.operations.find((operation) => operation.setBooleanOperation)?.setBooleanOperation).toEqual({
      nodeId: idBytes(id),
      operation: 4,
    });
  });

  it("serializes the G4 alpha-mask flag as a dedicated replayable operation", () => {
    const mask = { ...createNode("rectangle", 10, 20), id };
    const target = { ...createNode("rectangle", 30, 20), id: "00000000-0000-4000-8000-000000000002" };
    const batch = ResolvedOperationBatch.decode(
      encodeCoreBatchPayload(resolveCoreBatch([mask, target], [{ type: "setMask", id, enabled: true }])!.batch),
    );

    expect(batch.operations[0].setMask).toEqual({ nodeId: idBytes(id), enabled: true });
  });

  it("serializes a canonical Drop Shadow on create and inspector update", () => {
    const dropShadow = { offsetX: 4, offsetY: 8, blurRadius: 12, spread: 2, color: { space: "srgb" as const, components: [0, 0, 0] as [number, number, number], alpha: .25 }, visible: true };
    const node = { ...createNode("rectangle", 10, 20), id, dropShadow };
    const created = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    const updated = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([node], [{ type: "update", id, patch: { dropShadow } }])!.batch));
    expect(created.operations[0].createNode?.node?.dropShadow).toMatchObject({ offsetX: 4, offsetY: 8, blurRadius: 12, spread: 2, visible: true, color: { alpha: .25 } });
    expect(created.operations[0].createNode?.node?.effectStack).toEqual([expect.objectContaining({ dropShadow: expect.objectContaining({ offsetX: 4, offsetY: 8 }) })]);
    expect(updated.operations[2].setAppearance?.dropShadow).toMatchObject({ offsetX: 4, offsetY: 8, blurRadius: 12, spread: 2, visible: true, color: { alpha: .25 } });
    expect(updated.operations[2].setAppearance?.effectStack).toEqual([expect.objectContaining({ dropShadow: expect.objectContaining({ blurRadius: 12 }) })]);
  });

  it("serializes Layer Blur in the ordered Effect Stack", () => {
    const node = { ...createNode("rectangle", 10, 20), id, effectStack: [{ layerBlur: { radius: 24, visible: true } }] };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));

    expect(batch.operations[0].createNode?.node?.effectStack).toEqual([{ layerBlur: { radius: 24, visible: true } }]);
  });

  it("serializes Inner Shadow in the ordered Effect Stack", () => {
    const innerShadow = { offsetX: -3, offsetY: 5, blurRadius: 10, spread: 1, color: { space: "srgb" as const, components: [0, 0, 0] as [number, number, number], alpha: .32 }, visible: true };
    const node = { ...createNode("rectangle", 10, 20), id, effectStack: [{ innerShadow }] };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));

    expect(batch.operations[0].createNode?.node?.effectStack).toEqual([{ innerShadow: expect.objectContaining({ offsetX: -3, blurRadius: 10, visible: true }) }]);
  });

  it("serializes Background Blur in the ordered Effect Stack", () => {
    const node = { ...createNode("rectangle", 10, 20), id, effectStack: [{ backgroundBlur: { radius: 18, visible: true } }] };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));

    expect(batch.operations[0].createNode?.node?.effectStack).toEqual([{ backgroundBlur: { radius: 18, visible: true } }]);
  });

  it("serializes a Section and its content visibility state", () => {
    const node = { ...createNode("section", 10, 20), id, contentsHidden: true };
    const resolved = resolveCoreBatch([], [{ type: "create", node }]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));

    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_SECTION, contentsHidden: true });
  });

  it("serializes four independent radii only for supported closed nodes", () => {
    const rectangle = { ...createNode("rectangle", 10, 20), id, cornerRadii: [4, 8, 12, 16] as [number, number, number, number], cornerSmoothing: .6 };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node: rectangle }])!.batch));
    expect(batch.operations[0].createNode?.node).toMatchObject({ cornerRadii: [4, 8, 12, 16], cornerSmoothing: .6 });

    const line = { ...createNode("line", 10, 20), id, cornerRadii: [4, 8, 12, 16] as [number, number, number, number], cornerSmoothing: .6 };
    expect(() => encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node: line }])!.batch)).toThrow("Per-corner radii");
  });

  it("serializes ordered fill and stroke paint stacks while retaining legacy paint fields", () => {
    const node = {
      ...createNode("rectangle", 10, 20), id,
      fills: [{ css: "#e6edff" }, { css: "#0048ff" }],
      strokes: [{ css: "#000000" }, { css: "#2563eb" }],
    };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    expect(batch.operations[0].createNode?.node).toMatchObject({
      fill: { solid: expect.anything() }, stroke: { solid: expect.anything() },
      fills: [{ solid: expect.anything() }, { solid: expect.anything() }],
      strokes: [{ solid: expect.anything() }, { solid: expect.anything() }],
    });
  });

  it("preserves a linear-gradient paint layer with its ordered stops", () => {
    const gradient = {
      start: [0, 0] as [number, number], end: [1, 1] as [number, number], stops: [
        { position: 0, color: { space: "srgb" as const, components: [0.1, 0.2, 0.3] as [number, number, number], alpha: 1 } },
        { position: .6, color: { space: "display-p3" as const, components: [0.4, 0.7, 0.2] as [number, number, number], alpha: .75 } },
        { position: 1, color: { space: "srgb" as const, components: [0.9, 0.8, 0.1] as [number, number, number], alpha: .5 } },
      ],
    };
    const node = { ...createNode("rectangle", 10, 20), id, fills: [{ css: "#1a334d", gradient }] };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));

    const encoded = batch.operations[0].createNode?.node?.fills[0]?.linearGradient;
    expect(encoded).toMatchObject({ startX: 0, startY: 0, endX: 1, endY: 1 });
    expect(encoded?.stops).toHaveLength(3);
    expect(encoded?.stops.map((stop) => stop.color?.space)).toEqual([1, 2, 1]);
    expect(encoded?.stops.map((stop) => stop.position)).toEqual([0, expect.closeTo(.6, 6), 1]);
    expect(encoded?.stops[1]?.color).toMatchObject({ red: expect.closeTo(.4, 6), green: expect.closeTo(.7, 6), blue: expect.closeTo(.2, 6), alpha: .75 });
  });

  it("serializes a Frame clip-content choice while defaulting new Frames to clipping", () => {
    const clipped = { ...createNode("frame", 10, 20), id };
    const unclipped = { ...clipped, clipsContent: false };
    const clippedBatch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node: clipped }])!.batch));
    const unclippedBatch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node: unclipped }])!.batch));

    expect(clippedBatch.operations[0].createNode?.node?.clipsContent).toBe(true);
    expect(unclippedBatch.operations[0].createNode?.node?.clipsContent).toBe(false);
  });

  it("serializes Auto Layout as an explicit replayable Frame operation", () => {
    const autoLayout = {
      mode: "horizontal" as const, padding: [4, 8, 12, 16] as [number, number, number, number], itemSpacing: 10, wrap: true,
      primaryAlignment: "spaceBetween" as const, counterAlignment: "center" as const,
      primarySizing: "fixed" as const, counterSizing: "fixed" as const,
      minWidth: 120, maxHeight: 320, absolute: false,
    };
    const node = { ...createNode("frame", 10, 20), id, autoLayout };
    const created = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    const updated = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([node], [{ type: "update", id, patch: { autoLayout: { ...autoLayout, wrap: false, mode: "vertical" } } }])!.batch));

    expect(created.operations[0].createNode?.node?.autoLayout).toMatchObject({ mode: LayoutMode.LAYOUT_MODE_HORIZONTAL, paddingTop: 4, paddingLeft: 16, itemSpacing: 10, wrap: true });
    expect(created.operations[1].setAutoLayout?.autoLayout).toMatchObject({ primaryAlignment: LayoutAlignment.LAYOUT_ALIGNMENT_SPACE_BETWEEN, counterAlignment: LayoutAlignment.LAYOUT_ALIGNMENT_CENTER, primarySizing: LayoutSizing.LAYOUT_SIZING_FIXED, minWidth: 120, maxHeight: 320 });
    expect(updated.operations.find((operation) => operation.setAutoLayout)?.setAutoLayout?.autoLayout).toMatchObject({ mode: LayoutMode.LAYOUT_MODE_VERTICAL, wrap: false });
  });

  it("does not coerce hydrated null Auto Layout bounds to a zero-size constraint", () => {
    const node = {
      ...createNode("frame", 10, 20), id,
      autoLayout: {
        mode: "vertical" as const, padding: [0, 0, 0, 0] as [number, number, number, number], itemSpacing: 0, wrap: false,
        primaryAlignment: "start" as const, counterAlignment: "start" as const, primarySizing: "fixed" as const, counterSizing: "fixed" as const,
        minWidth: null as unknown as number, maxWidth: null as unknown as number, minHeight: null as unknown as number, maxHeight: null as unknown as number, absolute: false,
      },
    };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    expect(batch.operations.find((operation) => operation.setAutoLayout)?.setAutoLayout?.autoLayout).toMatchObject({
      minWidth: undefined, maxWidth: undefined, minHeight: undefined, maxHeight: undefined,
    });
  });

  it("serializes Figma-compatible Frame constraints with the node appearance", () => {
    const node = { ...createNode("rectangle", 10, 20), id, constraints: { horizontal: "stretch" as const, vertical: "center" as const } };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    expect(batch.operations[0].createNode?.node?.constraints).toEqual({ horizontal: ConstraintType.CONSTRAINT_TYPE_STRETCH, vertical: ConstraintType.CONSTRAINT_TYPE_CENTER });
  });

  it("serializes an optional parent-relative transform and rejects singular matrices", () => {
    const node = {
      ...createNode("rectangle", 10, 20), id,
      relativeTransform: { a: 0, b: 1, c: -1, d: 0, e: 20, f: 30 },
    };
    const resolved = resolveCoreBatch([], [{ type: "create", node }]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));
    expect(batch.operations[0].createNode?.node?.relativeTransform).toEqual(node.relativeTransform);

    const singular = resolveCoreBatch([], [{ type: "create", node: { ...node, relativeTransform: { ...node.relativeTransform, a: 0, b: 0, c: 0, d: 0 } } }]);
    expect(() => encodeCoreBatchPayload(singular!.batch)).toThrow("Relative transform");
  });

  it("persists Arrow as a Line with an ArrowLines end cap", () => {
    const node = { ...createNode("line", 10, 20), id, strokeCapEnd: "arrowLines" as const };
    const resolved = resolveCoreBatch([], [{ type: "create", node }]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));

    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_LINE, strokeCapStart: StrokeCap.STROKE_CAP_NONE, strokeCapEnd: StrokeCap.STROKE_CAP_ARROW_LINES });
  });

  it("serializes Frame/Rectangle per-side stroke weights and rejects them for Line", () => {
    const rectangle = { ...createNode("rectangle", 10, 20), id, strokeWeights: [1, 2, 3, 4] as [number, number, number, number], strokeAlign: "outside" as const };
    const resolved = resolveCoreBatch([], [{ type: "create", node: rectangle }]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));
    expect(batch.operations[0].createNode?.node).toMatchObject({ strokeWeights: [1, 2, 3, 4], strokeAlign: StrokeAlign.STROKE_ALIGN_OUTSIDE });

    const line = { ...createNode("line", 10, 20), id, strokeWeights: [1, 2, 3, 4] as [number, number, number, number] };
    const lineBatch = resolveCoreBatch([], [{ type: "create", node: line }]);
    expect(() => encodeCoreBatchPayload(lineBatch!.batch)).toThrow("Per-side stroke weights");
  });

  it("keeps a full inspector update atomic through canonical leaf operations", () => {
    const node = { ...createNode("text", 10, 20), id, text: "before" };
    const resolved = resolveCoreBatch([node], [{ type: "update", id, patch: { name: "Headline", x: 44, text: "after" } }]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));
    expect(batch.operations.map((operation) => Object.keys(operation).find((key) => operation[key as keyof typeof operation] !== undefined))).toEqual(["updateGeometry", "renameNode", "setAppearance", "setText", "setTextProperties"]);
    expect(batch.operations[3].setText).toMatchObject({ nodeId: idBytes(id), text: "after" });
    expect(batch.operations[4].setTextProperties?.properties).toMatchObject({ autoSize: 1, paragraph: { alignment: 1 } });
    expect(batch.operations[4].setTextProperties?.properties?.paragraph?.lineHeight).toBe(20);
  });

  it("serializes an image fill with the rest of a shape update", () => {
    const assetId = "00000000-0000-0000-0000-00000000000b";
    const node = { ...createNode("rectangle", 10, 20), id, assetId };
    const resolved = resolveCoreBatch([node], [{ type: "update", id, patch: { assetId } }]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));

    expect(batch.operations.map((operation) => Object.keys(operation).find((key) => operation[key as keyof typeof operation] !== undefined))).toEqual(["updateGeometry", "renameNode", "setAppearance", "setImageFill"]);
    expect(batch.operations[3].setImageFill).toEqual({ nodeId: idBytes(id), assetId: idBytes(assetId) });
  });

  it("serializes Polygon and Star parameters as canonical protobuf fields", () => {
    const polygon = { ...createNode("polygon", 10, 20), id };
    const star = { ...createNode("star", 10, 20), id: "00000000-0000-0000-0000-000000000003" };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload([
      { type: "create", node: { ...polygon, cornerRadius: polygon.radius, text: "" } },
      { type: "create", node: { ...star, cornerRadius: star.radius, text: "" } },
    ]));
    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_POLYGON, polygonParameters: { pointCount: 5 } });
    expect(batch.operations[1].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_STAR, starParameters: { pointCount: 5, innerRatio: .5 } });
  });

  it("serializes a VectorPath on create and as an atomic update operation", () => {
    const vector = { ...createNode("vector", 10, 20), id };
    const created = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node: vector }])!.batch));
    const updated = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([vector], [{ type: "update", id, patch: { vectorPath: { ...vector.vectorPath!, fillRule: "evenOdd" } } }])!.batch));

    expect(created.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_VECTOR, vectorPath: { fillRule: 1 } });
    expect(created.operations[0].createNode?.node?.vectorPath?.subpaths[0]).toMatchObject({ closed: true, points: expect.arrayContaining([expect.objectContaining({ pointType: 1 })]) });
    expect(updated.operations.map((operation) => Object.keys(operation).find((key) => operation[key as keyof typeof operation] !== undefined))).toEqual(["updateGeometry", "renameNode", "setAppearance", "setVectorPath"]);
    expect(updated.operations[3].setVectorPath).toMatchObject({ nodeId: idBytes(id), vectorPath: { fillRule: 2 } });
  });

  it("serializes named Vector point edits without replacing the path", () => {
    const vector = { ...createNode("vector", 10, 20), id };
    const pointId = vector.vectorPath!.subpaths[0].points[1].id;
    const resolved = resolveCoreBatch([vector], [
      { type: "moveVectorPoint", id, pointId, x: 170, y: 12 },
      { type: "setVectorSubpathClosed", id, subpathIndex: 0, closed: false },
    ]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));

    expect(batch.operations).toEqual([
      { moveVectorPoint: { nodeId: idBytes(id), pointId: idBytes(pointId), x: 170, y: 12 } },
      { setVectorSubpathClosed: { nodeId: idBytes(id), subpathIndex: 0, closed: false } },
    ]);
    expect(resolved?.nextNodes[0].vectorPath?.subpaths[0]).toMatchObject({ closed: false, points: expect.arrayContaining([expect.objectContaining({ id: pointId, x: 170, y: 12 })]) });
  });

  it("serializes point insertion and deletion as stable-id operations", () => {
    const vector = { ...createNode("vector", 10, 20), id };
    const afterPointId = vector.vectorPath!.subpaths[0].points[0].id;
    const insertedId = "00000000-0000-4000-8000-000000000099";
    const resolved = resolveCoreBatch([vector], [
      { type: "insertVectorPoint", id, subpathIndex: 0, afterPointId, point: { id: insertedId, x: 120, y: 30, pointType: "corner" } },
      { type: "deleteVectorPoint", id, pointId: insertedId },
    ]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));

    expect(batch.operations).toEqual([
      { insertVectorPoint: { nodeId: idBytes(id), subpathIndex: 0, afterPointId: idBytes(afterPointId), point: { pointId: idBytes(insertedId), x: 120, y: 30, handleInX: undefined, handleInY: undefined, handleOutX: undefined, handleOutY: undefined, pointType: 1 } } },
      { deleteVectorPoint: { nodeId: idBytes(id), pointId: idBytes(insertedId) } },
    ]);
  });

  it("serializes a segment split as a named canonical operation", () => {
    const vector = { ...createNode("vector", 10, 20), id };
    const afterPointId = vector.vectorPath!.subpaths[0].points[0].id;
    const pointId = "00000000-0000-4000-8000-00000000009a";
    const resolved = resolveCoreBatch([vector], [{ type: "splitVectorSegment", id, subpathIndex: 0, afterPointId, t: .5, pointId }]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));

    expect(batch.operations).toEqual([{ splitVectorSegment: { nodeId: idBytes(id), subpathIndex: 0, afterPointId: idBytes(afterPointId), t: .5, pointId: idBytes(pointId) } }]);
    expect(resolved?.nextNodes[0].vectorPath?.subpaths[0].points).toHaveLength(4);
  });

  it("serializes endpoint connections as named canonical operations", () => {
    const vector = { ...createNode("vector", 10, 20), id };
    const second = structuredClone(vector.vectorPath!.subpaths[0]);
    second.closed = false;
    second.points = second.points.map((point, index) => ({ ...point, id: `00000000-0000-4000-8000-00000000010${index + 1}` }));
    vector.vectorPath = { ...vector.vectorPath!, subpaths: [{ ...vector.vectorPath!.subpaths[0], closed: false }, second] };
    const firstPointId = vector.vectorPath.subpaths[0].points.at(-1)!.id;
    const secondPointId = vector.vectorPath.subpaths[1].points[0].id;
    const resolved = resolveCoreBatch([vector], [{ type: "connectVectorEndpoints", id, firstSubpathIndex: 0, firstPointId, secondSubpathIndex: 1, secondPointId }]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));

    expect(batch.operations).toEqual([{ connectVectorEndpoints: { nodeId: idBytes(id), firstSubpathIndex: 0, firstPointId: idBytes(firstPointId), secondSubpathIndex: 1, secondPointId: idBytes(secondPointId) } }]);
  });

  it("serializes tangent-handle edits without replacing the vector path", () => {
    const vector = { ...createNode("vector", 10, 20), id };
    const pointId = vector.vectorPath!.subpaths[0].points[1].id;
    const resolved = resolveCoreBatch([vector], [{
      type: "setVectorPointHandles",
      id,
      pointId,
      handleIn: { x: -18, y: 6 },
      handleOut: { x: 24, y: -8 },
      pointType: "asymmetric",
    }]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));

    expect(batch.operations).toEqual([{
      setVectorPointHandles: {
        nodeId: idBytes(id), pointId: idBytes(pointId),
        handleInX: -18, handleInY: 6, handleOutX: 24, handleOutY: -8,
        pointType: 3,
      },
    }]);
    expect(resolved?.nextNodes[0].vectorPath?.subpaths[0].points[1]).toMatchObject({
      id: pointId, handleIn: { x: -18, y: 6 }, handleOut: { x: 24, y: -8 }, pointType: "asymmetric",
    });
  });

  it("keeps a continued open-path Pen stroke ordered as one insertion batch", () => {
    const defaultVector = createNode("vector", 10, 20);
    const vector = { ...defaultVector, id, vectorPath: { ...defaultVector.vectorPath!, subpaths: [{ ...defaultVector.vectorPath!.subpaths[0], closed: false }] } };
    const endPointId = vector.vectorPath!.subpaths[0].points.at(-1)!.id;
    const firstId = "00000000-0000-4000-8000-0000000000a1";
    const secondId = "00000000-0000-4000-8000-0000000000a2";
    const resolved = resolveCoreBatch([vector], [
      { type: "insertVectorPoint", id, subpathIndex: 0, afterPointId: endPointId, point: { id: firstId, x: 220, y: 150, pointType: "corner" } },
      { type: "insertVectorPoint", id, subpathIndex: 0, afterPointId: firstId, point: { id: secondId, x: 260, y: 140, handleIn: { x: -16, y: 4 }, handleOut: { x: 16, y: -4 }, pointType: "mirrored" } },
      { type: "setVectorSubpathClosed", id, subpathIndex: 0, closed: true },
    ]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));

    expect(batch.operations.slice(0, 2).map((operation) => operation.insertVectorPoint?.afterPointId)).toEqual([idBytes(endPointId), idBytes(firstId)]);
    expect(batch.operations[2].setVectorSubpathClosed).toEqual({ nodeId: idBytes(id), subpathIndex: 0, closed: true });
    expect(resolved?.nextNodes[0].vectorPath?.subpaths[0]).toMatchObject({ closed: true });
    expect(resolved?.nextNodes[0].vectorPath?.subpaths[0].points.slice(-2)).toMatchObject([
      { id: firstId, x: 220, y: 150 },
      { id: secondId, handleIn: { x: -16, y: 4 }, handleOut: { x: 16, y: -4 }, pointType: "mirrored" },
    ]);
  });

  it("serializes a layer reorder as a dedicated canonical operation", () => {
    const node = { ...createNode("rectangle", 10, 20), id, positionId: "00000000000000000000000000000001:00000000000000000000000000000000" };
    const positionId = "ffffffffffffffffffffffffffffffff:00000000000000000000000000000007";
    const resolved = resolveCoreBatch([node], [{ type: "reposition", positionIds: [{ id, positionId }] }]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));
    expect(batch.operations).toEqual([{ setNodePosition: { nodeId: idBytes(id), positionId: { key: idBytes("ffffffffffffffffffffffffffffffff"), actorId: idBytes("00000000000000000000000000000007") } } }]);
  });

  it("serializes a resolved parent move without changing geometry", () => {
    const groupId = "00000000-0000-0000-0000-00000000000a";
    const positionId = "0000000000000000000000000000000b:00000000000000000000000000000000";
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload([{ type: "reparent", parentIds: [{ id, parentId: groupId, positionId }] }]));
    expect(batch.operations).toEqual([{ setNodeParent: { nodeId: idBytes(id), parentId: idBytes(groupId), positionId: { key: idBytes("0000000000000000000000000000000b"), actorId: idBytes("00000000000000000000000000000000") } } }]);
  });

  it("creates rich text followed by a separately hashable style operation", () => {
    const node = {
      ...createNode("text", 10, 20), id, text: "A😀B",
      textProperties: {
        runs: [{ start: 0, end: 6, fontSize: 18, fontWeight: 700, italic: false, letterSpacing: 0 }],
        paragraph: { alignment: "center" as const, paragraphSpacing: 4 },
        autoSize: "height" as const,
      },
    };
    const resolved = resolveCoreBatch([], [{ type: "create", node }]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));
    expect(batch.operations.map((operation) => Object.keys(operation).find((key) => operation[key as keyof typeof operation] !== undefined))).toEqual(["createNode", "setTextProperties"]);
    expect(batch.operations[0].createNode?.node?.textProperties).toBeUndefined();
    expect(batch.operations[1].setTextProperties?.properties).toMatchObject({ autoSize: 2, paragraph: { alignment: 2 }, runs: [{ start: 0, end: 6, fontSize: 18, fontWeight: 700 }] });
  });

  it("passes an unknown-extension payload through the generated node encode byte-for-byte (P0-2)", () => {
    const extensions = { "com.figma.phase3.motion": [0, 1, 2, 250, 255], "vendor.blob": [42] };
    const node = { ...createNode("rectangle", 10, 20), id, extensions };
    const resolved = resolveCoreBatch([], [{ type: "create", node }]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));

    const decoded = batch.operations[0].createNode?.node?.extensions;
    expect(decoded && Object.keys(decoded).sort()).toEqual(["com.figma.phase3.motion", "vendor.blob"]);
    expect(decoded && [...decoded["com.figma.phase3.motion"]]).toEqual([0, 1, 2, 250, 255]);
    expect(decoded && [...decoded["vendor.blob"]]).toEqual([42]);
  });

  it("serializes a tombstone restore as a distinct history operation", () => {
    const node = { ...createNode("rectangle", 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000" };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload([{ type: "restore", node: { ...node, cornerRadius: node.radius, text: "" } }]));
    expect(batch.operations).toEqual([{ restoreNode: { node: expect.objectContaining({ nodeId: idBytes(id), name: node.name }) } }]);
  });

  it("serializes page creation through the same generated operation batch", () => {
    const page = { id: "00000000-0000-0000-0000-00000000000a", name: "Ideas", positionId: "0000000000000000000000000000000a:00000000000000000000000000000000" };
    const batch = ResolvedOperationBatch.decode(encodeCreatePagePayload(page));
    expect(batch.operations).toEqual([{ createPage: { page: { pageId: idBytes(page.id), name: "Ideas", positionId: { key: idBytes("0000000000000000000000000000000a"), actorId: idBytes("00000000000000000000000000000000") } } } }]);
  });

  it("serializes admitted asset metadata as a distinct, byte-free resource operation", () => {
    const assetId = "00000000-0000-0000-0000-00000000000b";
    const hash = "ab".repeat(32);
    const batch = ResolvedOperationBatch.decode(encodeRegisterResourcePayload({ assetId, contentHash: hash, mediaType: "image/png", byteLength: 128, pixelWidth: 16, pixelHeight: 8 }));
    expect(batch.operations).toEqual([{ registerResource: { resource: { assetId: idBytes(assetId), contentHash: Uint8Array.from(Array(32).fill(0xab)), mediaType: "image/png", byteLength: "128", pixelWidth: 16, pixelHeight: 8 } } }]);
  });

  it("keeps a resource registration ahead of its pasted image in one operation batch", () => {
    const assetId = "00000000-0000-0000-0000-00000000000c";
    const image = { ...createNode("image", 10, 20), id, assetId };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload([
      { type: "registerAsset", asset: { assetId, contentHash: "cd".repeat(32), mediaType: "image/png", byteLength: 128, pixelWidth: 16, pixelHeight: 8 } },
      { type: "create", node: { ...image, cornerRadius: image.radius, text: "" } },
    ]));

    expect(batch.operations[0].registerResource?.resource).toMatchObject({ assetId: idBytes(assetId), contentHash: Uint8Array.from(Array(32).fill(0xcd)) });
    expect(batch.operations[1].createNode?.node).toMatchObject({ nodeId: idBytes(id), assetId: idBytes(assetId), kind: NodeKind.NODE_KIND_IMAGE });
  });
});
