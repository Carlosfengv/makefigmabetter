import { NodeKind, ResolvedOperationBatch } from "@makefigma/protocol-types";
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
