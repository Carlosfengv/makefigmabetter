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
import {
  createId,
  type DocumentAsset,
  type DocumentBooleanOperation,
  type DocumentVectorPath,
  type DocumentConnectorMetadata,
  type DocumentFontReference,
  type DocumentTextPathMetadata,
  type DocumentTransformModifier,
  type ShapeWithTextType,
} from "../lib/editor-protocol";
import type { RuntimeDocumentAccessMode } from "./runtime-capabilities";
import { probeAssetInWorker } from "../lib/asset-probe-client";
import { sha256Hex } from "../lib/sha256";
import { isRuntimeFontName, runtimeFontNameForReference, runtimeFontReferenceForName, type RuntimeFontName } from "./runtime-font-name";
import { positionIdForLayerInsertion } from "../lib/layer-order";
import { RuntimeTask, type RuntimeTaskControl } from "./runtime-task";
import type { RuntimeWorkerViewState } from "./runtime-worker-bridge";
import { resolveTextPathVectorPath } from "../lib/text-path-conversion";
import { PrototypePlayer, type PrototypePlayerOptions } from "./prototype-player";
import { RevisionLeasePool, type RevisionLeaseResource } from "./revision-lease";
import { exportRuntimeNodeSvgResult, rasterizeRuntimePng, runtimePngScale, type RuntimePngExportSettings, type RuntimePngRasterizer } from "./runtime-svg-export";
import { isBoundedTransformGroupRepeatForest, isBoundedTransformModifierStack } from "../lib/transform-group-repeat";

const CONTAINER_TYPES = new Set<M1NodeType>([
  "DOCUMENT", "PAGE", "FRAME", "GROUP", "SECTION", "BOOLEAN_OPERATION", "COMPONENT", "INSTANCE", "SLOT",
  "COMPONENT_SET", "SLIDE_GRID", "SLIDE", "SLIDE_ROW", "TABLE", "TRANSFORM_GROUP",
]);
const CREATABLE_TYPES = new Set<M1SceneNodeType>([
  "FRAME", "GROUP", "SECTION", "RECTANGLE", "ELLIPSE", "POLYGON", "STAR", "VECTOR", "LINE", "TEXT", "IMAGE",
  "CONNECTOR", "SHAPE_WITH_TEXT",
]);
const MAX_RUNTIME_SVG_IMAGE_SOURCE_BYTES = 16 * 1024 * 1024;

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
  resolveBooleanPathsAsync?: (revision: number, nodeIds: readonly string[], timeoutMs?: number) => Promise<ReadonlyMap<string, DocumentVectorPath>>;
};

export type RuntimeImage = Readonly<{ hash: string; width: number; height: number }>;
export type RuntimeTaskOptions = Readonly<{ timeoutMs?: number }>;
export type RuntimeAvailableFont = Readonly<{ fontName: RuntimeFontName; assetId: string; faceIndex: number }>;

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
  private readonly exportImageDataUris = new Map<string, Readonly<{ byteLength: number; dataUri: string }>>();
  private exportImageSourceBytes = 0;
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
      this.reconcileConfirmedProjection(projection);
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
    const task = new RuntimeTask(async ({ signal }) => {
      throwIfAborted(signal);
      const frozen = await this.exportFrozenSvg(nodeId);
      throwIfAborted(signal);
      return this.rasterizePng({ svg: frozen.svg, width: frozen.width, height: frozen.height, scale, signal });
    });
    this.trackTask(task);
    return task.promise;
  }

  private async exportFrozenSvg(nodeId: string) {
    this.assertOpen();
    const projection = this.projectionStore.confirmedProjection;
    const node = projection.nodes.find((candidate) => candidate.id === nodeId && candidate.removed !== true);
    if (!node) throw runtimeError("NODE_NOT_FOUND", { nodeId });
    const pageId = this.pageIdFor(node);
    if (!pageId) throw runtimeError("EXPORT_FAILED", { nodeId, revision: this.confirmedRevision });
    const booleanNodeIds = runtimeSubtreeBooleanIds(projection, nodeId);
    const booleanPaths = booleanNodeIds.length && this.resourceTransport.resolveBooleanPathsAsync
      ? await this.resourceTransport.resolveBooleanPathsAsync(projection.revision, booleanNodeIds)
      : undefined;
    this.assertOpen();
    const imageDataUris = new Map(
      [...this.exportImageDataUris].map(([assetId, image]) => [assetId, image.dataUri]),
    );
    return exportRuntimeNodeSvgResult(this.exportLeasePool, projection, pageId, nodeId, booleanPaths, imageDataUris);
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

  allocateRuntimeId(): string { return this.createId(); }

  assertFontsLoaded(fonts: readonly DocumentFontReference[]): void {
    this.assertOpen();
    const availability = this.projectionStore.getNode(this.rootNodeId)?.fontAvailability as Record<string, string> | undefined;
    if (fonts.some((font) => availability?.[font.assetId] !== "ready")) throw runtimeError("FONT_NOT_LOADED");
  }

  resolveFontName(fontName: RuntimeFontName): DocumentFontReference | undefined {
    this.assertOpen();
    if (!isRuntimeFontName(fontName)) throw runtimeError("INVALID_ARGUMENT");
    const resolved = runtimeFontReferenceForName(fontName, this.fontAssets());
    if (resolved === null) throw runtimeError("RESOURCE_UNAVAILABLE");
    return resolved;
  }

  fontNameForReference(font: DocumentFontReference): RuntimeFontName {
    this.assertOpen();
    return runtimeFontNameForReference(font, this.fontAssets());
  }

  hasFontReference(font: DocumentFontReference): boolean {
    this.assertOpen();
    return Boolean(
      font.assetId
      && Number.isSafeInteger(font.faceIndex)
      && font.faceIndex >= 0
      && this.fontAssets().some((asset) => asset.assetId === font.assetId
        && (!(asset.fontFaces?.length) || asset.fontFaces.some((face) => face.faceIndex === font.faceIndex))),
    );
  }

  async loadFontAsync(font: DocumentFontReference | RuntimeFontName, timeoutMs?: number): Promise<void> {
    this.assertOpen();
    if (!font || typeof font !== "object") throw runtimeError("INVALID_ARGUMENT");
    const reference = "assetId" in font
      ? font
      : this.resolveFontName(font);
    if (!reference) return;
    if (!reference.assetId || !Number.isSafeInteger(reference.faceIndex) || reference.faceIndex < 0) throw runtimeError("INVALID_ARGUMENT");
    if (!this.hasFontReference(reference)) throw runtimeError("RESOURCE_UNAVAILABLE");
    const availability = this.projectionStore.getNode(this.rootNodeId)?.fontAvailability as Record<string, string> | undefined;
    if (availability?.[reference.assetId] === "ready") return;
    if (!this.resourceTransport.loadFontAsync) throw runtimeError("RESOURCE_UNAVAILABLE");
    await this.resourceTransport.loadFontAsync(reference.assetId, timeoutMs);
    this.assertFontsLoaded([reference]);
  }

  async listAvailableFontsAsync(): Promise<readonly RuntimeAvailableFont[]> {
    this.assertOpen();
    await Promise.resolve();
    return this.fontAssets().flatMap((asset): RuntimeAvailableFont[] => {
      const faceIndices = asset.fontFaces?.length
        ? asset.fontFaces.map((face) => face.faceIndex)
        : [0];
      return faceIndices.map((faceIndex) => {
        const reference = { assetId: asset.assetId, faceIndex };
        return { fontName: runtimeFontNameForReference(reference, [asset]), ...reference };
      });
    });
  }

  private fontAssets(): readonly DocumentAsset[] {
    const assets = this.projectionStore.getNode(this.rootNodeId)?.assets;
    if (!Array.isArray(assets)) return [];
    return assets.filter((candidate): candidate is DocumentAsset => Boolean(
      candidate && typeof candidate === "object"
      && typeof (candidate as DocumentAsset).assetId === "string"
      && typeof (candidate as DocumentAsset).mediaType === "string"
      && (candidate as DocumentAsset).mediaType.startsWith("font/"),
    ));
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
      this.rememberExportImage(asset, source);
      return { hash: asset.assetId, width: asset.pixelWidth ?? 0, height: asset.pixelHeight ?? 0 };
    }, options.timeoutMs);
    this.trackTask(task);
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

  hasImageHash(hash: string): boolean { return this.getImageByHash(hash) !== null; }

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

  async getInstancesOfComponentAsync(componentId: string): Promise<readonly RuntimeNodeProxy[]> {
    this.assertOpen();
    const component = this.projectionStore.getNode(componentId);
    if (!component || component.removed === true || component.type !== "COMPONENT") {
      throw runtimeError("NODE_NOT_FOUND", { nodeId: componentId });
    }
    await this.loadAllPagesAsync();
    return this.projectionStore.listLiveNodes()
      .filter((node) => node.type === "INSTANCE" && instanceMainComponentId(node) === componentId)
      .map((node) => this.proxyFor(node.id));
  }

  createFrame(): RuntimeContainerNodeProxy { return this.createNode("FRAME") as RuntimeContainerNodeProxy; }
  createGroup(): RuntimeContainerNodeProxy { return this.createNode("GROUP") as RuntimeContainerNodeProxy; }
  createSection(): RuntimeContainerNodeProxy { return this.createNode("SECTION") as RuntimeContainerNodeProxy; }
  createRectangle(): RuntimeNodeProxy { return this.createNode("RECTANGLE"); }
  createEllipse(): RuntimeNodeProxy { return this.createNode("ELLIPSE"); }
  createPolygon(): RuntimeNodeProxy {
    return this.createNode("POLYGON", { fill: "#d9f99d", stroke: "#4d7c0f", strokeWidth: 1, parametricShape: { kind: "polygon", pointCount: 5 } });
  }
  createStar(): RuntimeNodeProxy {
    return this.createNode("STAR", { fill: "#fde68a", stroke: "#b45309", strokeWidth: 1, parametricShape: { kind: "star", pointCount: 5, innerRatio: .5 } });
  }
  createVector(): RuntimeNodeProxy {
    return this.createNode("VECTOR", {
      width: 160,
      height: 120,
      fill: "#dbeafe",
      stroke: "#2563eb",
      strokeWidth: 1,
      vectorPath: {
        fillRule: "nonZero",
        subpaths: [{
          closed: true,
          points: [
            { id: this.createId(), x: 0, y: 0, pointType: "corner" },
            { id: this.createId(), x: 160, y: 120, pointType: "corner" },
            { id: this.createId(), x: 0, y: 120, pointType: "corner" },
          ],
        }],
      },
    });
  }
  createLine(): RuntimeNodeProxy { return this.createNode("LINE", { stroke: "#0048FF", strokeWidth: 1 }); }
  createText(): RuntimeNodeProxy { return this.createNode("TEXT"); }
  createConnector(): RuntimeNodeProxy {
    const connectorMetadata: DocumentConnectorMetadata = {
      lineType: "STRAIGHT",
      start: { x: 0, y: 0 },
      end: { x: 200, y: 0 },
      startStrokeCap: "NONE",
      endStrokeCap: "NONE",
      text: "",
      cornerRadius: 0,
    };
    return this.createNode("CONNECTOR", {
      name: "Connector",
      width: 200,
      height: 0,
      fill: "transparent",
      stroke: "#475569",
      strokeWidth: 2,
      connectorMetadata,
    });
  }
  createShapeWithText(): RuntimeNodeProxy {
    return this.createNode("SHAPE_WITH_TEXT", {
      name: "Shape with text",
      width: 208,
      height: 208,
      fill: "#e0e7ff",
      stroke: "#4f46e5",
      strokeWidth: 1,
      characters: "",
      shapeWithTextType: "ROUNDED_RECTANGLE" satisfies ShapeWithTextType,
    });
  }
  createTextPath(vectorProxy: RuntimeNodeProxy, startSegment: number, startPosition: number): RuntimeNodeProxy {
    this.assertOpen();
    if (vectorProxy.handle.sessionId !== this.sessionId || vectorProxy.removed || !["VECTOR", "RECTANGLE", "ELLIPSE", "POLYGON", "STAR", "LINE"].includes(vectorProxy.type)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: vectorProxy.handle.nodeId });
    }
    const vector = this.projectionStore.getNode(vectorProxy.id);
    if (!vector) throw runtimeError("NODE_NOT_FOUND", { nodeId: vectorProxy.id });
    const kind = vectorProxy.type === "VECTOR" ? "vector" : vectorProxy.type === "RECTANGLE" ? "rectangle" : vectorProxy.type === "ELLIPSE" ? "ellipse" : vectorProxy.type === "POLYGON" ? "polygon" : vectorProxy.type === "STAR" ? "star" : "line";
    const path = resolveTextPathVectorPath({
      kind,
      width: typeof vector.width === "number" ? vector.width : 0,
      height: typeof vector.height === "number" ? vector.height : 0,
      radius: typeof vector.radius === "number" ? vector.radius : 0,
      cornerRadii: vector.cornerRadii as [number, number, number, number] | undefined,
      arcData: vector.arcData as NonNullable<Parameters<typeof resolveTextPathVectorPath>[0]["arcData"]> | undefined,
      parametricShape: vector.parametricShape as NonNullable<Parameters<typeof resolveTextPathVectorPath>[0]["parametricShape"]> | undefined,
      vectorPath: vector.vectorPath as DocumentVectorPath | undefined,
    }, this.createId);
    const segmentCount = path?.subpaths.reduce((total, subpath) => total + Math.max(0, subpath.points.length - 1) + (subpath.closed ? 1 : 0), 0) ?? 0;
    if (!Number.isSafeInteger(startSegment) || startSegment < 0 || startSegment >= segmentCount || !Number.isFinite(startPosition) || startPosition < 0 || startPosition > 1) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: vectorProxy.id });
    }
    const metadata: DocumentTextPathMetadata = {
      startSegment,
      startPosition,
      autoRename: true,
      textAlignHorizontal: "LEFT",
      textAlignVertical: "CENTER",
    };
    const replacement: Record<string, unknown> = {
      ...structuredClone(vector),
      type: "TEXT_PATH",
      name: "Text path",
      characters: "",
      vectorPath: path,
      textPathMetadata: metadata,
      arcData: undefined,
      parametricShape: undefined,
      booleanOperation: undefined,
      radius: 0,
      cornerRadii: undefined,
      cornerSmoothing: 0,
      strokeWeights: undefined,
    };
    delete replacement.id;
    delete replacement.removed;
    this.enqueueOperations([{ type: "update", nodeId: vectorProxy.id, patch: replacement, convertToTextPath: true }]);
    this.registry.refreshProxy(vectorProxy.id);
    return this.proxyFor(vectorProxy.id);
  }
  transformGroup(
    nodes: readonly RuntimeNodeProxy[],
    parent: RuntimeContainerNodeProxy,
    index: number,
    modifiers: readonly DocumentTransformModifier[],
  ): RuntimeContainerNodeProxy {
    this.assertOpen();
    if (
      parent.handle.sessionId !== this.sessionId ||
      parent.removed ||
      !["PAGE", "FRAME", "GROUP", "SECTION", "COMPONENT", "TRANSFORM_GROUP"].includes(parent.type) ||
      runtimeOwnsAutoLayout(this.projectionStore.getNode(parent.id) ?? { id: "", type: "" }) ||
      !isBoundedTransformModifierStack(modifiers)
    ) throw runtimeError("INVALID_ARGUMENT", { nodeId: parent.handle.nodeId });
    if (!nodes.length || new Set(nodes.map((node) => node.id)).size !== nodes.length) throw runtimeError("INVALID_ARGUMENT");
    const parentNode = this.projectionStore.getNode(parent.id)!;
    const pageId = this.pageIdFor(parentNode);
    if (!pageId || runtimeBooleanHasImmutableAncestor((nodeId) => this.projectionStore.getNode(nodeId), parentNode)) {
      throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: parent.id });
    }
    const selected = nodes.map((proxy) => {
      if (proxy.handle.sessionId !== this.sessionId || proxy.removed) throw runtimeError("INVALID_ARGUMENT", { nodeId: proxy.handle.nodeId });
      const node = this.projectionStore.getNode(proxy.id);
      if (!node || node.parentId !== parent.id || this.pageIdFor(node) !== pageId || node.type === "DOCUMENT" || node.type === "PAGE") {
        throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: proxy.id });
      }
      if (runtimeBooleanHasImmutableAncestor((nodeId) => this.projectionStore.getNode(nodeId), node)) {
        throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: proxy.id });
      }
      return node;
    }).sort((left, right) => numericSiblingIndex(left) - numericSiblingIndex(right) || left.id.localeCompare(right.id));
    const selectedIds = new Set(selected.map((node) => node.id));
    const virtualRepeatId = "__makefigma_runtime_repeat_admission__";
    const repeatCandidateNodes = this.projectionStore.listLiveNodes()
      .map((candidate) => selectedIds.has(candidate.id) ? { ...candidate, parentId: virtualRepeatId } : candidate)
      .concat({ id: virtualRepeatId, type: "TRANSFORM_GROUP", parentId: parent.id, transformModifiers: structuredClone(modifiers) });
    if (!isBoundedTransformGroupRepeatForest(repeatCandidateNodes)) throw runtimeError("INVALID_ARGUMENT", { nodeId: parent.id });
    const remaining = this.siblingsOf(parent.id).filter((node) => !selectedIds.has(node.id));
    if (!Number.isSafeInteger(index) || index < 0 || index > remaining.length) throw runtimeError("INVALID_ARGUMENT", { nodeId: parent.id });
    const childWorldTransforms = selected.map((node) => runtimeWorldTransformForNode((nodeId) => this.projectionStore.getNode(nodeId), node));
    if (childWorldTransforms.some((transform) => !transform)) throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: parent.id });
    const bounds = selected.map((node, selectedIndex) => runtimeBoundsForTransform(node, childWorldTransforms[selectedIndex]!));
    const left = Math.min(...bounds.map((bound) => bound.left));
    const top = Math.min(...bounds.map((bound) => bound.top));
    const right = Math.max(...bounds.map((bound) => bound.right));
    const bottom = Math.max(...bounds.map((bound) => bound.bottom));
    const parentWorld = runtimeWorldTransformForNode((nodeId) => this.projectionStore.getNode(nodeId), parentNode);
    const parentInverse = parentWorld && invertRuntimeTransform(parentWorld);
    if (!parentInverse) throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: parent.id });
    const wrapperWorld: RuntimeTransform = { a: 1, b: 0, c: 0, d: 1, e: left, f: top };
    const wrapperLocal = multiplyRuntimeTransforms(parentInverse, wrapperWorld);
    const wrapperInverse = invertRuntimeTransform(wrapperWorld)!;
    const id = this.createId();
    const positionId = positionIdForLayerInsertion(remaining, index);
    if (!positionId) throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: parent.id });
    const node: RuntimeProjectionNode = {
      id,
      type: "TRANSFORM_GROUP",
      parentId: parent.id,
      name: "Transform group",
      x: wrapperLocal.e,
      y: wrapperLocal.f,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
      rotation: Math.atan2(wrapperLocal.b, wrapperLocal.a) * 180 / Math.PI,
      relativeTransform: wrapperLocal,
      opacity: 1,
      visible: true,
      siblingIndex: index,
      positionId,
      transformModifiers: structuredClone(modifiers),
    };
    const childPatches = childWorldTransforms.map((transform) => runtimeBooleanOperandPatch(multiplyRuntimeTransforms(wrapperInverse, transform!)));
    const siblingIndexes = [...remaining.slice(0, index), node, ...remaining.slice(index)].flatMap((sibling, siblingIndex) =>
      sibling.id === id || sibling.siblingIndex === siblingIndex ? [] : [{ nodeId: sibling.id, siblingIndex }]);
    this.enqueueOperations([{
      type: "transformGroup",
      node,
      childIds: selected.map((child) => child.id),
      childPatches,
      siblingIndexes,
      modifiers: structuredClone(modifiers),
      wrapperPatch: {},
    }]);
    return this.containerFor(id);
  }
  createImageNode(image: RuntimeImage): RuntimeNodeProxy {
    if (!image.hash || !Number.isFinite(image.width) || !Number.isFinite(image.height) || image.width < 0 || image.height < 0) {
      throw runtimeError("INVALID_ARGUMENT");
    }
    return this.createNode("IMAGE", { name: "Image", assetId: image.hash, width: image.width, height: image.height });
  }

  union(nodes: readonly RuntimeNodeProxy[], parent: RuntimeContainerNodeProxy, index?: number): RuntimeContainerNodeProxy {
    return this.createBoolean(nodes, parent, index, "union");
  }

  subtract(nodes: readonly RuntimeNodeProxy[], parent: RuntimeContainerNodeProxy, index?: number): RuntimeContainerNodeProxy {
    return this.createBoolean(nodes, parent, index, "subtract");
  }

  intersect(nodes: readonly RuntimeNodeProxy[], parent: RuntimeContainerNodeProxy, index?: number): RuntimeContainerNodeProxy {
    return this.createBoolean(nodes, parent, index, "intersect");
  }

  exclude(nodes: readonly RuntimeNodeProxy[], parent: RuntimeContainerNodeProxy, index?: number): RuntimeContainerNodeProxy {
    return this.createBoolean(nodes, parent, index, "exclude");
  }

  flatten(nodes: readonly RuntimeNodeProxy[], parent?: RuntimeContainerNodeProxy, index?: number): RuntimeNodeProxy {
    this.assertOpen();
    if (nodes.length !== 1) throw runtimeError("UNSUPPORTED_FEATURE");
    const booleanProxy = nodes[0]!;
    if (booleanProxy.handle.sessionId !== this.sessionId || booleanProxy.removed || booleanProxy.type !== "BOOLEAN_OPERATION") {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: booleanProxy.handle.nodeId });
    }
    const boolean = this.projectionStore.getNode(booleanProxy.id)!;
    if (!this.projectionStore.confirmedProjection.nodes.some((node) => node.id === boolean.id && node.removed !== true) || this.queuedTransactionId) {
      throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: boolean.id });
    }
    const operands = this.siblingsOf(boolean.id);
    if (operands.length < 2 || operands.some((node) => node.type !== "VECTOR")) throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: boolean.id });
    const targetParent = parent ?? this.currentPage;
    if (targetParent.handle.sessionId !== this.sessionId || targetParent.removed || !["PAGE", "FRAME", "GROUP", "SECTION", "COMPONENT", "BOOLEAN_OPERATION", "TRANSFORM_GROUP"].includes(targetParent.type)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: targetParent.handle.nodeId });
    }
    const targetParentNode = this.projectionStore.getNode(targetParent.id)!;
    if (this.pageIdFor(targetParentNode) !== this.pageIdFor(boolean) || runtimeBooleanHasImmutableAncestor((nodeId) => this.projectionStore.getNode(nodeId), targetParentNode)) {
      throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: boolean.id });
    }
    const movesAcrossParents = targetParent.id !== boolean.parentId;
    const sourceParent = typeof boolean.parentId === "string" ? this.projectionStore.getNode(boolean.parentId) : undefined;
    if (movesAcrossParents && (
      runtimeOwnsAutoLayout(targetParentNode)
      || runtimeOwnsAutoLayout(sourceParent ?? { id: "", type: "" })
      || sourceParent?.type === "GROUP"
      || sourceParent?.type === "BOOLEAN_OPERATION"
    )) throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: boolean.id });
    const targetSiblings = this.siblingsOf(targetParent.id).filter((node) => node.id !== boolean.id);
    const destination = index ?? targetSiblings.length;
    if (!Number.isSafeInteger(destination) || destination < 0 || destination > targetSiblings.length) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: targetParent.id });
    }
    const booleanWorld = runtimeWorldTransformForNode((nodeId) => this.projectionStore.getNode(nodeId), boolean);
    const targetParentWorld = runtimeWorldTransformForNode((nodeId) => this.projectionStore.getNode(nodeId), targetParentNode);
    const targetParentInverse = targetParentWorld && invertRuntimeTransform(targetParentWorld);
    if (!booleanWorld || !targetParentInverse) throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: boolean.id });
    const replacementLocal = multiplyRuntimeTransforms(targetParentInverse, booleanWorld);
    const replacementId = this.createId();
    const replacementPositionId = positionIdForLayerInsertion(targetSiblings, destination);
    if (!replacementPositionId) throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: boolean.id });
    const source = operands[0]!;
    const replacement: RuntimeProjectionNode = {
      ...structuredClone(source),
      id: replacementId,
      type: "VECTOR",
      name: `${typeof boolean.name === "string" ? boolean.name : "Boolean"} flattened`,
      parentId: targetParent.id,
      x: replacementLocal.e,
      y: replacementLocal.f,
      width: boolean.width,
      height: boolean.height,
      rotation: Math.atan2(replacementLocal.b, replacementLocal.a) * 180 / Math.PI,
      relativeTransform: replacementLocal,
      siblingIndex: destination,
      positionId: replacementPositionId,
      isMask: Boolean(boolean.isMask),
      booleanOperation: undefined,
      vectorPath: { fillRule: "nonZero", subpaths: [] },
      removed: false,
    };
    const siblingIndexes = [...targetSiblings.slice(0, destination), replacement, ...targetSiblings.slice(destination)].flatMap((sibling, siblingIndex) =>
      sibling.id === replacementId || sibling.siblingIndex === siblingIndex ? [] : [{ nodeId: sibling.id, siblingIndex }]);
    if (movesAcrossParents) {
      this.siblingsOf(boolean.parentId)
        .filter((sibling) => sibling.id !== boolean.id)
        .forEach((sibling, siblingIndex) => {
          if (sibling.siblingIndex !== siblingIndex) siblingIndexes.push({ nodeId: sibling.id, siblingIndex });
        });
    }
    this.enqueueOperations([{
      type: "flattenBoolean",
      booleanId: boolean.id,
      operandIds: operands.map((operand) => operand.id),
      replacement,
      siblingIndexes,
    }]);
    return this.proxyFor(replacementId);
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

  private createBoolean(
    nodes: readonly RuntimeNodeProxy[],
    parent: RuntimeContainerNodeProxy,
    index: number | undefined,
    operation: DocumentBooleanOperation,
  ): RuntimeContainerNodeProxy {
    this.assertOpen();
    if (parent.handle.sessionId !== this.sessionId || parent.removed || !["PAGE", "FRAME", "GROUP", "SECTION", "COMPONENT", "BOOLEAN_OPERATION", "TRANSFORM_GROUP"].includes(parent.type)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: parent.handle.nodeId });
    }
    if (nodes.length < 2 || new Set(nodes.map((node) => node.id)).size !== nodes.length) throw runtimeError("INVALID_ARGUMENT");
    const parentNode = this.projectionStore.getNode(parent.id)!;
    const targetPageId = this.pageIdFor(parentNode);
    if (!targetPageId || runtimeBooleanHasImmutableAncestor((nodeId) => this.projectionStore.getNode(nodeId), parentNode)) {
      throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: parent.id });
    }
    const selected = nodes.map((proxy) => {
      if (proxy.handle.sessionId !== this.sessionId || proxy.removed) throw runtimeError("INVALID_ARGUMENT", { nodeId: proxy.handle.nodeId });
      const node = this.projectionStore.getNode(proxy.id);
      if (!node || this.pageIdFor(node) !== targetPageId) throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: proxy.id });
      if (node.type !== "VECTOR" || !runtimeVectorSupportsBoolean(node)) throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: proxy.id });
      if (runtimeBooleanHasImmutableAncestor((nodeId) => this.projectionStore.getNode(nodeId), node)) {
        throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: proxy.id });
      }
      return node;
    });
    const crossesParents = selected.some((node) => node.parentId !== parent.id);
    if (crossesParents && runtimeOwnsAutoLayout(parentNode)) throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: parent.id });
    for (const sourceParentId of new Set(selected.map((node) => node.parentId))) {
      if (sourceParentId === parent.id) continue;
      const sourceParent = typeof sourceParentId === "string" ? this.projectionStore.getNode(sourceParentId) : undefined;
      if (!sourceParent || sourceParent.type === "GROUP" || sourceParent.type === "BOOLEAN_OPERATION" || runtimeOwnsAutoLayout(sourceParent)) {
        throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: sourceParentId });
      }
    }
    for (const structuralParentId of new Set([...selected.map((node) => node.parentId), parent.id])) {
      if (typeof structuralParentId !== "string") continue;
      const structuralParent = this.projectionStore.getNode(structuralParentId);
      if (!structuralParent || (structuralParent.type !== "GROUP" && structuralParent.type !== "BOOLEAN_OPERATION")) continue;
      const selectedChildCount = selected.filter((node) => node.parentId === structuralParentId).length;
      const childCountAfter = this.siblingsOf(structuralParentId).length - selectedChildCount + (structuralParentId === parent.id ? 1 : 0);
      if ((structuralParent.type === "GROUP" && childCountAfter < 1) || (structuralParent.type === "BOOLEAN_OPERATION" && childCountAfter < 2)) {
        throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: structuralParentId });
      }
    }
    const orderedSelected = sortRuntimeNodesByDocumentOrder(this.projectionStore.listLiveNodes(), selected, targetPageId);
    const selectedIds = new Set(orderedSelected.map((node) => node.id));
    const remaining = this.siblingsOf(parent.id).filter((node) => !selectedIds.has(node.id));
    const destination = index ?? remaining.length;
    if (!Number.isSafeInteger(destination) || destination < 0 || destination > remaining.length) throw runtimeError("INVALID_ARGUMENT", { nodeId: parent.id });
    const operandWorldTransforms = orderedSelected.map((operand) => runtimeWorldTransformForNode((nodeId) => this.projectionStore.getNode(nodeId), operand));
    if (operandWorldTransforms.some((transform) => !transform)) throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: parent.id });
    const bounds = orderedSelected.map((operand, selectedIndex) => runtimeBoundsForTransform(operand, operandWorldTransforms[selectedIndex]!));
    const left = Math.min(...bounds.map((bound) => bound.left));
    const top = Math.min(...bounds.map((bound) => bound.top));
    const right = Math.max(...bounds.map((bound) => bound.right));
    const bottom = Math.max(...bounds.map((bound) => bound.bottom));
    const parentWorld = runtimeWorldTransformForNode((nodeId) => this.projectionStore.getNode(nodeId), this.projectionStore.getNode(parent.id)!);
    const parentInverse = parentWorld && invertRuntimeTransform(parentWorld);
    if (!parentInverse) throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: parent.id });
    const wrapperWorld = { a: 1, b: 0, c: 0, d: 1, e: left, f: top };
    const wrapperLocal = multiplyRuntimeTransforms(parentInverse, wrapperWorld);
    const id = this.createId();
    const node: RuntimeProjectionNode = {
      id,
      type: "BOOLEAN_OPERATION",
      parentId: parent.id,
      name: runtimeBooleanName(operation),
      x: wrapperLocal.e,
      y: wrapperLocal.f,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
      rotation: Math.atan2(wrapperLocal.b, wrapperLocal.a) * 180 / Math.PI,
      relativeTransform: wrapperLocal,
      opacity: 1,
      visible: true,
      siblingIndex: destination,
      booleanOperation: operation,
    };
    const wrapperInverse = invertRuntimeTransform(wrapperWorld)!;
    const operandPatches = operandWorldTransforms.map((transform) => runtimeBooleanOperandPatch(multiplyRuntimeTransforms(wrapperInverse, transform!)));
    const orderedSiblings = [...remaining.slice(0, destination), node, ...remaining.slice(destination)];
    const siblingIndexes = orderedSiblings.flatMap((sibling, siblingIndex) => sibling.id === id || sibling.siblingIndex === siblingIndex
      ? []
      : [{ nodeId: sibling.id, siblingIndex }]);
    for (const sourceParentId of new Set(orderedSelected.map((operand) => operand.parentId))) {
      if (sourceParentId === parent.id) continue;
      this.siblingsOf(sourceParentId)
        .filter((sibling) => !selectedIds.has(sibling.id))
        .forEach((sibling, siblingIndex) => {
          if (sibling.siblingIndex !== siblingIndex) siblingIndexes.push({ nodeId: sibling.id, siblingIndex });
        });
    }
    this.enqueueOperations([{ type: "boolean", node, operandIds: orderedSelected.map((operand) => operand.id), operandPatches, siblingIndexes, wrapperPatch: {}, operation }]);
    return this.containerFor(id);
  }

  enqueueUpdate(nodeId: string, patch: Readonly<Record<string, unknown>>): void {
    if (patch.transformModifiers !== undefined) {
      const candidateNodes = this.projectionStore.listLiveNodes().map((node) => node.id === nodeId
        ? { ...node, transformModifiers: patch.transformModifiers }
        : node);
      if (!isBoundedTransformGroupRepeatForest(candidateNodes)) throw runtimeError("INVALID_ARGUMENT", { nodeId });
    }
    this.enqueueOperations([{ type: "update", nodeId, patch }]);
  }

  enqueueResizeWithoutConstraints(nodeId: string, patch: Readonly<Record<string, unknown>>): void {
    this.enqueueOperations([{ type: "update", nodeId, patch, ignoreConstraints: true }]);
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
    const nodeWorld = runtimeWorldTransformForNode((candidateId) => this.projectionStore.getNode(candidateId), node);
    const parentWorld = runtimeWorldTransformForNode((candidateId) => this.projectionStore.getNode(candidateId), parent);
    const parentInverse = parentWorld && invertRuntimeTransform(parentWorld);
    if (!nodeWorld || !parentInverse) throw runtimeError("UNSUPPORTED_FEATURE", { nodeId });
    const local = multiplyRuntimeTransforms(parentInverse, nodeWorld);
    const repeatCandidateNodes = this.projectionStore.listLiveNodes().map((candidate) => candidate.id === nodeId
      ? { ...candidate, parentId }
      : candidate);
    if (!isBoundedTransformGroupRepeatForest(repeatCandidateNodes)) throw runtimeError("INVALID_ARGUMENT", { nodeId });
    const siblings = this.siblingsOf(parentId).filter((sibling) => sibling.id !== nodeId);
    const destination = Math.min(index, siblings.length);
    const positionId = positionIdForLayerInsertion(siblings, destination);
    if (!positionId) throw runtimeError("INVALID_ARGUMENT", { nodeId });
    const ordered = [...siblings.slice(0, destination), node, ...siblings.slice(destination)];
    // Parent and exact ordered position remain one PendingProjection update;
    // the Worker bridge lowers them to one atomic Reparent + Reposition batch.
    this.enqueueOperations(ordered.flatMap((sibling, siblingIndex) => {
      if (sibling.id === nodeId) return [{
        type: "update" as const,
        nodeId,
        patch: {
          parentId,
          siblingIndex,
          positionId,
          ...(runtimeOwnsAutoLayout(parent)
            ? { relativeTransform: undefined }
            : {
                x: local.e,
                y: local.f,
                rotation: Math.atan2(local.b, local.a) * 180 / Math.PI,
                relativeTransform: local,
              }),
        },
      }];
      return sibling.siblingIndex === siblingIndex ? [] : [{ type: "update" as const, nodeId: sibling.id, patch: { siblingIndex } }];
    }));
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
    this.reconcileConfirmedProjection(projection);
    return result.committedTransactionIds;
  }

  private reconcileConfirmedProjection(projection: RuntimeProjection): void {
    const previousPageId = this.currentPageId;
    const previousSelection = this.selectionIds;
    this.reconcileRegistry();
    this.players.forEach((player) => player.notifyEditorRevision(projection.revision));
    const livePageIds = new Set(
      projection.nodes
        .filter((node) => node.type === "PAGE" && node.removed !== true)
        .map((node) => node.id),
    );
    for (const pageId of this.loadedPageIds) {
      if (!livePageIds.has(pageId)) this.loadedPageIds.delete(pageId);
    }
    if (!livePageIds.has(this.currentPageId)) {
      const nextPage = nodeIdByType(projection.nodes, "PAGE");
      if (nextPage) {
        this.currentPageId = nextPage;
        this.loadedPageIds.add(nextPage);
      }
    }
    this.selectionIds = this.selectionIds.filter((id) => {
      const node = this.projectionStore.getNode(id);
      return Boolean(
        node &&
          node.removed !== true &&
          this.isNodeVisible(node) &&
          this.pageIdFor(node) === this.currentPageId,
      );
    });
    if (
      previousPageId !== this.currentPageId ||
      previousSelection.length !== this.selectionIds.length ||
      previousSelection.some((id, index) => this.selectionIds[index] !== id)
    ) {
      this.emitViewState();
    }
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
      const tasks = [...this.tasks];
      tasks.forEach((task) => task.cancel());
      this.players.forEach((player) => player.close());
      this.players.clear();
      this.unsubscribeViewState?.();
      this.unsubscribeViewState = undefined;
      await Promise.allSettled(tasks.map((task) => task.promise));
      await this.commitAsync();
    } finally {
      this.exportImageDataUris.clear();
      this.exportImageSourceBytes = 0;
      this.closed = true;
    }
  }

  /** Retains a bounded copy of image bytes already admitted and registered by
   * this Runtime. Structural SVG can embed the same authorized resource
   * without asking the untrusted plugin for bytes a second time. */
  private rememberExportImage(asset: DocumentAsset, bytes: Uint8Array): void {
    if (!asset.mediaType.startsWith("image/") || bytes.byteLength > MAX_RUNTIME_SVG_IMAGE_SOURCE_BYTES) return;
    const previous = this.exportImageDataUris.get(asset.assetId);
    if (previous) {
      this.exportImageSourceBytes -= previous.byteLength;
      this.exportImageDataUris.delete(asset.assetId);
    }
    while (this.exportImageSourceBytes + bytes.byteLength > MAX_RUNTIME_SVG_IMAGE_SOURCE_BYTES) {
      const oldest = this.exportImageDataUris.entries().next().value as
        | [string, Readonly<{ byteLength: number; dataUri: string }>]
        | undefined;
      if (!oldest) return;
      this.exportImageDataUris.delete(oldest[0]);
      this.exportImageSourceBytes -= oldest[1].byteLength;
    }
    this.exportImageDataUris.set(asset.assetId, {
      byteLength: bytes.byteLength,
      dataUri: runtimeRasterDataUri(asset.mediaType, bytes),
    });
    this.exportImageSourceBytes += bytes.byteLength;
  }

  private trackTask<T>(task: RuntimeTask<T>): void {
    this.tasks.add(task as RuntimeTask<unknown>);
    void task.promise.finally(() => this.tasks.delete(task as RuntimeTask<unknown>)).catch(() => undefined);
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

function instanceMainComponentId(node: RuntimeProjectionNode): string | undefined {
  const metadata = node.instanceMetadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const mainComponentId = (metadata as { mainComponentId?: unknown }).mainComponentId;
  return typeof mainComponentId === "string" ? mainComponentId : undefined;
}

function runtimeOwnsAutoLayout(node: RuntimeProjectionNode): boolean {
  const autoLayout = node.autoLayout;
  if (!autoLayout || typeof autoLayout !== "object") return false;
  const mode = (autoLayout as { mode?: unknown }).mode;
  return mode === "horizontal" || mode === "vertical";
}

function runtimeBooleanHasImmutableAncestor(
  read: (nodeId: string) => RuntimeProjectionNode | undefined,
  node: RuntimeProjectionNode,
): boolean {
  let current: RuntimeProjectionNode | undefined = node;
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.type === "INSTANCE") return true;
    if ((current.type === "COMPONENT" || current.type === "COMPONENT_SET") && runtimePublishableIsRemote(current)) return true;
    current = typeof current.parentId === "string" ? read(current.parentId) : undefined;
  }
  return false;
}

function runtimePublishableIsRemote(node: RuntimeProjectionNode): boolean {
  const metadata = node.type === "COMPONENT" ? node.componentMetadata : node.componentSetMetadata;
  return Boolean(metadata && typeof metadata === "object" && (metadata as { remote?: unknown }).remote === true);
}

function sortRuntimeNodesByDocumentOrder(
  allNodes: readonly RuntimeProjectionNode[],
  selected: readonly RuntimeProjectionNode[],
  pageId: string,
): RuntimeProjectionNode[] {
  const byParent = new Map<string, RuntimeProjectionNode[]>();
  allNodes.forEach((node) => {
    if (node.removed === true || typeof node.parentId !== "string") return;
    const siblings = byParent.get(node.parentId) ?? [];
    siblings.push(node);
    byParent.set(node.parentId, siblings);
  });
  byParent.forEach((siblings) => siblings.sort((left, right) => numericSiblingIndex(left) - numericSiblingIndex(right) || left.id.localeCompare(right.id)));
  const rank = new Map<string, number>();
  let nextRank = 0;
  const visit = (parentId: string, visited: Set<string>): void => {
    if (visited.has(parentId)) return;
    const nextVisited = new Set(visited).add(parentId);
    for (const child of byParent.get(parentId) ?? []) {
      rank.set(child.id, nextRank++);
      visit(child.id, nextVisited);
    }
  };
  visit(pageId, new Set());
  const inputOrder = new Map(selected.map((node, index) => [node.id, index]));
  return [...selected].sort((left, right) =>
    (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    || (inputOrder.get(left.id) ?? 0) - (inputOrder.get(right.id) ?? 0));
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

function runtimeRasterDataUri(mediaType: string, bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return `data:${mediaType};base64,${btoa(chunks.join(""))}`;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : runtimeError("TASK_CANCELLED");
}

function numericSiblingIndex(node: RuntimeProjectionNode): number {
  const index = node.siblingIndex;
  return typeof index === "number" && Number.isFinite(index) ? index : Number.MAX_SAFE_INTEGER;
}

function runtimeBooleanName(operation: DocumentBooleanOperation): string {
  return operation[0]!.toUpperCase() + operation.slice(1);
}

type RuntimeTransform = Readonly<{ a: number; b: number; c: number; d: number; e: number; f: number }>;

function runtimeBoundsForTransform(node: RuntimeProjectionNode, transform: RuntimeTransform): Readonly<{ left: number; top: number; right: number; bottom: number }> {
  const width = finiteNodeNumber(node.width, 0);
  const height = finiteNodeNumber(node.height, 0);
  const points = [
    runtimeTransformPoint(transform, 0, 0),
    runtimeTransformPoint(transform, width, 0),
    runtimeTransformPoint(transform, width, height),
    runtimeTransformPoint(transform, 0, height),
  ];
  return {
    left: Math.min(...points.map((point) => point.x)),
    top: Math.min(...points.map((point) => point.y)),
    right: Math.max(...points.map((point) => point.x)),
    bottom: Math.max(...points.map((point) => point.y)),
  };
}

function runtimeBooleanOperandPatch(relativeTransform: RuntimeTransform): Readonly<Record<string, unknown>> {
  return {
    x: relativeTransform.e,
    y: relativeTransform.f,
    rotation: Math.atan2(relativeTransform.b, relativeTransform.a) * 180 / Math.PI,
    relativeTransform,
  };
}

function runtimeRelativeTransform(node: RuntimeProjectionNode): RuntimeTransform {
  const candidate = node.relativeTransform;
  if (candidate && typeof candidate === "object") {
    const value = candidate as Partial<Record<"a" | "b" | "c" | "d" | "e" | "f", unknown>>;
    if ([value.a, value.b, value.c, value.d, value.e, value.f].every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
      return value as { a: number; b: number; c: number; d: number; e: number; f: number };
    }
  }
  const rotation = finiteNodeNumber(node.rotation, 0) * Math.PI / 180;
  return {
    a: Math.cos(rotation),
    b: Math.sin(rotation),
    c: -Math.sin(rotation),
    d: Math.cos(rotation),
    e: finiteNodeNumber(node.x, 0),
    f: finiteNodeNumber(node.y, 0),
  };
}

function runtimeWorldTransformForNode(
  read: (nodeId: string) => RuntimeProjectionNode | undefined,
  node: RuntimeProjectionNode,
): RuntimeTransform | undefined {
  const chain: RuntimeProjectionNode[] = [];
  const visited = new Set<string>();
  let current: RuntimeProjectionNode | undefined = node;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    chain.push(current);
    current = typeof current.parentId === "string" ? read(current.parentId) : undefined;
  }
  if (current) return undefined;
  return chain.reverse().reduce<RuntimeTransform>(
    (world, candidate) => multiplyRuntimeTransforms(world, runtimeRelativeTransform(candidate)),
    { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
  );
}

function multiplyRuntimeTransforms(left: RuntimeTransform, right: RuntimeTransform): RuntimeTransform {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  };
}

function invertRuntimeTransform(transform: RuntimeTransform): RuntimeTransform | undefined {
  const determinant = transform.a * transform.d - transform.b * transform.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return undefined;
  return {
    a: transform.d / determinant,
    b: -transform.b / determinant,
    c: -transform.c / determinant,
    d: transform.a / determinant,
    e: (transform.c * transform.f - transform.d * transform.e) / determinant,
    f: (transform.b * transform.e - transform.a * transform.f) / determinant,
  };
}

function runtimeVectorSupportsBoolean(node: RuntimeProjectionNode): boolean {
  const path = node.vectorPath;
  if (!path || typeof path !== "object" || !("subpaths" in path) || !Array.isArray(path.subpaths) || path.subpaths.length === 0) return false;
  return path.subpaths.every((subpath) => Boolean(
    subpath &&
    typeof subpath === "object" &&
    "closed" in subpath &&
    subpath.closed === true &&
    "points" in subpath &&
    Array.isArray(subpath.points) &&
    subpath.points.length >= 3,
  ));
}

function runtimeTransformPoint(
  transform: Readonly<{ a: number; b: number; c: number; d: number; e: number; f: number }>,
  x: number,
  y: number,
): Readonly<{ x: number; y: number }> {
  return { x: transform.a * x + transform.c * y + transform.e, y: transform.b * x + transform.d * y + transform.f };
}

function finiteNodeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nodeIdByType(nodes: readonly RuntimeProjectionNode[], type: M1NodeType): string | undefined {
  return nodes.find((node) => node.type === type && node.removed !== true)?.id;
}

function runtimeSubtreeBooleanIds(projection: RuntimeProjection, rootNodeId: string): string[] {
  const children = new Map<string, RuntimeProjectionNode[]>();
  const nodesById = new Map<string, RuntimeProjectionNode>();
  for (const node of projection.nodes) {
    if (node.removed !== true) nodesById.set(node.id, node);
    if (node.removed === true || typeof node.parentId !== "string") continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  const result: string[] = [];
  const pending = [rootNodeId];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = nodesById.get(id);
    if (!node) continue;
    if (node.type === "BOOLEAN_OPERATION") result.push(id);
    for (const child of children.get(id) ?? []) pending.push(child.id);
  }
  if (result.length > 256) throw runtimeError("RESOURCE_LIMIT", { nodeId: rootNodeId, revision: projection.revision });
  return result;
}
