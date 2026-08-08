import { ConstraintType, NodeKind, ResolvedOperationBatch, StrokeAlign, StrokeCap } from "@makefigma/protocol-types";
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
});
