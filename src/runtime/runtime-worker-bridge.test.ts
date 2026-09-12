import { describe, expect, it } from "vitest";
import type { EditorSnapshot, MainToWorker } from "../lib/editor-protocol";
import { resolveCoreBatch } from "../lib/transaction-batch";
import { RuntimeWorkerBridge, runtimeProjectionFromEditorSnapshot } from "./runtime-worker-bridge";

describe("RuntimeWorkerBridge", () => {
  it("waits for both Worker Ack and the matching projection before accepting a transaction", async () => {
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    const pending = bridge.submit({
      transactionId: "tx-1",
      baseRevision: 4,
      operations: [{ type: "update", nodeId: "rect", patch: { x: 42 } }],
    });
    expect(bridge.hasPendingTransactions).toBe(true);
    bridge.observe({ type: "ack", transactionId: "tx-1", acceptedRevision: 5 });
    expect(posted[0]!.transaction.commands).toEqual([{ type: "update", id: "rect", patch: { x: 42 } }]);

    bridge.observe({ type: "snapshot", snapshot: snapshotAt(5) });
    await expect(pending).resolves.toMatchObject({ type: "accepted", acceptedRevision: 5, projection: { revision: 5 } });
    expect(bridge.hasPendingTransactions).toBe(false);
  });

  it("projects document/page ownership and omits non-Plugin IMAGE records", () => {
    const projection = runtimeProjectionFromEditorSnapshot(snapshotAt(4));
    expect(projection.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "DOCUMENT" }),
      expect.objectContaining({ id: "page", type: "PAGE" }),
      expect.objectContaining({ id: "rect", type: "RECTANGLE", parentId: "page" }),
    ]));
  });

  it("gives created nodes a deterministic Core layer position", async () => {
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot: snapshotAt(4) });
    void bridge.submit({
      transactionId: "tx-2",
      baseRevision: 4,
      operations: [{
        type: "create",
        node: { id: "00000000-0000-4000-8000-000000000002", type: "RECTANGLE", parentId: "page", name: "Card", x: 0, y: 0, width: 100, height: 80 },
      }],
    }).catch(() => undefined);

    expect(posted[0]!.transaction.commands[0]).toEqual(expect.objectContaining({
      type: "create",
      node: expect.objectContaining({ positionId: "80000000000000000000000000000000:00000000000040008000000000000002" }),
    }));
    expect(posted[0]!.transaction.commands[0]).toEqual(expect.objectContaining({
      node: expect.not.objectContaining({ parentId: "page" }),
    }));
    bridge.close();
  });

  it("maps an M1 frame create and setter batch to a concrete Core batch", () => {
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot: snapshotAt(4) });
    void bridge.submit({
      transactionId: "tx-3",
      baseRevision: 4,
      operations: [
        { type: "create", node: { id: "00000000-0000-4000-8000-000000000003", type: "FRAME", parentId: "page", name: "M1 card", x: 48, y: 64, width: 320, height: 180, autoLayout: { mode: "vertical", padding: [20, 16, 20, 16], itemSpacing: 12, wrap: false, primaryAlignment: "start", counterAlignment: "start", primarySizing: "fixed", counterSizing: "fixed", absolute: false } } },
        { type: "update", nodeId: "00000000-0000-4000-8000-000000000003", patch: { x: 49 } },
      ],
    }).catch(() => undefined);

    expect(resolveCoreBatch([
      { id: "00000000-0000-4000-8000-000000000001", pageId: "00000000-0000-0000-0000-000000000001", kind: "frame", name: "Product card", x: -250, y: -170, width: 500, height: 340, rotation: 0, fill: "#fbfbf8", stroke: "#d4d5cb", strokeWidth: 1, radius: 18, opacity: 1, visible: true },
      { id: "00000000-0000-4000-8000-000000000002", pageId: "00000000-0000-0000-0000-000000000001", kind: "ellipse", name: "Sun disc", x: -194, y: -112, width: 130, height: 130, rotation: 0, fill: "#f6ad62", stroke: "#b4612d", strokeWidth: 1, radius: 0, opacity: 1, visible: true },
    ], posted[0]!.transaction.commands)).toBeDefined();
    expect(posted[0]!.transaction.commands).toEqual([
      expect.objectContaining({
        type: "create",
        node: expect.objectContaining({
          id: "00000000-0000-4000-8000-000000000003",
          x: 49,
          autoLayout: expect.objectContaining({ mode: "vertical", itemSpacing: 12 }),
        }),
      }),
    ]);
    bridge.close();
  });

  it("waits for the Worker Snapshot that confirms an admitted font is ready", async () => {
    const posted: MainToWorker[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot: snapshotAt(4, { "font-1": "idle" }) });
    const loading = bridge.loadFontAsync("font-1");
    expect(posted).toContainEqual({ type: "load-font", assetId: "font-1" });
    bridge.observe({ type: "snapshot", snapshot: snapshotAt(4, { "font-1": "ready" }) });
    await expect(loading).resolves.toBeUndefined();
    bridge.close();
  });

  it("registers admitted image metadata before resolving the asset Snapshot fence", async () => {
    const posted: MainToWorker[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot: snapshotAt(4) });
    const asset = { assetId: "image-1", contentHash: "a".repeat(64), mediaType: "image/png", byteLength: 3, pixelWidth: 1, pixelHeight: 1 };
    const registered = bridge.registerAssetAsync(asset, Uint8Array.of(1, 2, 3));
    expect(posted).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "register-asset", asset }),
      expect.objectContaining({ type: "asset-bytes", assetId: "image-1", mediaType: "image/png" }),
    ]));
    bridge.observe({ type: "snapshot", snapshot: snapshotAt(5, undefined, [asset]) });
    await expect(registered).resolves.toBeUndefined();
    bridge.close();
  });

  it("fences selection writes on the matching shared Worker view-state", async () => {
    const posted: MainToWorker[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    const observed: string[][] = [];
    bridge.subscribeViewState((state) => observed.push([...state.selectedIds]));
    const selected = bridge.setSelectionAsync(["rect"]);
    expect(posted).toContainEqual({ type: "command", command: { type: "select", ids: ["rect"] } });
    bridge.observe({ type: "view-state", activePageId: "page", selectedIds: ["rect"], viewport: { x: 0, y: 0, zoom: 1 }, performance: { rollingInputToRenderMs: [], currentInputToRenderMs: 0, p95InputToRenderMs: 0, maxInputToRenderMs: 0, violationsOver100Ms: 0, renderSamples: 0, lastRenderMs: 0, p95RenderMs: 0, maxRenderMs: 0, gpuSceneBuildSamples: 0, lastGpuSceneBuildMs: 0, p95GpuSceneBuildMs: 0, maxGpuSceneBuildMs: 0 }, viewportChanged: false });
    await expect(selected).resolves.toBeUndefined();
    expect(observed).toEqual([["rect"]]);
    bridge.close();
  });
});

function snapshotAt(revision: number, fontAvailability?: EditorSnapshot["fontAvailability"], assets?: EditorSnapshot["assets"]): EditorSnapshot {
  return {
    documentId: "doc",
    revision,
    nodes: [{ id: "rect", kind: "rectangle", name: "Rectangle", x: 0, y: 0, width: 100, height: 80, rotation: 0, fill: "#fff", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1 }],
    assets: assets ?? (fontAvailability ? [{ assetId: "font-1", contentHash: "f".repeat(64), mediaType: "font/ttf", byteLength: 10 }] : []),
    fontAvailability,
    pages: [{ id: "page", name: "Page 1", positionId: "a" }],
    activePageId: "page",
    selectedIds: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    canUndo: false,
    canRedo: false,
    renderer: "Canvas 2D",
    documentCore: "Rust/WASM bridge ready",
  };
}
