import { describe, expect, it } from "vitest";
import { createNode, type DocumentAsset } from "./editor-protocol";
import { captureClipboard } from "./transaction-batch";
import { decodeNodeClipboard, encodeNodeClipboard, MAX_CLIPBOARD_DEPTH, validateClipboardCapture } from "./editor-clipboard";

const documentId = "00000000-0000-0000-0000-000000000001";
const image = { ...createNode("image", 0, 0), id: "00000000-0000-4000-8000-000000000001", assetId: "asset-image" };
const assets: DocumentAsset[] = [{ assetId: "asset-image", contentHash: "a".repeat(64), mediaType: "image/png", byteLength: 42 }, { assetId: "font-main", contentHash: "b".repeat(64), mediaType: "font/woff2", byteLength: 42 }];

describe("versioned node clipboard", () => {
  it("round-trips an authenticated payload without resource bytes", async () => {
    const capture = captureClipboard([image], [image.id], 19)!;
    const encoded = await encodeNodeClipboard(capture, { documentId, pageId: "page-1" }, assets);
    expect(encoded).toContain("makefigma-node-clipboard-v1");
    expect(encoded).not.toContain("data:image");
    await expect(decodeNodeClipboard(encoded!, 19)).resolves.toMatchObject({ sourceDocumentId: documentId, sourcePageId: "page-1", clipboard: { rootIds: [image.id], assetIds: ["asset-image"] } });
    await expect(decodeNodeClipboard(encoded!, 19)).resolves.toMatchObject({ clipboard: { assetContentHashes: { "asset-image": "a".repeat(64) } } });
    await expect(decodeNodeClipboard(encoded!, 19)).resolves.toMatchObject({ clipboard: { resourceAssets: [{ assetId: "asset-image", contentHash: "a".repeat(64), mediaType: "image/png", byteLength: 42 }] } });
  });

  it("keeps accepting a signed v1 envelope written before resource metadata existed", async () => {
    const capture = captureClipboard([image], [image.id], 19)!;
    const legacy = {
      format: "makefigma-node-clipboard-v1",
      schemaVersion: 19,
      sourceDocumentId: documentId,
      rootIds: capture.rootIds,
      nodes: capture.nodes,
      assets: [{ assetId: "asset-image", contentHash: "a".repeat(64) }],
      fonts: [],
    };
    const payload = JSON.stringify({ ...legacy, payloadSha256: await digest(JSON.stringify(legacy)) });
    const decoded = await decodeNodeClipboard(payload, 19);
    expect(decoded?.clipboard.assetIds).toEqual(["asset-image"]);
    expect(decoded?.clipboard.resourceAssets).toBeUndefined();
  });

  it("rejects a changed payload, newer schema, cycles and over-deep trees", async () => {
    const capture = captureClipboard([image], [image.id], 19)!;
    const encoded = await encodeNodeClipboard(capture, { documentId }, assets);
    const tampered = encoded!.replace("asset-image", "asset-other");
    await expect(decodeNodeClipboard(tampered, 19)).resolves.toBeUndefined();
    await expect(decodeNodeClipboard(encoded!, 20)).resolves.toMatchObject({ clipboard: { schemaVersion: 19 } });
    await expect(decodeNodeClipboard(encoded!, 18)).resolves.toBeUndefined();
    expect(validateClipboardCapture({ ...capture, nodes: [{ ...image, parentId: image.id }] })).toBe("INVALID_TREE");
    const chain = Array.from({ length: MAX_CLIPBOARD_DEPTH + 1 }, (_, index) => ({ ...createNode("rectangle", 0, 0), id: `node-${index}`, parentId: index ? `node-${index - 1}` : undefined }));
    expect(validateClipboardCapture({ schemaVersion: 19, rootIds: ["node-0"], nodes: chain, assetIds: [] })).toBe("RESOURCE_LIMIT");
    expect(validateClipboardCapture({ schemaVersion: 19, rootIds: ["root"], nodes: [{ ...createNode("frame", 0, 0), id: "root", parentId: "child" }, { ...createNode("rectangle", 0, 0), id: "child", parentId: "root" }], assetIds: [] })).toBe("INVALID_TREE");
  });

  it("allows a captured subtree root to retain its source-only parent", () => {
    const child = { ...image, parentId: "source-frame" };
    expect(validateClipboardCapture({ schemaVersion: 19, rootIds: [child.id], nodes: [child], assetIds: ["asset-image"] })).toBeUndefined();
  });

  it("requires target authorization for font references as well as images", () => {
    const text = { ...createNode("text", 0, 0), id: "text-1", textProperties: { runs: [{ start: 0, end: 14, font: { assetId: "font-main", faceIndex: 0 }, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 }], paragraph: { alignment: "left" as const, paragraphSpacing: 0 }, autoSize: "fixed" as const } };
    const captured = captureClipboard([text], [text.id], 19)!;
    expect(captured.assetIds).toEqual(["font-main"]);
    expect(validateClipboardCapture({ ...captured, assetIds: [] })).toBe("INVALID_TREE");
  });

  it("accepts every current Phase 2 node kind before a paste reaches the Core batch", () => {
    const kinds = ["frame", "group", "section", "rectangle", "ellipse", "polygon", "star", "vector", "booleanOperation", "slice", "line", "text", "image"] as const;
    const nodes = kinds.map((kind, index) => ({
      ...createNode(kind, index * 10, index * 10),
      id: `00000000-0000-4000-8000-${(index + 1).toString().padStart(12, "0")}`,
    }));
    expect(validateClipboardCapture({ schemaVersion: 19, rootIds: nodes.map((node) => node.id), nodes, assetIds: [] })).toBeUndefined();
  });
});

async function digest(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
