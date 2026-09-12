import { describe, expect, it } from "vitest";
import { RuntimeSession } from "./runtime-session";
import { RuntimeContainerNodeProxy } from "./container-node-proxy";
import type { PendingProjectionTransaction, RuntimeProjection } from "./runtime-projection-store";
import type { RuntimeTransactionResult, RuntimeTransactionTransport } from "./runtime-transaction-client";
import { isRuntimeError } from "./runtime-errors";
import { vi } from "vitest";
import { createNode } from "../lib/editor-protocol";

const initial: RuntimeProjection = {
  revision: 0,
  nodes: [
    { id: "document", type: "DOCUMENT", name: "Document" },
    { id: "page", type: "PAGE", name: "Page 1", parentId: "document", siblingIndex: 0 },
    { id: "frame", type: "FRAME", name: "Existing frame", parentId: "page", x: 0, y: 0, width: 100, height: 100, rotation: 0, opacity: 1, siblingIndex: 0 },
  ],
};

describe("M1 RuntimeSession", () => {
  it("keeps one proxy identity and coalesces synchronous setters into one fenced transaction", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const frame = await session.getNodeByIdAsync("frame");
    expect(frame).not.toBeNull();
    expect(session.root.findOne((node) => node.id === "frame")).toBe(frame);

    frame!.x = 120;
    frame!.y = 240;
    frame!.opacity = .5;
    expect(frame!.x).toBe(120);
    expect(frame!.y).toBe(240);
    expect(await session.commitAsync()).toBe(1);
    expect(transport.submitted).toHaveLength(1);
    expect(transport.submitted[0]!.operations).toHaveLength(3);
    expect(frame!.opacity).toBe(.5);
  });

  it("supports synchronous creation, reparenting, pre-order queries, and clone before Ack", () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const frame = session.createFrame();
    const text = session.createText();
    frame.appendChild(text);
    const clone = text.clone();

    expect(text.parent).toBe(frame);
    expect(frame.children).toEqual([text, clone]);
    expect(session.currentPage.findAll(() => true).map((node) => node.id)).toEqual(["frame", frame.id, text.id, clone.id]);
    expect(clone.parent).toBe(frame);
    expect(clone.name).toBe("Text copy");
  });

  it("emits one structural operation for each appended child in a coalesced transaction", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const frame = session.createFrame();
    const first = session.createRectangle();
    const second = session.createText();

    frame.appendChild(first);
    frame.appendChild(second);
    await session.commitAsync();

    const reparentedIds = transport.submitted[0]!.operations
      .filter((operation) => operation.type === "update" && typeof operation.patch.parentId === "string")
      .map((operation) => operation.nodeId);
    expect(reparentedIds).toEqual([first.id, second.id]);
  });

  it("exposes the supported Auto Layout frame declaration synchronously", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const frame = session.createFrame();
    frame.layoutMode = "VERTICAL";
    frame.paddingTop = 20;
    frame.paddingRight = 16;
    frame.paddingBottom = 20;
    frame.paddingLeft = 16;
    frame.itemSpacing = 12;

    expect(frame.layoutMode).toBe("VERTICAL");
    expect(frame.paddingTop).toBe(20);
    expect(frame.itemSpacing).toBe(12);
    await session.commitAsync();
    const update = transport.submitted[0]!.operations.at(-1);
    expect(update).toMatchObject({
      type: "update",
      patch: {
        autoLayout: {
          mode: "vertical",
          padding: [20, 16, 20, 16],
          itemSpacing: 12,
        },
      },
    });
  });

  it("does not revive a stale proxy when a deleted canonical ID is restored by Undo", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const oldFrame = (await session.getNodeByIdAsync("frame"))!;
    oldFrame.remove();
    await session.commitAsync();
    expect(oldFrame.removed).toBe(true);
    expect(oldFrame.type).toBe("FRAME");

    session.applyConfirmedProjection({ revision: 2, nodes: initial.nodes });
    const restored = (await session.getNodeByIdAsync("frame"))!;
    expect(restored).not.toBe(oldFrame);
    expect(restored.handle.generation).toBe(oldFrame.handle.generation + 1);
    expect(isRuntimeError(captureError(() => oldFrame.x), "NODE_REMOVED")).toBe(true);
  });

  it("rolls failed batches back and invalidates every proxy after close", async () => {
    const transport = new InMemoryTransport(initial, true);
    const session = sessionFor(transport);
    const frame = (await session.getNodeByIdAsync("frame"))!;
    frame.x = 20;
    expect(isRuntimeError(await captureRejection(() => session.commitAsync()), "REVISION_CONFLICT")).toBe(true);
    expect(frame.x).toBe(0);

    await session.closeAsync();
    expect(isRuntimeError(captureError(() => frame.x), "RUNTIME_CLOSED")).toBe(true);
  });

  it("uses the browser-compatible default microtask scheduler without losing its invocation context", async () => {
    const transport = new InMemoryTransport(initial);
    const session = new RuntimeSession({
      sessionId: "default-scheduler",
      projection: initial,
      transport,
      createId: () => "new-rectangle",
    });
    expect(() => session.createRectangle()).not.toThrow();
    await session.commitAsync();
    expect(transport.submitted).toHaveLength(1);
  });

  it("gates text changes on the affected font and preserves UTF-16 range semantics", async () => {
    const font = { assetId: "font-1", faceIndex: 0 };
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document", fontAvailability: { "font-1": "idle" } },
        { id: "page", type: "PAGE", name: "Page", parentId: "document" },
        {
          id: "text",
          type: "TEXT",
          name: "Text",
          parentId: "page",
          characters: "A😀中",
          textProperties: {
            runs: [{ start: 0, end: 8, font, fontSize: 14, fontWeight: 400, italic: false, letterSpacing: 0 }],
            paragraph: { alignment: "left", paragraphSpacing: 0 },
            autoSize: "fixed",
          },
        },
      ],
    };
    const session = new RuntimeSession({ sessionId: "font-gate", projection, transport: new InMemoryTransport(projection), scheduleMicrotask: () => {} });
    const text = (await session.getNodeByIdAsync("text"))!;
    expect(isRuntimeError(captureError(() => { text.characters = "A界中"; }), "FONT_NOT_LOADED")).toBe(true);

    session.applyConfirmedProjection({
      revision: 1,
      nodes: projection.nodes.map((node) => node.id === "document" ? { ...node, fontAvailability: { "font-1": "ready" } } : node),
    });
    text.setRangeFontSize(1, 3, 20);
    expect(text.characters).toBe("A😀中");
    const transactionId = session.projectionStore.pendingTransactionIds()[0]!;
    const operation = session.projectionStore.transaction(transactionId)?.operations.at(-1);
    expect(operation).toMatchObject({ type: "update", nodeId: "text" });
    if (!operation || operation.type !== "update") throw new Error("Expected text update operation");
    expect((operation.patch.textProperties as { runs: Array<{ start: number; end: number; fontSize: number }> }).runs[1]).toMatchObject({ start: 1, end: 5, fontSize: 20 });
  });

  it("requires explicit page loads before dynamic-document traversal", async () => {
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document" },
        { id: "page-1", type: "PAGE", parentId: "document", name: "Page 1" },
        { id: "page-2", type: "PAGE", parentId: "document", name: "Page 2" },
        { id: "one", type: "RECTANGLE", parentId: "page-1", pageId: "page-1", name: "One", x: 0, y: 0 },
        { id: "two", type: "RECTANGLE", parentId: "page-2", pageId: "page-2", name: "Two", x: 0, y: 0 },
      ],
    };
    const session = new RuntimeSession({
      sessionId: "dynamic-pages",
      projection,
      currentPageId: "page-1",
      documentAccess: "dynamic-page",
      transport: new InMemoryTransport(projection),
      scheduleMicrotask: () => {},
    });
    expect((await session.getNodeByIdAsync("two"))).toBeNull();
    expect(isRuntimeError(captureError(() => session.root.findAll(() => true)), "PAGE_NOT_LOADED")).toBe(true);

    const secondPage = session.root.children.find((node) => node.id === "page-2");
    if (!(secondPage instanceof RuntimeContainerNodeProxy)) throw new Error("Second page is unavailable");
    await secondPage.loadAsync();
    expect((await session.getNodeByIdAsync("two"))?.id).toBe("two");
    expect(session.root.findAll(() => true).map((node) => node.id)).toEqual(["page-1", "one", "page-2", "two"]);

    await session.loadAllPagesAsync();
    expect(session.root.findAll(() => true).map((node) => node.id)).toEqual(["page-1", "one", "page-2", "two"]);
    await session.setCurrentPageAsync(secondPage);
    expect(session.currentPage.id).toBe("page-2");
  });

  it("admits an image before registering it and binds its immutable hash to a node", async () => {
    const registered: Array<{ assetId: string; bytes: Uint8Array }> = [];
    const transport = new InMemoryTransport(initial) as InMemoryTransport & { registerAssetAsync: (asset: { assetId: string }, bytes: Uint8Array) => Promise<void> };
    transport.registerAssetAsync = async (asset, bytes) => { registered.push({ assetId: asset.assetId, bytes }); };
    const session = new RuntimeSession({
      sessionId: "image-resource",
      projection: initial,
      transport,
      scheduleMicrotask: () => {},
      admitImage: async (bytes) => ({ assetId: "image-1", contentHash: "a".repeat(64), mediaType: "image/png", byteLength: bytes.byteLength, pixelWidth: 24, pixelHeight: 16 }),
    });
    const image = await session.createImageAsync(Uint8Array.of(1, 2, 3), "image/png");
    expect(image).toEqual({ hash: "image-1", width: 24, height: 16 });
    expect(registered).toEqual([{ assetId: "image-1", bytes: Uint8Array.of(1, 2, 3) }]);
    const imageNode = session.createImageNode(image);
    imageNode.setImageAsset(image);
    expect(session.projectionStore.getNode(imageNode.id)).toMatchObject({ assetId: "image-1", type: "IMAGE" });
  });

  it("does not register an image when cancellation wins during admission", async () => {
    const registerAssetAsync = vi.fn(async () => undefined);
    const transport = new InMemoryTransport(initial) as InMemoryTransport & { registerAssetAsync: typeof registerAssetAsync };
    transport.registerAssetAsync = registerAssetAsync;
    const session = new RuntimeSession({
      sessionId: "cancel-image",
      projection: initial,
      transport,
      scheduleMicrotask: () => {},
      admitImage: async (_bytes, _mime, signal) => await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    });
    const task = session.createImageTask(Uint8Array.of(1), "image/png");
    task.cancel();
    await expect(task.promise).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "TASK_CANCELLED"));
    expect(registerAssetAsync).not.toHaveBeenCalled();
  });

  it("shares ordered page selection state between sessions on one transport", async () => {
    const listeners = new Set<(state: { activePageId: string; selectedIds: readonly string[]; viewport: { x: number; y: number; zoom: number } }) => void>();
    const transport = new InMemoryTransport(initial) as InMemoryTransport & {
      subscribeViewState: (listener: (state: { activePageId: string; selectedIds: readonly string[]; viewport: { x: number; y: number; zoom: number } }) => void) => () => void;
      setSelectionAsync: (ids: readonly string[]) => Promise<void>;
    };
    transport.subscribeViewState = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
    transport.setSelectionAsync = async (ids) => listeners.forEach((listener) => listener({ activePageId: "page", selectedIds: ids, viewport: { x: 0, y: 0, zoom: 1 } }));
    const first = new RuntimeSession({ sessionId: "first", projection: initial, transport, scheduleMicrotask: () => {} });
    const second = new RuntimeSession({ sessionId: "second", projection: initial, transport, scheduleMicrotask: () => {} });
    const node = (await first.getNodeByIdAsync("frame"))!;
    const events: number[] = [];
    second.onViewStateChange((state) => events.push(state.sequence));

    await first.currentPage.setSelectionAsync([node]);
    expect(first.currentPage.selection.map((candidate) => candidate.id)).toEqual(["frame"]);
    expect(second.currentPage.selection.map((candidate) => candidate.id)).toEqual(["frame"]);
    expect(events).toEqual([...events].sort((left, right) => left - right));
  });

  it("lists admitted fonts and paginates a complete dynamic-document query", async () => {
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document", assets: [{ assetId: "font-1", contentHash: "f".repeat(64), mediaType: "font/ttf", byteLength: 10 }] },
        { id: "page-1", type: "PAGE", parentId: "document", name: "Page 1" },
        { id: "page-2", type: "PAGE", parentId: "document", name: "Page 2" },
        { id: "one", type: "RECTANGLE", parentId: "page-1", pageId: "page-1", name: "One" },
        { id: "two", type: "TEXT", parentId: "page-2", pageId: "page-2", name: "Two" },
      ],
    };
    const session = new RuntimeSession({ sessionId: "paged", projection, currentPageId: "page-1", documentAccess: "dynamic-page", transport: new InMemoryTransport(projection), scheduleMicrotask: () => {} });
    await expect(session.listAvailableFontsAsync()).resolves.toEqual([{ fontName: { family: "makefigma-asset-font1", style: "Regular" }, assetId: "font-1", faceIndex: 0 }]);
    const pages: string[][] = [];
    for await (const page of session.findAllNodesPagedAsync(2)) pages.push(page.map((node) => node.id));
    expect(pages).toEqual([["page-1", "one"], ["page-2", "two"]]);
  });

  it("cancels outstanding resource tasks when the session closes", async () => {
    const session = new RuntimeSession({
      sessionId: "close-tasks",
      projection: initial,
      transport: new InMemoryTransport(initial),
      scheduleMicrotask: () => {},
      admitImage: async (_bytes, _mime, signal) => await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    });
    const task = session.createImageTask(Uint8Array.of(1), "image/png");
    const outcome = task.promise.catch((error: unknown) => error);
    await session.closeAsync();
    expect(isRuntimeError(await outcome, "TASK_CANCELLED")).toBe(true);
  });

  it("exports SVG from a RevisionLease-frozen Canvas projection, never a pending overlay", async () => {
    const canvasRectangle = {
      ...createNode("rectangle", 10, 20),
      id: "exported-rectangle",
      pageId: "page",
      width: 40,
      height: 30,
      fill: "#0048ff",
      strokeWidth: 0,
    };
    const projection: RuntimeProjection = {
      revision: 7,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document" },
        { id: "page", type: "PAGE", parentId: "document", name: "Page" },
        { ...canvasRectangle, type: "RECTANGLE", parentId: "page" },
      ],
    };
    const session = new RuntimeSession({ sessionId: "export", projection, transport: new InMemoryTransport(projection), scheduleMicrotask: () => {} });
    const rectangle = (await session.getNodeByIdAsync(canvasRectangle.id))!;
    rectangle.x = 90;

    await expect(rectangle.exportAsync({ format: "SVG_STRING" })).resolves.toContain('matrix(1 0 0 1 10 20)');
    await expect(rectangle.exportAsync({ format: "SVG_STRING" })).resolves.not.toContain('matrix(1 0 0 1 90 20)');
    await expect(session.exportNodeSvgString("missing")).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "NODE_NOT_FOUND"));
  });

  it("rasterizes PNG from the same frozen SVG scene with an admitted scale", async () => {
    const canvasRectangle = { ...createNode("rectangle", 10, 20), id: "png-rectangle", pageId: "page", width: 40, height: 30, fill: "#0048ff", strokeWidth: 0 };
    const projection: RuntimeProjection = {
      revision: 7,
      nodes: [{ id: "document", type: "DOCUMENT", name: "Document" }, { id: "page", type: "PAGE", parentId: "document", name: "Page" }, { ...canvasRectangle, type: "RECTANGLE", parentId: "page" }],
    };
    const rasterizePng = vi.fn(async () => Uint8Array.of(137, 80, 78, 71));
    const session = new RuntimeSession({ sessionId: "png-export", projection, transport: new InMemoryTransport(projection), scheduleMicrotask: () => {}, rasterizePng });
    const rectangle = (await session.getNodeByIdAsync(canvasRectangle.id))!;
    rectangle.x = 90;

    await expect(rectangle.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } })).resolves.toEqual(Uint8Array.of(137, 80, 78, 71));
    expect(rasterizePng).toHaveBeenCalledWith(expect.objectContaining({ width: 72, height: 62, scale: 2, svg: expect.stringContaining('matrix(1 0 0 1 10 20)') }));
    await expect(rectangle.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 0 } })).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "INVALID_ARGUMENT"));
  });

  it("fences a resolved M5 CHANGE_TO reaction through the normal transaction path", async () => {
    const projection: RuntimeProjection = {
      ...initial,
      nodes: [...initial.nodes, { id: "variant", type: "COMPONENT", parentId: "page", name: "State=Hover" }],
    };
    const transport = new InMemoryTransport(projection);
    const session = new RuntimeSession({ sessionId: "change-to", projection, transport, scheduleMicrotask: () => {} });
    const frame = (await session.getNodeByIdAsync("frame"))!;
    await frame.setReactionsAsync([{ trigger: { type: "ON_CLICK" }, actions: [{ type: "CHANGE_TO", destinationId: "variant", transition: { type: "SMART_ANIMATE", duration: 100 } }] }]);
    expect(transport.submitted[0]?.operations).toEqual(expect.arrayContaining([expect.objectContaining({ type: "update", nodeId: "frame" })]));
    expect(frame.reactions[0]?.actions[0]).toMatchObject({ type: "CHANGE_TO", destinationId: "variant" });
  });
});

function sessionFor(transport: RuntimeTransactionTransport): RuntimeSession {
  let nextId = 0;
  return new RuntimeSession({
    sessionId: "session-1",
    projection: initial,
    transport,
    createId: () => `runtime-${nextId++}`,
    scheduleMicrotask: () => {},
  });
}

class InMemoryTransport implements RuntimeTransactionTransport {
  submitted: PendingProjectionTransaction[] = [];
  private projection: RuntimeProjection;

  constructor(initialProjection: RuntimeProjection, private readonly reject = false) {
    this.projection = structuredClone(initialProjection);
  }

  async submit(transaction: PendingProjectionTransaction): Promise<RuntimeTransactionResult> {
    this.submitted.push(transaction);
    if (this.reject) return { type: "rejected", errorCode: "REVISION_CONFLICT" };
    if (transaction.baseRevision !== this.projection.revision) return { type: "rejected", errorCode: "REVISION_CONFLICT" };
    const nodes = new Map(this.projection.nodes.map((node) => [node.id, structuredClone(node)]));
    for (const operation of transaction.operations) {
      if (operation.type === "create") nodes.set(operation.node.id, { ...structuredClone(operation.node), removed: false });
      else if (operation.type === "remove") nodes.delete(operation.nodeId);
      else {
        const node = nodes.get(operation.nodeId);
        if (!node) return { type: "rejected", errorCode: "TRANSACTION_ABORTED" };
        nodes.set(operation.nodeId, { ...node, ...structuredClone(operation.patch) });
      }
    }
    this.projection = { revision: this.projection.revision + 1, nodes: [...nodes.values()] };
    return { type: "accepted", acceptedRevision: this.projection.revision, projection: this.projection };
  }
}

function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected action to throw.");
}

async function captureRejection(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected action to reject.");
}
