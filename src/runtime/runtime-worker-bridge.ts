import { createId, type DocumentAsset, type DocumentAutoLayout, type EditorSnapshot, type EditorTransaction, type MainToWorker, type WorkerToMain } from "../lib/editor-protocol";
import { figmaPluginNodeType } from "../lib/figma-plugin-node-projection";
import { runtimeError } from "./runtime-errors";
import type { PendingProjectionTransaction, RuntimeProjection, RuntimeProjectionNode } from "./runtime-projection-store";
import type { RuntimeTransactionResult, RuntimeTransactionTransport } from "./runtime-transaction-client";

export function runtimeProjectionFromEditorSnapshot(snapshot: EditorSnapshot): RuntimeProjection {
  const documentId = runtimeDocumentNodeId(snapshot.documentId);
  return {
    revision: snapshot.revision,
    nodes: [
      {
        id: documentId,
        type: "DOCUMENT",
        name: "Document",
        assets: snapshot.assets ?? [],
        fontAvailability: snapshot.fontAvailability ?? {},
        selectedIds: snapshot.selectedIds,
      },
      ...snapshot.pages.map((page, siblingIndex) => ({
        id: page.id,
        type: "PAGE",
        parentId: documentId,
        name: page.name,
        siblingIndex,
      })),
      ...snapshot.nodes.flatMap((node) => {
        const type = node.kind === "image" ? "IMAGE" : figmaPluginNodeType(node.kind);
        if (!type) return [];
        const parentId = node.parentId ?? node.pageId ?? snapshot.activePageId;
        return [{
          ...node,
          type,
          parentId,
          siblingIndex: siblingIndexFor(snapshot, node.id, parentId),
          characters: node.text,
        }];
      }),
    ],
  };
}

export function runtimeDocumentNodeId(documentId: string): string {
  return `runtime-document:${documentId}`;
}

/** Bridges the existing worker's separate Ack and Snapshot messages into the
 * Runtime's single fence-aware transport result. Integrators should call
 * observe() for every WorkerToMain message before updating presentation state. */
export class RuntimeWorkerBridge implements RuntimeTransactionTransport {
  private readonly waiting = new Map<string, {
    resolve: (value: RuntimeTransactionResult) => void;
    reject: (reason?: unknown) => void;
    acceptedRevision?: number;
  }>();
  private readonly snapshots = new Map<number, RuntimeProjection>();
  private readonly pageIds = new Set<string>();
  private readonly fontLoadWaiters = new Map<string, { resolve: () => void; reject: (reason?: unknown) => void; timeoutId: ReturnType<typeof setTimeout> }>();
  private readonly assetRegistrationWaiters = new Map<string, { assetId: string; resolve: () => void; reject: (reason?: unknown) => void; timeoutId: ReturnType<typeof setTimeout> }>();
  private readonly pageWaiters = new Map<string, { resolve: () => void; reject: (reason?: unknown) => void; timeoutId: ReturnType<typeof setTimeout> }>();
  private readonly selectionWaiters: Array<{ ids: readonly string[]; resolve: () => void; reject: (reason?: unknown) => void; timeoutId: ReturnType<typeof setTimeout> }> = [];
  private readonly viewStateListeners = new Set<(state: RuntimeWorkerViewState) => void>();
  private latestSnapshot?: EditorSnapshot;

  constructor(private readonly post: (message: MainToWorker) => void) {}

  get hasPendingTransactions(): boolean {
    return this.waiting.size > 0;
  }

  submit(transaction: PendingProjectionTransaction): Promise<RuntimeTransactionResult> {
    if (this.waiting.has(transaction.transactionId)) throw runtimeError("INVALID_ARGUMENT", { transactionId: transaction.transactionId });
    const message: EditorTransaction = {
      id: transaction.transactionId,
      baseRevision: transaction.baseRevision,
      commands: transactionToEditorCommands(transaction.operations, this.pageIds),
    };
    return new Promise<RuntimeTransactionResult>((resolve, reject) => {
      this.waiting.set(transaction.transactionId, { resolve, reject });
      try {
        this.post({ type: "transaction", transaction: message });
      } catch (error) {
        this.waiting.delete(transaction.transactionId);
        reject(error);
      }
    });
  }

  observe(message: WorkerToMain): void {
    if (message.type === "snapshot") {
      this.latestSnapshot = message.snapshot;
      this.pageIds.clear();
      message.snapshot.pages.forEach((page) => this.pageIds.add(page.id));
      const projection = runtimeProjectionFromEditorSnapshot(message.snapshot);
      this.snapshots.set(projection.revision, projection);
      while (this.snapshots.size > 32) this.snapshots.delete(this.snapshots.keys().next().value!);
      for (const [transactionId, waiter] of this.waiting) {
        if (waiter.acceptedRevision === projection.revision) this.resolveAccepted(transactionId, waiter, projection);
      }
      this.settleFontLoads(message.snapshot);
      this.settleAssetRegistrations(message.snapshot);
      this.settlePageLoad(message.snapshot);
      return;
    }
    if (message.type === "view-state") {
      const state: RuntimeWorkerViewState = { activePageId: message.activePageId, selectedIds: message.selectedIds, viewport: message.viewport };
      this.viewStateListeners.forEach((listener) => listener(state));
      this.settleSelection(message.selectedIds);
      return;
    }
    if (message.type === "error") {
      if (message.transactionId) {
        const waiter = this.assetRegistrationWaiters.get(message.transactionId);
        if (waiter) {
          clearTimeout(waiter.timeoutId);
          this.assetRegistrationWaiters.delete(message.transactionId);
          waiter.reject(runtimeError(message.code === "RESOURCE_LIMIT" ? "RESOURCE_LIMIT" : "RESOURCE_UNAVAILABLE", { transactionId: message.transactionId }));
        }
      }
      return;
    }
    if (message.type !== "ack") return;
    const waiter = this.waiting.get(message.transactionId);
    if (!waiter) return;
    if (message.errorCode) {
      this.waiting.delete(message.transactionId);
      waiter.resolve({ type: "rejected", errorCode: message.errorCode === "REVISION_CONFLICT" ? "REVISION_CONFLICT" : message.errorCode === "RESOURCE_LIMIT" ? "RESOURCE_LIMIT" : "TRANSACTION_ABORTED" });
      return;
    }
    if (message.acceptedRevision === undefined) {
      this.waiting.delete(message.transactionId);
      waiter.reject(runtimeError("INTERNAL_ERROR", { transactionId: message.transactionId }));
      return;
    }
    waiter.acceptedRevision = message.acceptedRevision;
    const projection = this.snapshots.get(message.acceptedRevision);
    if (projection) this.resolveAccepted(message.transactionId, waiter, projection);
  }

  close(reason = runtimeError("RUNTIME_CLOSED")): void {
    for (const waiter of this.waiting.values()) waiter.reject(reason);
    this.waiting.clear();
    this.snapshots.clear();
    for (const waiter of this.fontLoadWaiters.values()) {
      clearTimeout(waiter.timeoutId);
      waiter.reject(reason);
    }
    this.fontLoadWaiters.clear();
    for (const waiter of this.assetRegistrationWaiters.values()) {
      clearTimeout(waiter.timeoutId);
      waiter.reject(reason);
    }
    this.assetRegistrationWaiters.clear();
    for (const waiter of this.pageWaiters.values()) {
      clearTimeout(waiter.timeoutId);
      waiter.reject(reason);
    }
    this.pageWaiters.clear();
    this.selectionWaiters.splice(0).forEach((waiter) => {
      clearTimeout(waiter.timeoutId);
      waiter.reject(reason);
    });
  }

  subscribeViewState(listener: (state: RuntimeWorkerViewState) => void): () => void {
    this.viewStateListeners.add(listener);
    return () => this.viewStateListeners.delete(listener);
  }

  setCurrentPageAsync(pageId: string, timeoutMs = 10_000): Promise<void> {
    if (!pageId) return Promise.reject(runtimeError("INVALID_ARGUMENT"));
    if (this.latestSnapshot?.activePageId === pageId) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timeoutId = globalThis.setTimeout(() => {
        if (!this.pageWaiters.has(pageId)) return;
        this.pageWaiters.delete(pageId);
        reject(runtimeError("TIMEOUT"));
      }, timeoutMs);
      this.pageWaiters.set(pageId, { resolve, reject, timeoutId });
      try { this.post({ type: "command", command: { type: "select-page", id: pageId } }); }
      catch (error) { clearTimeout(timeoutId); this.pageWaiters.delete(pageId); reject(error); }
    });
  }

  setSelectionAsync(ids: readonly string[], timeoutMs = 10_000): Promise<void> {
    if (new Set(ids).size !== ids.length || ids.some((id) => !id)) return Promise.reject(runtimeError("INVALID_ARGUMENT"));
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        ids: [...ids], resolve, reject,
        timeoutId: globalThis.setTimeout(() => {
          const index = this.selectionWaiters.indexOf(waiter);
          if (index >= 0) this.selectionWaiters.splice(index, 1);
          reject(runtimeError("TIMEOUT"));
        }, timeoutMs),
      };
      this.selectionWaiters.push(waiter);
      try { this.post({ type: "command", command: { type: "select", ids: [...ids] } }); }
      catch (error) {
        clearTimeout(waiter.timeoutId);
        this.selectionWaiters.splice(this.selectionWaiters.indexOf(waiter), 1);
        reject(error);
      }
    });
  }

  /** Loads an admitted font in the real Worker and resolves only after its
   * subsequent Snapshot reports the FontFace as ready. */
  loadFontAsync(assetId: string, timeoutMs = 10_000): Promise<void> {
    const current = this.latestSnapshot;
    const asset = current?.assets?.find((candidate) => candidate.assetId === assetId);
    if (!current || !asset || !asset.mediaType.startsWith("font/")) return Promise.reject(runtimeError("RESOURCE_UNAVAILABLE"));
    const status = current.fontAvailability?.[assetId] ?? "idle";
    if (status === "ready") return Promise.resolve();
    if (status === "unavailable") return Promise.reject(runtimeError("RESOURCE_UNAVAILABLE"));
    const existing = this.fontLoadWaiters.get(assetId);
    if (existing) return new Promise<void>((resolve, reject) => {
      const previousResolve = existing.resolve;
      const previousReject = existing.reject;
      existing.resolve = () => { previousResolve(); resolve(); };
      existing.reject = (reason) => { previousReject(reason); reject(reason); };
    });
    return new Promise<void>((resolve, reject) => {
      const timeoutId = globalThis.setTimeout(() => {
        if (this.fontLoadWaiters.get(assetId)?.timeoutId !== timeoutId) return;
        this.fontLoadWaiters.delete(assetId);
        reject(runtimeError("TIMEOUT"));
      }, timeoutMs);
      this.fontLoadWaiters.set(assetId, { resolve, reject, timeoutId });
      try {
        this.post({ type: "load-font", assetId });
      } catch (error) {
        clearTimeout(timeoutId);
        this.fontLoadWaiters.delete(assetId);
        reject(error);
      }
    });
  }

  /** Registers only validated metadata in Core, then seeds the corresponding
   * transient bytes for Worker-side decode. The promise is fenced by the
   * Snapshot that first exposes the Resource Index record. */
  registerAssetAsync(asset: DocumentAsset, bytes: Uint8Array, timeoutMs = 10_000): Promise<void> {
    if (!asset.assetId || !asset.contentHash || !asset.mediaType || asset.byteLength !== bytes.byteLength) {
      return Promise.reject(runtimeError("INVALID_ARGUMENT"));
    }
    if (this.latestSnapshot?.assets?.some((candidate) => candidate.assetId === asset.assetId)) {
      this.post({ type: "asset-bytes", assetId: asset.assetId, mediaType: asset.mediaType, bytes: bytes.slice().buffer });
      return Promise.resolve();
    }
    const transactionId = createId();
    return new Promise<void>((resolve, reject) => {
      const timeoutId = globalThis.setTimeout(() => {
        if (!this.assetRegistrationWaiters.has(transactionId)) return;
        this.assetRegistrationWaiters.delete(transactionId);
        reject(runtimeError("TIMEOUT", { transactionId }));
      }, timeoutMs);
      this.assetRegistrationWaiters.set(transactionId, { assetId: asset.assetId, resolve, reject, timeoutId });
      try {
        this.post({ type: "register-asset", transactionId, asset });
        this.post({ type: "asset-bytes", assetId: asset.assetId, mediaType: asset.mediaType, bytes: bytes.slice().buffer });
      } catch (error) {
        clearTimeout(timeoutId);
        this.assetRegistrationWaiters.delete(transactionId);
        reject(error);
      }
    });
  }

  private resolveAccepted(
    transactionId: string,
    waiter: { resolve: (value: RuntimeTransactionResult) => void; acceptedRevision?: number },
    projection: RuntimeProjection,
  ): void {
    this.waiting.delete(transactionId);
    waiter.resolve({ type: "accepted", acceptedRevision: projection.revision, projection });
  }

  private settleFontLoads(snapshot: EditorSnapshot): void {
    for (const [assetId, waiter] of this.fontLoadWaiters) {
      const status = snapshot.fontAvailability?.[assetId] ?? "idle";
      if (status !== "ready" && status !== "unavailable") continue;
      clearTimeout(waiter.timeoutId);
      this.fontLoadWaiters.delete(assetId);
      if (status === "ready") waiter.resolve();
      else waiter.reject(runtimeError("RESOURCE_UNAVAILABLE"));
    }
  }

  private settleAssetRegistrations(snapshot: EditorSnapshot): void {
    for (const [transactionId, waiter] of this.assetRegistrationWaiters) {
      if (!snapshot.assets?.some((asset) => asset.assetId === waiter.assetId)) continue;
      clearTimeout(waiter.timeoutId);
      this.assetRegistrationWaiters.delete(transactionId);
      waiter.resolve();
    }
  }

  private settlePageLoad(snapshot: EditorSnapshot): void {
    const waiter = this.pageWaiters.get(snapshot.activePageId);
    if (!waiter) return;
    clearTimeout(waiter.timeoutId);
    this.pageWaiters.delete(snapshot.activePageId);
    waiter.resolve();
  }

  private settleSelection(ids: readonly string[]): void {
    for (let index = this.selectionWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.selectionWaiters[index]!;
      if (waiter.ids.length !== ids.length || waiter.ids.some((id, position) => ids[position] !== id)) continue;
      clearTimeout(waiter.timeoutId);
      this.selectionWaiters.splice(index, 1);
      waiter.resolve();
    }
  }
}

export type RuntimeWorkerViewState = Readonly<{ activePageId: string; selectedIds: readonly string[]; viewport: Readonly<{ x: number; y: number; zoom: number }> }>;

function transactionToEditorCommands(
  operations: PendingProjectionTransaction["operations"],
  pageIds: ReadonlySet<string>,
): EditorTransaction["commands"] {
  const created = new Map<string, RuntimeProjectionNode>();
  const createdOrder: string[] = [];
  const remaining: PendingProjectionTransaction["operations"][number][] = [];

  for (const operation of operations) {
    if (operation.type === "create") {
      if (created.has(operation.node.id)) throw runtimeError("INVALID_ARGUMENT", { nodeId: operation.node.id });
      created.set(operation.node.id, structuredClone(operation.node));
      createdOrder.push(operation.node.id);
      continue;
    }
    if (operation.type === "update") {
      const node = created.get(operation.nodeId);
      if (node) {
        Object.assign(node, structuredClone(operation.patch));
        continue;
      }
    }
    if (operation.type === "remove" && created.delete(operation.nodeId)) continue;
    remaining.push(operation);
  }

  return [
    ...createdOrder.flatMap((nodeId) => {
      const node = created.get(nodeId);
      return node ? toEditorCommands({ type: "create", node }, pageIds) : [];
    }),
    ...remaining.flatMap((operation) => toEditorCommands(operation, pageIds)),
  ];
}

function toEditorCommands(
  operation: PendingProjectionTransaction["operations"][number],
  pageIds: ReadonlySet<string>,
): EditorTransaction["commands"] {
  if (operation.type === "remove") return [{ type: "delete", ids: [operation.nodeId] }];
  if (operation.type === "update") {
    const patch = structuredClone(operation.patch) as Record<string, unknown>;
    const parentId = patch.parentId;
    const characters = patch.characters;
    delete patch.parentId;
    delete patch.siblingIndex;
    delete patch.characters;
    if (typeof characters === "string") patch.text = characters;
    const commands: EditorTransaction["commands"] = [];
    if (typeof parentId === "string") commands.push({ type: "reparent", ids: [operation.nodeId], parentId: pageIds.has(parentId) ? undefined : parentId });
    if (Object.keys(patch).length) commands.push({ type: "update", id: operation.nodeId, patch });
    return commands;
  }
  const kind = editorKind(operation.node.type);
  if (!kind) throw runtimeError("UNSUPPORTED_NODE_TYPE", { nodeId: operation.node.id });
  const node = structuredClone(operation.node) as Record<string, unknown>;
  const characters = node.characters;
  const autoLayout = node.autoLayout;
  const assetId = node.assetId;
  const reactions = node.reactions;
  const prototypeMetadata = node.prototypeMetadata;
  delete node.type;
  delete node.removed;
  delete node.siblingIndex;
  delete node.characters;
  delete node.reactions;
  delete node.prototypeMetadata;
  const runtimeParentId = typeof node.parentId === "string" ? node.parentId : undefined;
  const pageId = typeof node.pageId === "string"
    ? node.pageId
    : runtimeParentId && pageIds.has(runtimeParentId)
      ? runtimeParentId
      : undefined;
  return [{
    type: "create",
    node: {
      id: operation.node.id,
      kind,
      x: numberOr(node.x, 0),
      y: numberOr(node.y, 0),
      width: numberOr(node.width, kind === "line" ? 160 : 100),
      height: numberOr(node.height, kind === "line" ? 0 : 100),
      rotation: numberOr(node.rotation, 0),
      name: typeof node.name === "string" ? node.name : kind,
      fill: "transparent",
      stroke: "transparent",
      radius: 0,
      strokeWidth: 0,
      opacity: numberOr(node.opacity, 1),
      visible: node.visible !== false,
      // Preserve the Runtime's sibling order for a batch of new nodes. The
      // position key is stable by sibling index; the UUID actor keeps concurrent
      // allocations at the same key distinct without randomising local order.
      positionId: positionIdFor(operation.node),
      ...(runtimeParentId && !pageIds.has(runtimeParentId) ? { parentId: runtimeParentId } : {}),
      ...(pageId ? { pageId } : {}),
      ...(typeof characters === "string" ? { text: characters } : {}),
      ...(autoLayout && typeof autoLayout === "object" ? { autoLayout: autoLayout as DocumentAutoLayout } : {}),
      ...(typeof assetId === "string" ? { assetId } : {}),
      ...(Array.isArray(reactions) ? { reactions } : {}),
      ...(prototypeMetadata && typeof prototypeMetadata === "object" ? { prototypeMetadata } : {}),
    },
  }];
}

function siblingIndexFor(snapshot: EditorSnapshot, nodeId: string, parentId: string): number {
  let index = 0;
  for (const node of snapshot.nodes) {
    const siblingParentId = node.parentId ?? node.pageId ?? snapshot.activePageId;
    if (siblingParentId !== parentId) continue;
    if (node.id === nodeId) return index;
    index += 1;
  }
  return index;
}

function editorKind(type: string): Extract<EditorTransaction["commands"][number], { type: "create" }> ["node"]["kind"] | undefined {
  const kinds = {
    FRAME: "frame",
    GROUP: "group",
    SECTION: "section",
    RECTANGLE: "rectangle",
    ELLIPSE: "ellipse",
    LINE: "line",
    TEXT: "text",
    IMAGE: "image",
  } as const;
  return kinds[type as keyof typeof kinds];
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positionIdFor(node: RuntimeProjectionNode): string {
  const siblingIndex = typeof node.siblingIndex === "number" && Number.isSafeInteger(node.siblingIndex) && node.siblingIndex >= 0
    ? node.siblingIndex
    : 0;
  // Keep ordinary Runtime-created layers in the midpoint range while making
  // the caller-visible sibling index the primary sort key.
  const key = (0x80000000000000000000000000000000n + BigInt(siblingIndex)).toString(16).padStart(32, "0");
  return `${key}:${node.id.replaceAll("-", "")}`;
}
