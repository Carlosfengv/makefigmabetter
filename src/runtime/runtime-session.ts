import { RuntimeContainerNodeProxy, type RuntimeContainerHost } from "./container-node-proxy";
import { NodeRegistry, type RuntimeNodeHandle } from "./node-registry";
import { M1_NODE_TYPES, RuntimeNodeProxy, type M1NodeType, type M1SceneNodeType } from "./node-proxy";
import { runtimeError } from "./runtime-errors";
import {
  RuntimeProjectionStore,
  type PendingProjectionOperation,
  type PendingProjectionTransaction,
  type RuntimeProjection,
  type RuntimeProjectionNode,
} from "./runtime-projection-store";
import { RuntimeTransactionClient, type RuntimeTransactionTransport } from "./runtime-transaction-client";
import { createId, type DocumentAsset, type DocumentFontReference } from "../lib/editor-protocol";
import type { RuntimeDocumentAccessMode } from "./runtime-capabilities";
import { probeAssetInWorker } from "../lib/asset-probe-client";
import { sha256Hex } from "../lib/sha256";
import { fontFamilyForAsset } from "../lib/font-face-registry";
import { RuntimeTask, type RuntimeTaskControl } from "./runtime-task";
import type { RuntimeWorkerViewState } from "./runtime-worker-bridge";
import { PrototypePlayer, type PrototypePlayerOptions } from "./prototype-player";
import { RevisionLeasePool, type RevisionLeaseResource } from "./revision-lease";
import { exportRuntimeNodeSvgResult, rasterizeRuntimePng, runtimePngScale, type RuntimePngExportSettings, type RuntimePngRasterizer } from "./runtime-svg-export";

const CONTAINER_TYPES = new Set<M1NodeType>(["DOCUMENT", "PAGE", "FRAME", "GROUP", "SECTION"]);
const CREATABLE_TYPES = new Set<M1SceneNodeType>(["FRAME", "GROUP", "SECTION", "RECTANGLE", "ELLIPSE", "LINE", "TEXT", "IMAGE"]);

export type RuntimeSessionOptions = Readonly<{
  sessionId: string;
  projection: RuntimeProjection;
  transport: RuntimeTransactionTransport;
  currentPageId?: string;
  rootNodeId?: string;
  createId?: () => string;
  scheduleMicrotask?: (flush: () => void) => void;
  maxSynchronousQueryNodes?: number;
  documentAccess?: RuntimeDocumentAccessMode;
  loadedPageIds?: readonly string[];
  admitImage?: (bytes: Uint8Array, declaredMime: string, signal: AbortSignal) => Promise<DocumentAsset>;
  rasterizePng?: RuntimePngRasterizer;
  onError?: (error: unknown) => void;
}>;

type RuntimeFontTransport = RuntimeTransactionTransport & {
  loadFontAsync?: (assetId: string, timeoutMs?: number) => Promise<void>;
  registerAssetAsync?: (asset: DocumentAsset, bytes: Uint8Array, timeoutMs?: number) => Promise<void>;
  setCurrentPageAsync?: (pageId: string, timeoutMs?: number) => Promise<void>;
  setSelectionAsync?: (ids: readonly string[], timeoutMs?: number) => Promise<void>;
  subscribeViewState?: (listener: (state: RuntimeWorkerViewState) => void) => () => void;
};

export type RuntimeImage = Readonly<{ hash: string; width: number; height: number }>;
export type RuntimeTaskOptions = Readonly<{ timeoutMs?: number }>;
export type RuntimeAvailableFont = Readonly<{ fontName: { family: string; style: string }; assetId: string; faceIndex: number }>;

/**
 * The M1 Runtime boundary. It owns session-local proxy identity and one
 * coalesced PendingProjection transaction per event turn; Canonical state
 * remains owned by the supplied transaction transport.
 */
export class RuntimeSession implements RuntimeContainerHost {
  readonly sessionId: string;
  readonly projectionStore: RuntimeProjectionStore;
  private readonly registry: NodeRegistry<RuntimeNodeProxy>;
  private readonly transactions: RuntimeTransactionClient;
  private readonly createId: () => string;
  private readonly scheduleMicrotask: (flush: () => void) => void;
  private readonly maxSynchronousQueryNodes: number;
  private readonly onError?: (error: unknown) => void;
  private readonly resourceTransport: RuntimeFontTransport;
  private readonly documentAccess: RuntimeDocumentAccessMode;
  private readonly loadedPageIds: Set<string>;
  private readonly admitImage: NonNullable<RuntimeSessionOptions["admitImage"]>;
  private readonly rasterizePng: RuntimePngRasterizer;
  private readonly tasks = new Set<RuntimeTask<unknown>>();
  private readonly players = new Set<PrototypePlayer>();
  private readonly playerLeasePool = new RevisionLeasePool<RuntimeProjection, RevisionLeaseResource>({ maxLeases: 8, maxUniqueResourceBytes: 256 * 1024 * 1024 });
  private readonly exportLeasePool = new RevisionLeasePool<RuntimeProjection, RevisionLeaseResource>({ maxLeases: 4, maxUniqueResourceBytes: 256 * 1024 * 1024 });
  private readonly viewStateListeners = new Set<(state: Readonly<{ sequence: number; currentPageId: string; selectedIds: readonly string[] }>) => void>();
  private selectionIds: string[] = [];
  private viewStateSequence = 0;
  private unsubscribeViewState?: () => void;
  private rootNodeId: string;
  private currentPageId: string;
  private queuedTransactionId?: string;
  private flushScheduled = false;
  private activeCommit?: Promise<number>;
  private closed = false;

  constructor(options: RuntimeSessionOptions) {
    if (!options.sessionId) throw runtimeError("INVALID_ARGUMENT");
    this.sessionId = options.sessionId;
    this.projectionStore = new RuntimeProjectionStore(options.projection);
    this.registry = new NodeRegistry<RuntimeNodeProxy>(options.sessionId);
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.scheduleMicrotask = options.scheduleMicrotask ?? ((flush) => queueMicrotask(flush));
    this.maxSynchronousQueryNodes = options.maxSynchronousQueryNodes ?? 10_000;
    this.onError = options.onError;
    this.resourceTransport = options.transport as RuntimeFontTransport;
    this.documentAccess = options.documentAccess ?? "full-document";
    this.rootNodeId = options.rootNodeId ?? nodeIdByType(this.projectionStore.listLiveNodes(), "DOCUMENT") ?? "";
    this.currentPageId = options.currentPageId ?? nodeIdByType(this.projectionStore.listLiveNodes(), "PAGE") ?? "";
    if (!this.rootNodeId || !this.currentPageId) throw runtimeError("INVALID_ARGUMENT");
    this.loadedPageIds = new Set(this.documentAccess === "full-document"
      ? this.pageIds()
      : options.loadedPageIds ?? [this.currentPageId]);
    this.loadedPageIds.add(this.currentPageId);
    this.admitImage = options.admitImage ?? admitRuntimeImage;
    this.rasterizePng = options.rasterizePng ?? rasterizeRuntimePng;
    this.reconcileRegistry();
    this.transactions = new RuntimeTransactionClient(this.projectionStore, options.transport, (projection) => {
      this.reconcileRegistry();
      this.players.forEach((player) => player.notifyEditorRevision(projection.revision));
      const page = this.projectionStore.getNode(this.currentPageId);
      if (!page || page.removed === true || page.type !== "PAGE") {
        const nextPage = nodeIdByType(projection.nodes, "PAGE");
        if (nextPage) this.currentPageId = nextPage;
      }
    });
    const initialSelection = this.projectionStore.getNode(this.rootNodeId)?.selectedIds;
    this.selectionIds = Array.isArray(initialSelection) ? initialSelection.filter((id): id is string => typeof id === "string") : [];
    this.unsubscribeViewState = this.resourceTransport.subscribeViewState?.((state) => this.applyWorkerViewState(state));
  }

  get root(): RuntimeContainerNodeProxy {
    return this.containerFor(this.rootNodeId);
  }

  get currentPage(): RuntimeContainerNodeProxy {
    return this.containerFor(this.currentPageId);
  }

  get confirmedRevision(): number {
    return this.projectionStore.confirmedRevision;
  }

  /** Project extension: M3 preview only reads its acquired frozen revision. */
  createPrototypePlayer(startFrameId?: string, options: Omit<PrototypePlayerOptions, "leasePool"> = {}): PrototypePlayer {
    this.assertOpen();
    const player = new PrototypePlayer({ ...options, leasePool: this.playerLeasePool }, this.projectionStore.confirmedProjection, startFrameId);
    this.players.add(player);
    return player;
  }

  /** M4D export always reads the confirmed projection. Pending synchronous
   * writes must cross the existing Ack + projection fence before export. */
  async exportNodeSvgString(nodeId: string): Promise<string> {
    return (await this.exportFrozenSvg(nodeId)).svg;
  }

  /** PNG rasterizes the same immutable SVG scene used by SVG_STRING. A
   * pending local overlay can therefore never leak into either target. */
  async exportNodePng(nodeId: string, settings: RuntimePngExportSettings): Promise<Uint8Array> {
    const scale = runtimePngScale(settings);
    const frozen = await this.exportFrozenSvg(nodeId);
    return this.rasterizePng({ svg: frozen.svg, width: frozen.width, height: frozen.height, scale });
  }

  private async exportFrozenSvg(nodeId: string) {
    this.assertOpen();
    const node = this.projectionStore.confirmedProjection.nodes.find((candidate) => candidate.id === nodeId && candidate.removed !== true);
    if (!node) throw runtimeError("NODE_NOT_FOUND", { nodeId });
    const pageId = this.pageIdFor(node);
    if (!pageId) throw runtimeError("EXPORT_FAILED", { nodeId, revision: this.confirmedRevision });
    return exportRuntimeNodeSvgResult(this.exportLeasePool, this.projectionStore.confirmedProjection, pageId, nodeId);
  }

  assertOpen(): void {
    if (this.closed) throw runtimeError("RUNTIME_CLOSED");
  }

  isCurrent(handle: RuntimeNodeHandle): boolean {
    return this.registry.isCurrent(handle);
  }

  readNode(handle: RuntimeNodeHandle): RuntimeProjectionNode | undefined {
    const node = this.projectionStore.getNode(handle.nodeId);
    return node && this.isNodeVisible(node) ? node : undefined;
  }

  hasLiveNode(nodeId: string): boolean {
    const node = this.projectionStore.getNode(nodeId);
    return Boolean(node && node.removed !== true && this.isNodeVisible(node));
  }

  assertFontsLoaded(fonts: readonly DocumentFontReference[]): void {
    this.assertOpen();
    const availability = this.projectionStore.getNode(this.rootNodeId)?.fontAvailability as Record<string, string> | undefined;
    if (fonts.some((font) => availability?.[font.assetId] !== "ready")) throw runtimeError("FONT_NOT_LOADED");
  }

  async loadFontAsync(font: DocumentFontReference, timeoutMs?: number): Promise<void> {
    this.assertOpen();
    if (!font.assetId || !Number.isSafeInteger(font.faceIndex) || font.faceIndex < 0) throw runtimeError("INVALID_ARGUMENT");
    const availability = this.projectionStore.getNode(this.rootNodeId)?.fontAvailability as Record<string, string> | undefined;
    if (availability?.[font.assetId] === "ready") return;
    if (!this.resourceTransport.loadFontAsync) throw runtimeError("RESOURCE_UNAVAILABLE");
    await this.resourceTransport.loadFontAsync(font.assetId, timeoutMs);
    this.assertFontsLoaded([font]);
  }

  async listAvailableFontsAsync(): Promise<readonly RuntimeAvailableFont[]> {
    this.assertOpen();
    await Promise.resolve();
    const assets = this.projectionStore.getNode(this.rootNodeId)?.assets;
    if (!Array.isArray(assets)) return [];
    return assets.flatMap((candidate): RuntimeAvailableFont[] => {
      if (!candidate || typeof candidate !== "object") return [];
      const asset = candidate as DocumentAsset;
      return asset.assetId && asset.mediaType.startsWith("font/")
        ? [{ fontName: { family: fontFamilyForAsset(asset.assetId), style: "Regular" }, assetId: asset.assetId, faceIndex: 0 }]
        : [];
    });
  }

  createImageTask(bytes: Uint8Array, declaredMime: string, options: RuntimeTaskOptions = {}): RuntimeTask<RuntimeImage> {
    this.assertOpen();
    if (!bytes.byteLength || !declaredMime.trim()) throw runtimeError("INVALID_ARGUMENT");
    const source = new Uint8Array(bytes);
    const task = new RuntimeTask(async ({ signal, seal }: RuntimeTaskControl) => {
      throwIfAborted(signal);
      const asset = await this.admitImage(source, declaredMime, signal);
      throwIfAborted(signal);
      if (!this.resourceTransport.registerAssetAsync) throw runtimeError("RESOURCE_UNAVAILABLE");
      // Registration changes Canonical state. From this point cancellation is
      // intentionally disabled: the task must observe its Snapshot fence.
      seal();
      await this.resourceTransport.registerAssetAsync(asset, source, options.timeoutMs);
      return { hash: asset.assetId, width: asset.pixelWidth ?? 0, height: asset.pixelHeight ?? 0 };
    }, options.timeoutMs);
    this.tasks.add(task as RuntimeTask<unknown>);
    void task.promise.finally(() => this.tasks.delete(task as RuntimeTask<unknown>)).catch(() => undefined);
    return task;
  }

  createImageAsync(bytes: Uint8Array, declaredMime: string, options?: RuntimeTaskOptions): Promise<RuntimeImage> {
    return this.createImageTask(bytes, declaredMime, options).promise;
  }

  getImageByHash(hash: string): RuntimeImage | null {
    this.assertOpen();
    const assets = this.projectionStore.getNode(this.rootNodeId)?.assets;
    if (!Array.isArray(assets)) return null;
    const asset = assets.find((candidate): candidate is DocumentAsset => Boolean(candidate) && typeof candidate === "object" && (candidate as DocumentAsset).assetId === hash);
    return asset ? { hash: asset.assetId, width: asset.pixelWidth ?? 0, height: asset.pixelHeight ?? 0 } : null;
  }

  /** Project extension: loads all pages before yielding bounded result pages,
   * so dynamic-page callers never receive a silently partial global query. */
  async *findAllNodesPagedAsync(pageSize = 100, predicate: (node: RuntimeNodeProxy) => boolean = () => true): AsyncIterable<readonly RuntimeNodeProxy[]> {
    this.assertOpen();
    if (!Number.isSafeInteger(pageSize) || pageSize <= 0) throw runtimeError("INVALID_ARGUMENT");
    await this.loadAllPagesAsync();
    const nodes = this.root.findAll(predicate);
    for (let index = 0; index < nodes.length; index += pageSize) yield nodes.slice(index, index + pageSize);
  }

  proxyFor(nodeId: string): RuntimeNodeProxy {
    this.assertOpen();
    const node = this.projectionStore.getNode(nodeId);
    if (!node) throw runtimeError("NODE_NOT_FOUND", { nodeId });
    if (node.removed === true) throw runtimeError("NODE_REMOVED", { nodeId });
    return this.registry.get(nodeId, (handle) => this.createProxy(handle));
  }

  async getNodeByIdAsync(nodeId: string): Promise<RuntimeNodeProxy | null> {
    this.assertOpen();
    const node = this.projectionStore.getNode(nodeId);
    return !node || node.removed === true || !this.isNodeVisible(node) ? null : this.proxyFor(nodeId);
  }

  createFrame(): RuntimeContainerNodeProxy { return this.createNode("FRAME") as RuntimeContainerNodeProxy; }
  createGroup(): RuntimeContainerNodeProxy { return this.createNode("GROUP") as RuntimeContainerNodeProxy; }
  createSection(): RuntimeContainerNodeProxy { return this.createNode("SECTION") as RuntimeContainerNodeProxy; }
  createRectangle(): RuntimeNodeProxy { return this.createNode("RECTANGLE"); }
  createEllipse(): RuntimeNodeProxy { return this.createNode("ELLIPSE"); }
  createLine(): RuntimeNodeProxy { return this.createNode("LINE"); }
  createText(): RuntimeNodeProxy { return this.createNode("TEXT"); }
  createImageNode(image: RuntimeImage): RuntimeNodeProxy {
    if (!image.hash || !Number.isFinite(image.width) || !Number.isFinite(image.height) || image.width < 0 || image.height < 0) {
      throw runtimeError("INVALID_ARGUMENT");
    }
    return this.createNode("IMAGE", { name: "Image", assetId: image.hash, width: image.width, height: image.height });
  }

  createNode(type: M1SceneNodeType, initial: Readonly<Record<string, unknown>> = {}): RuntimeNodeProxy {
    this.assertOpen();
    if (!CREATABLE_TYPES.has(type)) throw runtimeError("UNSUPPORTED_NODE_TYPE");
    const parent = this.currentPage;
    const id = this.createId();
    const node: RuntimeProjectionNode = {
      id,
      type,
      parentId: parent.id,
      name: type[0] + type.slice(1).toLowerCase(),
      x: 0,
      y: 0,
      width: type === "LINE" ? 160 : type === "TEXT" ? 220 : 100,
      height: type === "LINE" ? 0 : type === "TEXT" ? 44 : 100,
      rotation: 0,
      opacity: 1,
      visible: true,
      siblingIndex: parent.children.length,
      ...initial,
    };
    if (node.id !== id || node.type !== type || node.parentId !== parent.id) throw runtimeError("INVALID_ARGUMENT", { nodeId: id });
    this.enqueueOperations([{ type: "create", node }]);
    return this.proxyFor(id);
  }

  enqueueUpdate(nodeId: string, patch: Readonly<Record<string, unknown>>): void {
    this.enqueueOperations([{ type: "update", nodeId, patch }]);
  }

  enqueueRemove(nodeId: string): void {
    this.enqueueOperations([{ type: "remove", nodeId }]);
  }

  cloneNode(nodeId: string): RuntimeNodeProxy {
    const source = this.projectionStore.getNode(nodeId);
    if (!source || source.removed === true) throw runtimeError("NODE_REMOVED", { nodeId });
    const id = this.createId();
    const copy = structuredClone(source) as Record<string, unknown>;
    delete copy.id;
    delete copy.removed;
    const clone: RuntimeProjectionNode = {
      ...structuredClone(copy),
      id,
      type: source.type,
      parentId: source.parentId,
      name: `${typeof source.name === "string" ? source.name : source.type} copy`,
      siblingIndex: this.siblingsOf(source.parentId).length,
    };
    this.enqueueOperations([{ type: "create", node: clone }]);
    return this.proxyFor(id);
  }

  childrenOf(parentId: string): readonly RuntimeNodeProxy[] {
    this.assertOpen();
    return this.siblingsOf(parentId).map((node) => this.proxyFor(node.id));
  }

  assertCanQueryDescendants(parentId: string): void {
    this.assertOpen();
    const node = this.projectionStore.getNode(parentId);
    if (!node) throw runtimeError("NODE_NOT_FOUND", { nodeId: parentId });
    if (node.type === "DOCUMENT" && this.documentAccess === "dynamic-page" && this.loadedPageIds.size !== this.pageIds().length) {
      throw runtimeError("PAGE_NOT_LOADED", { nodeId: parentId });
    }
    if (node.type === "PAGE" && !this.loadedPageIds.has(node.id)) throw runtimeError("PAGE_NOT_LOADED", { nodeId: parentId });
  }

  async loadPageAsync(pageId: string): Promise<void> {
    this.assertOpen();
    const page = this.projectionStore.getNode(pageId);
    if (!page || page.type !== "PAGE" || page.removed === true) throw runtimeError("NODE_NOT_FOUND", { nodeId: pageId });
    // Preserve an asynchronous contract even when this Worker projection has
    // already arrived. A later remote-page transport can replace this boundary
    // without changing the Runtime surface.
    await Promise.resolve();
    this.assertOpen();
    this.loadedPageIds.add(pageId);
    this.reconcileRegistry();
  }

  async loadAllPagesAsync(): Promise<void> {
    this.assertOpen();
    await Promise.resolve();
    this.assertOpen();
    this.pageIds().forEach((pageId) => this.loadedPageIds.add(pageId));
    this.reconcileRegistry();
  }

  async setCurrentPageAsync(page: RuntimeContainerNodeProxy): Promise<void> {
    this.assertOpen();
    if (page.type !== "PAGE" || page.handle.sessionId !== this.sessionId || page.removed) throw runtimeError("INVALID_ARGUMENT", { nodeId: page.handle.nodeId });
    await this.loadPageAsync(page.id);
    if (this.resourceTransport.setCurrentPageAsync) await this.resourceTransport.setCurrentPageAsync(page.id);
    this.currentPageId = page.id;
    this.selectionIds = [];
    this.emitViewState();
  }

  selectionForPage(pageId: string): readonly RuntimeNodeProxy[] {
    this.assertOpen();
    if (pageId !== this.currentPageId) return [];
    return this.selectionIds.flatMap((id) => {
      const node = this.projectionStore.getNode(id);
      return node && this.isNodeVisible(node) ? [this.proxyFor(id)] : [];
    });
  }

  async setSelectionAsync(pageId: string, nodes: readonly RuntimeNodeProxy[]): Promise<void> {
    this.assertOpen();
    if (pageId !== this.currentPageId) throw runtimeError("INVALID_ARGUMENT", { nodeId: pageId });
    const ids = nodes.map((node) => {
      if (node.handle.sessionId !== this.sessionId || node.removed || this.pageIdFor(this.projectionStore.getNode(node.id) ?? { id: "", type: "" }) !== pageId) {
        throw runtimeError("INVALID_ARGUMENT", { nodeId: node.handle.nodeId });
      }
      return node.id;
    });
    if (new Set(ids).size !== ids.length) throw runtimeError("INVALID_ARGUMENT", { nodeId: pageId });
    if (this.resourceTransport.setSelectionAsync) await this.resourceTransport.setSelectionAsync(ids);
    this.selectionIds = ids;
    this.emitViewState();
  }

  onViewStateChange(listener: (state: Readonly<{ sequence: number; currentPageId: string; selectedIds: readonly string[] }>) => void): () => void {
    this.viewStateListeners.add(listener);
    return () => this.viewStateListeners.delete(listener);
  }

  reparent(nodeId: string, parentId: string, index: number): void {
    this.assertOpen();
    const node = this.projectionStore.getNode(nodeId);
    if (!node || node.removed === true) throw runtimeError("NODE_REMOVED", { nodeId });
    const parent = this.projectionStore.getNode(parentId);
    if (!parent || parent.removed === true || !CONTAINER_TYPES.has(parent.type as M1NodeType)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: parentId });
    }
    // A reparent is the only structural operation the Engine Worker needs for
    // M1 append/insert. Re-emitting existing siblings as reparent operations
    // duplicates structural commands in one coalesced transaction and can
    // violate Core's ordered-layer validation.
    this.enqueueOperations([{
      type: "update",
      nodeId,
      patch: { parentId, siblingIndex: index },
    }]);
  }

  findDescendants(parentId: string): readonly RuntimeNodeProxy[] {
    this.assertOpen();
    const result: RuntimeNodeProxy[] = [];
    const visit = (id: string): void => {
      for (const child of this.siblingsOf(id)) {
        if (result.length >= this.maxSynchronousQueryNodes) throw runtimeError("RESOURCE_LIMIT", { nodeId: parentId });
        result.push(this.proxyFor(child.id));
        visit(child.id);
      }
    };
    visit(parentId);
    return result;
  }

  /** Used by a Worker bridge for remote snapshots not associated with this
   * session's own pending transaction. */
  applyConfirmedProjection(projection: RuntimeProjection): readonly string[] {
    this.assertOpen();
    const result = this.projectionStore.applyConfirmedProjection(projection);
    this.reconcileRegistry();
    this.players.forEach((player) => player.notifyEditorRevision(projection.revision));
    return result.committedTransactionIds;
  }

  async commitAsync(): Promise<number> {
    this.assertOpen();
    if (this.activeCommit) {
      await this.activeCommit;
      return this.commitAsync();
    }
    const transactionId = this.queuedTransactionId;
    if (!transactionId) return this.confirmedRevision;
    this.queuedTransactionId = undefined;
    this.flushScheduled = false;
    const commit = this.transactions.commit(transactionId).finally(() => {
      this.reconcileRegistry();
      this.activeCommit = undefined;
    });
    this.activeCommit = commit;
    return commit;
  }

  async closeAsync(): Promise<void> {
    if (this.closed) return;
    try {
      this.tasks.forEach((task) => task.cancel());
      this.players.forEach((player) => player.close());
      this.players.clear();
      this.unsubscribeViewState?.();
      this.unsubscribeViewState = undefined;
      await this.commitAsync();
    } finally {
      this.closed = true;
    }
  }

  private enqueueOperations(operations: readonly PendingProjectionOperation[]): void {
    this.assertOpen();
    if (!operations.length) return;
    if (this.queuedTransactionId) {
      this.projectionStore.append(this.queuedTransactionId, operations);
    } else {
      const transactionId = this.createId();
      const transaction: PendingProjectionTransaction = {
        transactionId,
        baseRevision: this.projectionStore.confirmedRevision,
        operations,
      };
      this.projectionStore.stage(transaction);
      this.queuedTransactionId = transactionId;
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.scheduleMicrotask(() => {
      if (this.closed) return;
      void this.commitAsync().catch((error) => this.onError?.(error));
    });
  }

  private containerFor(nodeId: string): RuntimeContainerNodeProxy {
    const proxy = this.proxyFor(nodeId);
    if (!(proxy instanceof RuntimeContainerNodeProxy)) throw runtimeError("UNSUPPORTED_NODE_TYPE", { nodeId });
    return proxy;
  }

  private createProxy(handle: RuntimeNodeHandle): RuntimeNodeProxy {
    const node = this.projectionStore.getNode(handle.nodeId);
    if (!node || !M1_NODE_TYPES.includes(node.type as M1NodeType)) throw runtimeError("UNSUPPORTED_NODE_TYPE", { nodeId: handle.nodeId });
    return CONTAINER_TYPES.has(node.type as M1NodeType)
      ? new RuntimeContainerNodeProxy(handle, this, node.type as M1NodeType)
      : new RuntimeNodeProxy(handle, this, node.type as M1NodeType);
  }

  private siblingsOf(parentId: string | undefined): readonly RuntimeProjectionNode[] {
    return this.projectionStore.listLiveNodes()
      .filter((node) => node.parentId === parentId && this.isNodeVisible(node))
      .sort((left, right) => numericSiblingIndex(left) - numericSiblingIndex(right) || left.id.localeCompare(right.id));
  }

  private reconcileRegistry(): void {
    this.registry.reconcile(this.projectionStore.listLiveNodes().filter((node) => this.isNodeVisible(node)).map((node) => node.id));
  }

  private pageIds(): string[] {
    return this.projectionStore.listLiveNodes().filter((node) => node.type === "PAGE").map((node) => node.id);
  }

  private isNodeVisible(node: RuntimeProjectionNode): boolean {
    if (node.type === "DOCUMENT" || node.type === "PAGE") return true;
    if (this.documentAccess === "full-document") return true;
    const pageId = this.pageIdFor(node);
    return typeof pageId === "string" && this.loadedPageIds.has(pageId);
  }

  private applyWorkerViewState(state: RuntimeWorkerViewState): void {
    if (this.closed) return;
    const page = this.projectionStore.getNode(state.activePageId);
    if (page?.type === "PAGE" && page.removed !== true) {
      this.loadedPageIds.add(page.id);
      this.currentPageId = page.id;
    }
    this.selectionIds = state.selectedIds.filter((id) => {
      const node = this.projectionStore.getNode(id);
      return Boolean(node && this.isNodeVisible(node) && this.pageIdFor(node) === this.currentPageId);
    });
    this.emitViewState();
  }

  private emitViewState(): void {
    this.viewStateSequence += 1;
    const state = Object.freeze({ sequence: this.viewStateSequence, currentPageId: this.currentPageId, selectedIds: Object.freeze([...this.selectionIds]) });
    this.viewStateListeners.forEach((listener) => listener(state));
  }

  private pageIdFor(node: RuntimeProjectionNode): string | undefined {
    let current: RuntimeProjectionNode | undefined = node;
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      if (current.type === "PAGE") return current.id;
      visited.add(current.id);
      const explicit = current.pageId;
      if (typeof explicit === "string") return explicit;
      current = typeof current.parentId === "string" ? this.projectionStore.getNode(current.parentId) : undefined;
    }
    return undefined;
  }
}

async function admitRuntimeImage(bytes: Uint8Array, declaredMime: string, signal: AbortSignal): Promise<DocumentAsset> {
  const probe = await probeAssetInWorker("raster-image", declaredMime, bytes, { signal });
  if (!probe.admission.accepted || !probe.rasterDimensions) {
    throw runtimeError(probe.admission.accepted ? "RESOURCE_UNAVAILABLE" : probe.admission.reason === "RESOURCE_LIMIT" ? "RESOURCE_LIMIT" : "RESOURCE_UNAVAILABLE");
  }
  throwIfAborted(signal);
  return {
    assetId: createId(),
    contentHash: await sha256Hex(bytes),
    mediaType: probe.admission.mime,
    byteLength: bytes.byteLength,
    pixelWidth: probe.rasterDimensions.width,
    pixelHeight: probe.rasterDimensions.height,
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : runtimeError("TASK_CANCELLED");
}

function numericSiblingIndex(node: RuntimeProjectionNode): number {
  const index = node.siblingIndex;
  return typeof index === "number" && Number.isFinite(index) ? index : Number.MAX_SAFE_INTEGER;
}

function nodeIdByType(nodes: readonly RuntimeProjectionNode[], type: M1NodeType): string | undefined {
  return nodes.find((node) => node.type === type && node.removed !== true)?.id;
}
