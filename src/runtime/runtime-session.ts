import { RuntimeContainerNodeProxy, type RuntimeContainerHost } from "./container-node-proxy";
import { NodeRegistry, type RuntimeNodeHandle } from "./node-registry";
import {
  M1_NODE_TYPES,
  RuntimeNodeProxy,
  type M1NodeType,
  type M1SceneNodeType,
  type RuntimeComponentPropertyEdit,
  type RuntimeComponentPropertyOptions,
  type RuntimeComponentPropertyType,
  type RuntimeVariableAlias,
} from "./node-proxy";
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
  type DocumentComponentMetadata,
  type DocumentComponentSetMetadata,
  type DocumentComponentPropertyReferences,
  type DocumentAsset,
  type DocumentBooleanOperation,
  type DocumentVectorPath,
  type DocumentConnectorMetadata,
  type DocumentEmbedMetadata,
  type DocumentFontReference,
  type DocumentInstanceMetadata,
  type DocumentLinkUnfurlMetadata,
  type DocumentPaintStyleResource,
  type DocumentTextStyleResource,
  type DocumentTextProperties,
  type DocumentTextPathMetadata,
  type DocumentTransformModifier,
  type DocumentVariableCollectionResource,
  type DocumentVariableResolvedType,
  type DocumentVariableResource,
  type DocumentVariableValue,
  type ShapeWithTextType,
} from "../lib/editor-protocol";
import type { RuntimeDocumentAccessMode } from "./runtime-capabilities";
import { probeAssetInWorker } from "../lib/asset-probe-client";
import { sha256Hex } from "../lib/sha256";
import { DEFAULT_RUNTIME_FONT_NAME, isRuntimeFontName, runtimeFontNameForReference, runtimeFontReferenceForName, type RuntimeFontName } from "./runtime-font-name";
import { RuntimeTextStyle } from "./runtime-text-style";
import { RuntimePaintStyle } from "./runtime-paint-style";
import { positionIdForLayerInsertion } from "../lib/layer-order";
import { RuntimeTask, type RuntimeTaskControl } from "./runtime-task";
import type { RuntimeWorkerViewState } from "./runtime-worker-bridge";
import { resolveTextPathVectorPath } from "../lib/text-path-conversion";
import { PrototypePlayer, type PrototypePlayerOptions } from "./prototype-player";
import { RevisionLeasePool, type RevisionLeaseResource } from "./revision-lease";
import { exportRuntimeNodeSvgResult, rasterizeRuntimePng, runtimePngScale, type RuntimePngExportSettings, type RuntimePngRasterizer } from "./runtime-svg-export";
import { isBoundedTransformGroupRepeatForest, isBoundedTransformModifierStack } from "../lib/transform-group-repeat";
import { RuntimeVariablesAPI } from "./runtime-variables";
import { variableBindingsFromExtensions, variableEffectBindingsFromExtensions, variableModesFromExtensions, variablePaintBindingsFromExtensions } from "./runtime-variable-bindings";
import { fontsForRuntimeTextRange, updateRuntimeText } from "./runtime-text";

const CONTAINER_TYPES = new Set<M1NodeType>([
  "DOCUMENT", "PAGE", "FRAME", "GROUP", "SECTION", "BOOLEAN_OPERATION", "COMPONENT", "INSTANCE", "SLOT",
  "COMPONENT_SET", "SLIDE_GRID", "SLIDE", "SLIDE_ROW", "TABLE", "TRANSFORM_GROUP",
]);
const CREATABLE_TYPES = new Set<M1SceneNodeType>([
  "FRAME", "GROUP", "SECTION", "COMPONENT", "SLICE", "RECTANGLE", "ELLIPSE", "POLYGON", "STAR", "VECTOR", "LINE", "TEXT", "IMAGE",
  "CONNECTOR", "EMBED", "LINK_UNFURL", "MEDIA", "SHAPE_WITH_TEXT",
]);
const MAX_RUNTIME_SVG_IMAGE_SOURCE_BYTES = 16 * 1024 * 1024;
const INSTANCE_SOURCE_NODE_EXTENSION = "figma.instance.source-node.v1";
const INSTANCE_CLONE_TYPES = new Set<M1SceneNodeType>([
  "FRAME", "GROUP", "SECTION", "RECTANGLE", "ELLIPSE", "POLYGON", "STAR", "VECTOR", "BOOLEAN_OPERATION", "SLICE", "LINE", "TEXT", "IMAGE",
  "INSTANCE", "SLOT", "CONNECTOR", "SHAPE_WITH_TEXT", "TEXT_PATH", "TRANSFORM_GROUP",
]);
const RUNTIME_CLONE_TYPES = new Set<M1SceneNodeType>([
  "FRAME", "GROUP", "SECTION", "RECTANGLE", "ELLIPSE", "POLYGON", "STAR", "VECTOR", "BOOLEAN_OPERATION", "SLICE", "LINE", "TEXT", "IMAGE",
  "CODE_BLOCK", "COMPONENT", "INSTANCE", "SLOT", "COMPONENT_SET", "CONNECTOR", "EMBED", "HIGHLIGHT", "LINK_UNFURL", "MEDIA", "SHAPE_WITH_TEXT",
  "STAMP", "STICKY", "TABLE", "TEXT_PATH", "TRANSFORM_GROUP", "WASHI_TAPE", "WIDGET",
]);
const RUNTIME_CLONE_DESCENDANT_TYPES = new Set<M1SceneNodeType>([...RUNTIME_CLONE_TYPES, "TABLE_CELL"]);
const RUNTIME_STRUCTURAL_OVERRIDE_FIELDS = new Set([
  "id", "type", "kind", "parentId", "pageId", "positionId", "siblingIndex", "removed",
  "componentMetadata", "componentSetMetadata", "instanceMetadata", "slotMetadata", "extensions",
]);

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
  resolveLinkPreviewAsync?: (url: string, timeoutMs?: number) => Promise<RuntimeLinkPreview>;
};

export type RuntimeImage = Readonly<{ hash: string; width: number; height: number }>;
export type RuntimeLinkPreview =
  | Readonly<{ type: "EMBED"; data: DocumentEmbedMetadata }>
  | Readonly<{ type: "LINK_UNFURL"; data: DocumentLinkUnfurlMetadata }>;
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
  readonly variables: RuntimeVariablesAPI;
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
    this.variables = new RuntimeVariablesAPI(this);
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

  textStyleResource(styleId: string): DocumentTextStyleResource | undefined {
    this.assertOpen();
    return this.projectionStore.confirmedProjection.textStyles?.find((style) => style.id === styleId);
  }

  paintStyleResource(styleId: string): DocumentPaintStyleResource | undefined {
    this.assertOpen();
    return this.projectionStore.confirmedProjection.paintStyles?.find((style) => style.id === styleId);
  }

  variableResource(id: string): DocumentVariableResource | undefined {
    this.assertOpen();
    return this.projectionStore.listVariables().find((variable) => variable.id === id);
  }

  variableCollectionResource(id: string): DocumentVariableCollectionResource | undefined {
    this.assertOpen();
    return this.projectionStore.listVariableCollections().find((collection) => collection.id === id);
  }

  localVariables(type?: DocumentVariableResolvedType): readonly DocumentVariableResource[] {
    this.assertOpen();
    return this.projectionStore.listVariables().filter((variable) => !variable.remote && (type === undefined || variable.resolvedType === type));
  }

  allVariableResources(): readonly DocumentVariableResource[] {
    this.assertOpen();
    return this.projectionStore.listVariables();
  }

  explicitVariableModesForNode(nodeId: string): Readonly<Record<string, string>> {
    this.assertOpen();
    const node = this.projectionStore.getNode(nodeId);
    if (!node) throw runtimeError("NODE_REMOVED", { nodeId });
    return variableModesFromExtensions(node.extensions);
  }

  resolvedVariableModesForNode(nodeId: string, override?: Readonly<{ nodeId: string; modes: Readonly<Record<string, string>> }>): Readonly<Record<string, string>> {
    this.assertOpen();
    const chain: RuntimeProjectionNode[] = [];
    const seen = new Set<string>();
    let node = this.projectionStore.getNode(nodeId);
    while (node) {
      if (seen.has(node.id)) throw runtimeError("INTERNAL_ERROR", { nodeId });
      seen.add(node.id);
      chain.push(node);
      node = typeof node.parentId === "string" ? this.projectionStore.getNode(node.parentId) : undefined;
    }
    const result: Record<string, string> = {};
    for (const item of chain.reverse()) Object.assign(result, item.id === override?.nodeId ? override.modes : variableModesFromExtensions(item.extensions));
    return Object.freeze(result);
  }

  refreshComponentPropertyVariableModes(nodeId: string, modes: Readonly<Record<string, string>>): void {
    const operations = this.componentPropertyVariableOperations(new Map(), new Map(), { nodeId, modes });
    this.enqueueOperations(operations);
  }

  resolveVariableValue(variableId: string, nodeId?: string, override?: Readonly<{ nodeId: string; modes: Readonly<Record<string, string>> }>): Readonly<{ value: DocumentVariableValue; resolvedType: DocumentVariableResolvedType }> {
    return this.resolveVariableValueFromResources(variableId, nodeId, override);
  }

  private resolveVariableValueFromResources(
    variableId: string,
    nodeId?: string,
    override?: Readonly<{ nodeId: string; modes: Readonly<Record<string, string>> }>,
    variableOverrides: ReadonlyMap<string, DocumentVariableResource> = new Map(),
    collectionOverrides: ReadonlyMap<string, DocumentVariableCollectionResource> = new Map(),
  ): Readonly<{ value: DocumentVariableValue; resolvedType: DocumentVariableResolvedType }> {
    this.assertOpen();
    const modes = nodeId ? this.resolvedVariableModesForNode(nodeId, override) : {};
    const seen = new Set<string>();
    const initialVariable = variableOverrides.get(variableId) ?? this.variableResource(variableId);
    if (!initialVariable) throw runtimeError("RESOURCE_UNAVAILABLE");
    let variable: DocumentVariableResource = initialVariable;
    const resolvedType = initialVariable.resolvedType;
    while (true) {
      if (seen.has(variable.id)) throw runtimeError("INVALID_ARGUMENT");
      seen.add(variable.id);
      const collection = collectionOverrides.get(variable.collectionId) ?? this.variableCollectionResource(variable.collectionId);
      if (!collection) throw runtimeError("RESOURCE_UNAVAILABLE");
      const modeId = modes[collection.id] ?? collection.defaultModeId;
      if (!collection.modes.some((mode) => mode.modeId === modeId)) throw runtimeError("RESOURCE_UNAVAILABLE");
      const value: DocumentVariableValue | undefined = variable.valuesByMode[modeId];
      if (value === undefined) throw runtimeError("RESOURCE_UNAVAILABLE");
      if (typeof value === "object" && value !== null && "type" in value && value.type === "VARIABLE_ALIAS") {
        const target: DocumentVariableResource | undefined = variableOverrides.get(value.id) ?? this.variableResource(value.id);
        if (!target || target.resolvedType !== resolvedType) throw runtimeError("RESOURCE_UNAVAILABLE");
        variable = target;
        continue;
      }
      return Object.freeze({ value: structuredClone(value), resolvedType });
    }
  }

  localVariableCollections(): readonly DocumentVariableCollectionResource[] {
    this.assertOpen();
    return this.projectionStore.listVariableCollections().filter((collection) => !collection.remote);
  }

  registerVariableCollection(collection: DocumentVariableCollectionResource): void {
    this.enqueueOperations([{ type: "registerVariableCollection", collection }]);
  }

  registerVariable(variable: DocumentVariableResource): void {
    this.enqueueOperations([{ type: "registerVariable", variable }]);
  }

  setVariable(variable: DocumentVariableResource): void {
    const operations = this.componentPropertyVariableOperations(new Map([[variable.id, variable]]));
    this.enqueueOperations([{ type: "setVariable", variable }, ...operations]);
  }

  deleteVariable(id: string): void {
    this.enqueueOperations([{ type: "deleteVariable", id }]);
  }

  variableIsBound(id: string): boolean {
    return this.projectionStore.listLiveNodes().some((node) => {
      const definitions = node.type === "COMPONENT"
        ? (node.componentMetadata as DocumentComponentMetadata | undefined)?.componentPropertyDefinitions
        : node.type === "COMPONENT_SET"
          ? (node.componentSetMetadata as DocumentComponentSetMetadata | undefined)?.componentPropertyDefinitions
          : undefined;
      return Object.values(definitions ?? {}).some((definition) => definition.boundVariables?.defaultValue?.id === id) || [
        variableBindingsFromExtensions(node.extensions),
        variablePaintBindingsFromExtensions(node.extensions),
        variableEffectBindingsFromExtensions(node.extensions),
      ].some((bindings) => Object.values(bindings).includes(id));
    });
  }

  setVariableCollection(collection: DocumentVariableCollectionResource, variables: readonly DocumentVariableResource[]): void {
    const variableOverrides = new Map(variables.map((variable) => [variable.id, variable]));
    const operations = this.componentPropertyVariableOperations(variableOverrides, new Map([[collection.id, collection]]));
    this.enqueueOperations([{ type: "setVariableCollection", collection, variables }, ...operations]);
  }

  deleteVariableCollection(id: string): void {
    this.enqueueOperations([{ type: "deleteVariableCollection", id }]);
  }

  assertSynchronousDocumentAccess(): void {
    this.assertOpen();
    if (this.documentAccess !== "full-document") throw runtimeError("PAGE_NOT_LOADED");
  }

  getStyleById(styleId: string): RuntimeTextStyle | RuntimePaintStyle | null {
    this.assertOpen();
    if (this.documentAccess !== "full-document") throw runtimeError("PAGE_NOT_LOADED");
    return this.textStyleForId(styleId);
  }

  async getStyleByIdAsync(styleId: string): Promise<RuntimeTextStyle | RuntimePaintStyle | null> {
    this.assertOpen();
    if (typeof styleId !== "string" || !styleId) throw runtimeError("INVALID_ARGUMENT");
    await Promise.resolve();
    return this.textStyleForId(styleId);
  }

  getLocalTextStyles(): readonly RuntimeTextStyle[] {
    this.assertOpen();
    if (this.documentAccess !== "full-document") throw runtimeError("PAGE_NOT_LOADED");
    return this.localTextStyles();
  }

  async getLocalTextStylesAsync(): Promise<readonly RuntimeTextStyle[]> {
    this.assertOpen();
    await Promise.resolve();
    return this.localTextStyles();
  }

  getLocalPaintStyles(): readonly RuntimePaintStyle[] {
    this.assertOpen();
    if (this.documentAccess !== "full-document") throw runtimeError("PAGE_NOT_LOADED");
    return this.localPaintStyles();
  }

  async getLocalPaintStylesAsync(): Promise<readonly RuntimePaintStyle[]> {
    this.assertOpen();
    await Promise.resolve();
    return this.localPaintStyles();
  }

  private textStyleForId(styleId: string): RuntimeTextStyle | RuntimePaintStyle | null {
    const resource = this.textStyleResource(styleId);
    if (resource) return new RuntimeTextStyle(resource, this.textStyleHost());
    const paintResource = this.paintStyleResource(styleId);
    return paintResource ? new RuntimePaintStyle(paintResource, this.paintStyleHost()) : null;
  }

  private localTextStyles(): readonly RuntimeTextStyle[] {
    const host = this.textStyleHost();
    return Object.freeze((this.projectionStore.confirmedProjection.textStyles ?? [])
      .filter((style) => !style.remote)
      .map((style) => new RuntimeTextStyle(style, host)));
  }

  private localPaintStyles(): readonly RuntimePaintStyle[] {
    const host = this.paintStyleHost();
    return Object.freeze((this.projectionStore.confirmedProjection.paintStyles ?? [])
      .filter((style) => !style.remote)
      .map((style) => new RuntimePaintStyle(style, host)));
  }

  private paintStyleHost() {
    return {
      consumersForPaintStyle: (styleId: string) => Object.freeze(this.projectionStore
        .listLiveNodes()
        .filter((node) => this.isNodeVisible(node))
        .map((node) => {
          const fields: string[] = [];
          if (node.fillStyleId === styleId) fields.push("fillStyleId");
          if (node.strokeStyleId === styleId) fields.push("strokeStyleId");
          if (node.backgroundStyleId === styleId) fields.push("backgroundStyleId");
          if (runtimeNodeUsesPaintStyle(node, styleId) && !fields.includes("fillStyleId")) fields.push("fillStyleId");
          return fields.length ? { node: this.proxyFor(node.id), fields: Object.freeze(fields) } : undefined;
        })
        .filter((consumer): consumer is { node: RuntimeNodeProxy; fields: readonly string[] } => consumer !== undefined)),
    };
  }

  private textStyleHost() {
    return {
      fontNameForStyle: (style: DocumentTextStyleResource): RuntimeFontName => style.style.font
        ? this.fontNameForReference(style.style.font)
        : DEFAULT_RUNTIME_FONT_NAME,
      consumersForTextStyle: (styleId: string): readonly RuntimeNodeProxy[] => this.projectionStore
        .listLiveNodes()
        .filter((node) => this.isNodeVisible(node) && runtimeNodeUsesTextStyle(node, styleId))
        .map((node) => this.proxyFor(node.id)),
    };
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
      return faceIndices.flatMap((faceIndex) => {
        const reference = { assetId: asset.assetId, faceIndex };
        const face = asset.fontFaces?.find((candidate) => candidate.faceIndex === faceIndex);
        return [runtimeFontNameForReference(reference, [asset]), ...(face?.aliases ?? [])]
          .map((fontName) => ({ fontName, ...reference }));
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

  getExposedInstances(instanceId: string): readonly RuntimeNodeProxy[] {
    this.assertOpen();
    const root = this.projectionStore.getNode(instanceId);
    if (!root || root.removed === true || root.type !== "INSTANCE") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: instanceId });
    return [...this.runtimeSubtreePaths(instanceId).keys()].flatMap((id): RuntimeNodeProxy[] => {
      if (id === instanceId) return [];
      const node = this.projectionStore.getNode(id);
      return node?.type === "INSTANCE" && (node.instanceMetadata as DocumentInstanceMetadata | undefined)?.isExposedInstance
        ? [this.proxyFor(id)]
        : [];
    });
  }

  createFrame(): RuntimeContainerNodeProxy { return this.createNode("FRAME") as RuntimeContainerNodeProxy; }
  createGroup(): RuntimeContainerNodeProxy { return this.createNode("GROUP") as RuntimeContainerNodeProxy; }
  createSection(): RuntimeContainerNodeProxy { return this.createNode("SECTION") as RuntimeContainerNodeProxy; }
  createComponent(): RuntimeContainerNodeProxy { return this.createNode("COMPONENT") as RuntimeContainerNodeProxy; }
  createComponentFromNode(sourceProxy: RuntimeNodeProxy): RuntimeContainerNodeProxy {
    this.assertOpen();
    if (sourceProxy.handle.sessionId !== this.sessionId || sourceProxy.removed) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: sourceProxy.handle.nodeId });
    }
    const source = this.projectionStore.getNode(sourceProxy.id);
    if (!source || (source.type !== "FRAME" && source.type !== "GROUP") || typeof source.parentId !== "string") {
      throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: sourceProxy.id });
    }
    let ancestor = this.projectionStore.getNode(source.parentId);
    const visited = new Set<string>();
    while (ancestor && !visited.has(ancestor.id)) {
      visited.add(ancestor.id);
      if (["COMPONENT", "COMPONENT_SET", "INSTANCE"].includes(ancestor.type)) {
        throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: source.id });
      }
      ancestor = typeof ancestor.parentId === "string" ? this.projectionStore.getNode(ancestor.parentId) : undefined;
    }
    if (this.findDescendants(source.id).some((node) => node.type === "COMPONENT" || node.type === "COMPONENT_SET")) {
      throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: source.id });
    }

    const siblings = this.siblingsOf(source.parentId);
    const sourceIndex = siblings.findIndex((node) => node.id === source.id);
    if (sourceIndex < 0) throw runtimeError("NODE_NOT_FOUND", { nodeId: source.id });
    const remaining = siblings.filter((node) => node.id !== source.id);
    const id = this.createId();
    const finalPositionId = typeof source.positionId === "string" && source.positionId
      ? source.positionId
      : positionIdForLayerInsertion(remaining, sourceIndex);
    if (!finalPositionId) throw runtimeError("INVALID_ARGUMENT", { nodeId: source.id });
    const temporaryPositionId = runtimeTemporaryPositionId(id, finalPositionId);
    const componentMetadata: DocumentComponentMetadata = {
      key: id,
      remote: false,
      description: "",
      descriptionMarkdown: "",
      documentationLinks: [],
      componentPropertyDefinitions: {},
    };
    const replacement: RuntimeProjectionNode = {
      ...structuredClone(source),
      id,
      type: "COMPONENT",
      removed: false,
      positionId: finalPositionId,
      siblingIndex: sourceIndex,
      componentMetadata,
      instanceMetadata: undefined,
      componentSetMetadata: undefined,
    };
    this.enqueueOperations([{
      type: "componentFromNode",
      sourceId: source.id,
      replacement,
      childIds: this.siblingsOf(source.id).map((node) => node.id),
      temporaryPositionId,
      finalPositionId,
    }]);
    return this.containerFor(id);
  }
  createSlice(): RuntimeNodeProxy { return this.createNode("SLICE"); }
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
  createInstance(componentId: string): RuntimeContainerNodeProxy {
    this.assertOpen();
    const component = this.projectionStore.getNode(componentId);
    if (!component || component.removed === true || component.type !== "COMPONENT") {
      throw runtimeError("NODE_NOT_FOUND", { nodeId: componentId });
    }
    const metadata = component.componentMetadata as DocumentComponentMetadata | undefined;
    if (!metadata || metadata.remote) throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: componentId });

    const subtree: RuntimeProjectionNode[] = [];
    const visited = new Set<string>();
    const visit = (node: RuntimeProjectionNode): void => {
      if (visited.has(node.id)) throw runtimeError("INVALID_ARGUMENT", { nodeId: node.id });
      visited.add(node.id);
      if (subtree.length >= this.maxSynchronousQueryNodes) throw runtimeError("RESOURCE_LIMIT", { nodeId: componentId });
      if (node.id !== componentId && !INSTANCE_CLONE_TYPES.has(node.type as M1SceneNodeType)) {
        throw runtimeError("UNSUPPORTED_NODE_TYPE", { nodeId: node.id });
      }
      subtree.push(node);
      this.siblingsOf(node.id).forEach(visit);
    };
    visit(component);

    const ids = new Map(subtree.map((node) => [node.id, this.createId()]));
    const instanceId = ids.get(componentId)!;
    const componentState = this.componentPropertyState(component);
    const componentProperties = componentState.values;
    const pageId = this.currentPage.id;
    const operations = subtree.map((source): PendingProjectionOperation => {
      const id = ids.get(source.id)!;
      const isRoot = source.id === componentId;
      const sourceExtensions = source.extensions && typeof source.extensions === "object" && !Array.isArray(source.extensions)
        ? structuredClone(source.extensions as Record<string, number[]>)
        : {};
      delete sourceExtensions["figma.component.metadata.v1"];
      sourceExtensions[INSTANCE_SOURCE_NODE_EXTENSION] = [...new TextEncoder().encode(source.id)];
      const clone: RuntimeProjectionNode = {
        ...structuredClone(source),
        id,
        type: isRoot ? "INSTANCE" : source.type,
        parentId: isRoot ? pageId : ids.get(source.parentId!),
        pageId,
        siblingIndex: isRoot ? this.currentPage.children.length : source.siblingIndex,
        name: isRoot ? `${typeof source.name === "string" ? source.name : "Component"} instance` : source.name,
        x: isRoot ? (typeof source.x === "number" ? source.x : 0) + 16 : source.x,
        y: isRoot ? (typeof source.y === "number" ? source.y : 0) + 16 : source.y,
        removed: false,
        extensions: sourceExtensions,
        ...(isRoot ? {
          componentMetadata: undefined,
          instanceMetadata: {
            mainComponentId: componentId,
            scaleFactor: 1,
            componentProperties,
            overrides: [],
            isExposedInstance: false,
          },
        } : {}),
      };
      if (!isRoot) {
        const references = runtimeComponentPropertyReferences(clone);
        if (references) Object.assign(clone as Record<string, unknown>, this.componentPropertyReferenceValuePatch(clone, references, componentProperties, componentState.definitions));
      }
      return { type: "create", node: clone };
    });
    const replacementSources: RuntimeProjectionNode[] = [];
    const replacedSourceRoots = new Set<string>();
    let plannedOperationCount = operations.length;
    this.componentPropertyReferenceOrder(subtree.filter((source) => source.id !== componentId && runtimeComponentPropertyReferences(source)?.mainComponent)).forEach((source) => {
      if (runtimeNodeHasAncestorIn(source, replacedSourceRoots, (id) => this.projectionStore.getNode(id))) return;
      const references = runtimeComponentPropertyReferences(source)!;
      if (!this.componentPropertyReferenceReplacesSubtree(source, references, componentProperties, componentState.definitions)) return;
      const target = this.componentPropertyReferenceTarget(source, references, componentProperties, componentState.definitions)!;
      const targetMetadata = target.componentMetadata as DocumentComponentMetadata | undefined;
      if (!targetMetadata) throw runtimeError("RESOURCE_UNAVAILABLE", { nodeId: source.id });
      const currentDescendants = subtree.filter((candidate) => runtimeNodeHasAncestorIn(candidate, new Set([source.id]), (id) => this.projectionStore.getNode(id)));
      const targetDescendants = this.projectionStore.listLiveNodes().filter((candidate) => runtimeNodeHasAncestorIn(candidate, new Set([target.id]), (id) => this.projectionStore.getNode(id)));
      if (targetDescendants.some((candidate) => !INSTANCE_CLONE_TYPES.has(candidate.type as M1SceneNodeType))) {
        throw runtimeError("UNSUPPORTED_NODE_TYPE", { nodeId: source.id });
      }
      const targetState = this.componentPropertyState(target);
      const targetValues = targetState.values;
      targetDescendants.forEach((candidate) => {
        const nestedReferences = runtimeComponentPropertyReferences(candidate);
        if (nestedReferences) this.componentPropertyReferenceValuePatch(candidate, nestedReferences, targetValues, targetState.definitions);
      });
      plannedOperationCount += 1 + currentDescendants.length + targetDescendants.length;
      if (plannedOperationCount > this.maxSynchronousQueryNodes) throw runtimeError("RESOURCE_LIMIT", { nodeId: componentId });
      replacementSources.push(source);
      replacedSourceRoots.add(source.id);
    });
    this.enqueueOperations(operations);
    replacementSources.forEach((source) => {
      const clone = this.projectionStore.getNode(ids.get(source.id)!);
      const references = runtimeComponentPropertyReferences(source)!;
      if (!clone) throw runtimeError("NODE_NOT_FOUND", { nodeId: source.id });
      this.enqueueOperations(this.componentPropertyReferenceOperations(clone, references, componentProperties, componentState.definitions, {}, true));
    });
    return this.containerFor(instanceId);
  }
  swapInstanceComponent(instanceId: string, componentId: string): void {
    this.assertOpen();
    const instance = this.projectionStore.getNode(instanceId);
    const component = this.projectionStore.getNode(componentId);
    const instanceMetadata = instance?.instanceMetadata as DocumentInstanceMetadata | undefined;
    const componentMetadata = component?.componentMetadata as DocumentComponentMetadata | undefined;
    if (!instance || instance.removed === true || instance.type !== "INSTANCE" || !instanceMetadata || !component || component.removed === true || component.type !== "COMPONENT" || !componentMetadata) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: instanceId });
    }
    const componentState = this.componentPropertyState(component);
    const componentProperties = componentState.values;
    const extensions = instance.extensions && typeof instance.extensions === "object" && !Array.isArray(instance.extensions)
      ? structuredClone(instance.extensions as Record<string, number[]>)
      : {};
    extensions[INSTANCE_SOURCE_NODE_EXTENSION] = [...new TextEncoder().encode(component.id)];
    const subtreeOperations = this.replaceRuntimeSubtreeOperations(component, instance, (_source, clone) => {
      const references = runtimeComponentPropertyReferences(clone);
      if (!references) return clone;
      return { ...clone, ...this.componentPropertyReferenceValuePatch(clone, references, componentProperties, componentState.definitions) };
    });
    this.enqueueOperations([{
      type: "update",
      nodeId: instance.id,
      patch: {
        extensions,
        instanceMetadata: {
          ...structuredClone(instanceMetadata),
          mainComponentId: component.id,
          componentProperties,
          overrides: [],
        },
      },
    }, ...subtreeOperations]);
  }
  detachInstance(instanceId: string): RuntimeContainerNodeProxy {
    this.assertOpen();
    const instance = this.projectionStore.getNode(instanceId);
    if (!instance || instance.removed === true) throw runtimeError("NODE_REMOVED", { nodeId: instanceId });
    if (instance.type !== "INSTANCE" || typeof instance.parentId !== "string") {
      throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: instanceId });
    }

    const subtree: RuntimeProjectionNode[] = [];
    const visited = new Set<string>();
    const visit = (node: RuntimeProjectionNode): void => {
      if (visited.has(node.id)) throw runtimeError("INVALID_ARGUMENT", { nodeId: node.id });
      visited.add(node.id);
      if (subtree.length >= this.maxSynchronousQueryNodes) throw runtimeError("RESOURCE_LIMIT", { nodeId: instanceId });
      if (node.id !== instanceId && !RUNTIME_CLONE_DESCENDANT_TYPES.has(node.type as M1SceneNodeType)) {
        throw runtimeError("UNSUPPORTED_NODE_TYPE", { nodeId: node.id });
      }
      subtree.push(node);
      this.siblingsOf(node.id).forEach(visit);
    };
    visit(instance);

    const siblings = this.siblingsOf(instance.parentId);
    const sourceIndex = siblings.findIndex((node) => node.id === instanceId);
    if (sourceIndex < 0) throw runtimeError("NODE_NOT_FOUND", { nodeId: instanceId });
    const remaining = siblings.filter((node) => node.id !== instanceId);
    const finalPositionId = typeof instance.positionId === "string" && instance.positionId
      ? instance.positionId
      : positionIdForLayerInsertion(remaining, sourceIndex);
    if (!finalPositionId) throw runtimeError("RESOURCE_LIMIT", { nodeId: instanceId });

    const ids = new Map(subtree.map((node) => [node.id, this.createId()]));
    const rootId = ids.get(instanceId)!;
    const replacements = subtree.map((source): RuntimeProjectionNode => {
      const isRoot = source.id === instanceId;
      const clone: Record<string, unknown> = {
        ...structuredClone(source),
        id: ids.get(source.id)!,
        type: isRoot ? "FRAME" : source.type,
        parentId: isRoot ? source.parentId : ids.get(source.parentId!),
        siblingIndex: source.siblingIndex,
        positionId: isRoot ? finalPositionId : source.positionId,
        name: isRoot ? `${typeof source.name === "string" ? source.name : "Instance"} detached` : source.name,
        instanceMetadata: undefined,
        removed: false,
      };
      delete clone.instanceMetadata;
      const extensions = clone.extensions && typeof clone.extensions === "object" && !Array.isArray(clone.extensions)
        ? structuredClone(clone.extensions as Record<string, number[]>)
        : {};
      delete extensions["figma.instance.metadata.v1"];
      delete extensions[INSTANCE_SOURCE_NODE_EXTENSION];
      clone.extensions = extensions;
      if (clone.vectorPath && typeof clone.vectorPath === "object") {
        const path = clone.vectorPath as DocumentVectorPath;
        clone.vectorPath = {
          ...path,
          subpaths: path.subpaths.map((subpath) => ({
            ...subpath,
            points: subpath.points.map((point) => ({ ...point, id: this.createId() })),
          })),
        };
      }
      if (clone.connectorMetadata && typeof clone.connectorMetadata === "object") {
        clone.connectorMetadata = remapRuntimeConnectorMetadata(clone.connectorMetadata as DocumentConnectorMetadata, ids);
      }
      if (Array.isArray(clone.reactions)) clone.reactions = remapRuntimeReactions(clone.reactions, ids);
      return clone as RuntimeProjectionNode;
    });
    this.enqueueOperations([{
      type: "detachInstance",
      sourceId: instanceId,
      sourceIds: subtree.map((node) => node.id),
      replacements,
      temporaryPositionId: runtimeTemporaryPositionId(rootId, finalPositionId),
      finalPositionId,
    }]);
    return this.containerFor(rootId);
  }
  createSlot(componentId: string): RuntimeContainerNodeProxy {
    this.assertOpen();
    const component = this.projectionStore.getNode(componentId);
    if (!component || component.removed === true || component.type !== "COMPONENT") {
      throw runtimeError("NODE_NOT_FOUND", { nodeId: componentId });
    }
    const metadata = component.componentMetadata as DocumentComponentMetadata | undefined;
    if (!metadata || metadata.remote) throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: componentId });
    const id = this.createId();
    const propertyName = `Slot#${id}`;
    if (metadata.componentPropertyDefinitions[propertyName]) throw runtimeError("INVALID_ARGUMENT", { nodeId: componentId });
    const linkedInstances = this.projectionStore.listLiveNodes().filter((node) => node.type === "INSTANCE" && instanceMainComponentId(node) === componentId);
    if (linkedInstances.length + 1 > this.maxSynchronousQueryNodes) throw runtimeError("RESOURCE_LIMIT", { nodeId: componentId });
    const children = this.siblingsOf(componentId);
    const positionId = positionIdForLayerInsertion(children, children.length);
    if (!positionId) throw runtimeError("RESOURCE_LIMIT", { nodeId: componentId });
    const source = structuredClone(component) as Record<string, unknown>;
    delete source.componentMetadata;
    delete source.instanceMetadata;
    delete source.componentSetMetadata;
    const slot: RuntimeProjectionNode = {
      ...source,
      id,
      type: "SLOT",
      parentId: componentId,
      pageId: this.pageIdFor(component),
      siblingIndex: children.length,
      positionId,
      name: "Slot",
      x: 0,
      y: 0,
      rotation: 0,
      relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      width: Math.max(1, (typeof component.width === "number" ? component.width : 100) / 2),
      height: Math.max(1, (typeof component.height === "number" ? component.height : 100) / 2),
      removed: false,
      extensions: {},
      slotMetadata: { propertyName },
      componentPropertyReferences: { slotContentId: propertyName },
    };
    const instanceSlotOperations = linkedInstances.map((instance): PendingProjectionOperation => {
      const instanceChildren = this.siblingsOf(instance.id);
      const instancePositionId = positionIdForLayerInsertion(instanceChildren, instanceChildren.length);
      if (!instancePositionId) throw runtimeError("RESOURCE_LIMIT", { nodeId: instance.id });
      const instanceSlotId = this.createId();
      return {
        type: "create",
        node: {
          ...structuredClone(slot),
          id: instanceSlotId,
          parentId: instance.id,
          pageId: this.pageIdFor(instance),
          siblingIndex: instanceChildren.length,
          positionId: instancePositionId,
          extensions: { [INSTANCE_SOURCE_NODE_EXTENSION]: [...new TextEncoder().encode(id)] },
          slotMetadata: { propertyName, sourceSlotId: id },
          componentPropertyReferences: { slotContentId: propertyName },
        },
      };
    });
    this.enqueueOperations([
      {
        type: "update",
        nodeId: componentId,
        patch: {
          componentMetadata: {
            ...structuredClone(metadata),
            componentPropertyDefinitions: {
              ...structuredClone(metadata.componentPropertyDefinitions),
              [propertyName]: { type: "SLOT" },
            },
          },
        },
      },
      { type: "create", node: slot },
      ...instanceSlotOperations,
    ]);
    return this.containerFor(id);
  }
  resetSlot(slotId: string): void {
    this.assertOpen();
    const slot = this.projectionStore.getNode(slotId);
    const metadata = slot?.slotMetadata as { sourceSlotId?: unknown } | undefined;
    const sourceSlotId = typeof metadata?.sourceSlotId === "string" ? metadata.sourceSlotId : undefined;
    const source = sourceSlotId ? this.projectionStore.getNode(sourceSlotId) : undefined;
    if (!slot || slot.removed === true || slot.type !== "SLOT" || !source || source.removed === true || source.type !== "SLOT") {
      throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: slotId });
    }
    this.enqueueOperations(this.replaceRuntimeSubtreeOperations(source, slot));
  }
  addComponentProperty(
    componentId: string,
    propertyName: string,
    type: RuntimeComponentPropertyType,
    defaultValue: string | boolean | RuntimeVariableAlias,
    options?: RuntimeComponentPropertyOptions,
  ): string {
    this.assertOpen();
    const context = this.mutableComponentPropertyContext(componentId);
    const { metadata, linkedInstances } = context;
    validateRuntimeComponentPropertyBaseName(propertyName, componentId);
    validateRuntimeComponentPropertyOptions(options, componentId);
    if (type === "VARIANT") {
      return this.addVariantComponentProperty(context, propertyName, defaultValue, options);
    }
    if (options?.description !== undefined && type !== "SLOT") throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: componentId });
    validateRuntimeComponentPropertyOptionCompatibility(type, options, componentId);
    const resolvedDefault = this.componentPropertyDefaultValue(type, defaultValue, componentId);
    const definition = runtimeComponentPropertyDefinition(type, resolvedDefault.value, options, componentId);
    if (resolvedDefault.alias) definition.boundVariables = { defaultValue: resolvedDefault.alias };
    if (definition.type === "INSTANCE_SWAP" && !this.isComponentPropertySwapTarget(definition.defaultValue)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: componentId });
    }
    const name = `${propertyName}#${this.createId()}`;
    if (metadata.componentPropertyDefinitions[name]) throw runtimeError("INVALID_ARGUMENT", { nodeId: componentId });
    const definitions = { ...structuredClone(metadata.componentPropertyDefinitions), [name]: definition };
    const operations = this.componentPropertyDefinitionOperations(context, definitions, undefined, name, definition);
    if (definition.type !== "SLOT" && definition.defaultValue !== undefined) {
      linkedInstances.forEach((instance) => {
        const instanceMetadata = instance.instanceMetadata as Record<string, unknown>;
        const componentProperties = instanceMetadata.componentProperties as Record<string, string | boolean>;
        operations.push({
          type: "update",
          nodeId: instance.id,
          patch: { instanceMetadata: { ...structuredClone(instanceMetadata), componentProperties: { ...structuredClone(componentProperties), [name]: definition.defaultValue! } } },
        });
      });
    }
    if (operations.length > this.maxSynchronousQueryNodes) throw runtimeError("RESOURCE_LIMIT", { nodeId: componentId });
    this.enqueueOperations(operations);
    return name;
  }

  editComponentProperty(componentId: string, propertyName: string, value: RuntimeComponentPropertyEdit): string {
    this.assertOpen();
    const context = this.mutableComponentPropertyContext(componentId);
    const { metadata, linkedInstances } = context;
    const existing = metadata.componentPropertyDefinitions[propertyName];
    if (!existing || !value || typeof value !== "object" || Array.isArray(value)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: componentId });
    }
    validateRuntimeComponentPropertyOptions(value, componentId);
    const keys = Object.keys(value);
    if (keys.some((key) => !["name", "defaultValue", "preferredValues", "description", "slotSettings"].includes(key))) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: componentId });
    }
    if (value.defaultValue !== undefined && (existing.type === "VARIANT" || existing.type === "SLOT")) {
      throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: componentId });
    }
    if (existing.type === "VARIANT") {
      return this.editVariantComponentProperty(context, propertyName, value);
    }
    if (value.description !== undefined && existing.type !== "SLOT") {
      throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: componentId });
    }
    validateRuntimeComponentPropertyOptionCompatibility(existing.type, value, componentId);
    const definition = value.defaultValue === undefined
      ? {
          ...structuredClone(existing),
          ...(value.description === undefined ? {} : { description: value.description }),
          ...(value.preferredValues === undefined ? {} : { preferredValues: value.preferredValues.map((preferred) => ({ ...preferred })) }),
          ...(value.slotSettings === undefined ? {} : { slotSettings: { ...value.slotSettings } }),
        }
      : (() => {
          const resolvedDefault = this.componentPropertyDefaultValue(existing.type, value.defaultValue!, componentId);
          const next = runtimeComponentPropertyDefinition(existing.type, resolvedDefault.value, {
            description: value.description ?? existing.description,
            preferredValues: value.preferredValues ?? existing.preferredValues,
            slotSettings: value.slotSettings ?? existing.slotSettings,
          }, componentId);
          if (resolvedDefault.alias) next.boundVariables = { defaultValue: resolvedDefault.alias };
          return next;
        })();
    if (definition.type === "INSTANCE_SWAP" && !this.isComponentPropertySwapTarget(definition.defaultValue)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: componentId });
    }
    const nextName = value.name === undefined ? propertyName : `${validatedRuntimeComponentPropertyBaseName(value.name, componentId)}#${this.createId()}`;
    if (nextName !== propertyName && metadata.componentPropertyDefinitions[nextName]) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: componentId });
    }
    const definitions = structuredClone(metadata.componentPropertyDefinitions);
    delete definitions[propertyName];
    definitions[nextName] = definition;
    const operations = this.componentPropertyDefinitionOperations(context, definitions, propertyName, nextName, definition);
    const linkedValues = new Map<string, Readonly<Record<string, string | boolean>>>();
    linkedInstances.forEach((instance) => {
      const instanceMetadata = instance.instanceMetadata as Record<string, unknown>;
      const componentProperties = { ...structuredClone(instanceMetadata.componentProperties as Record<string, string | boolean>) };
      const current = componentProperties[propertyName];
      if (nextName !== propertyName) delete componentProperties[propertyName];
      if (definition.type !== "SLOT") {
        const nextDefault = definition.defaultValue;
        if (nextDefault !== undefined && (current === undefined || current === existing.defaultValue)) componentProperties[nextName] = nextDefault;
        else if (current !== undefined) componentProperties[nextName] = current;
      }
      linkedValues.set(instance.id, componentProperties);
      operations.push({ type: "update", nodeId: instance.id, patch: { instanceMetadata: { ...structuredClone(instanceMetadata), componentProperties } } });
    });
    const sourceValues = Object.fromEntries(Object.entries(definitions).flatMap(([name, candidate]) =>
      candidate.defaultValue === undefined ? [] : [[name, candidate.defaultValue]]));
    const referenceRoots = [...context.components, ...linkedInstances];
    const referenceNodes = this.projectionStore.listLiveNodes().filter((node) =>
      Object.values(runtimeComponentPropertyReferences(node) ?? {}).includes(propertyName));
    if (referenceNodes.length > this.maxSynchronousQueryNodes) throw runtimeError("RESOURCE_LIMIT", { nodeId: componentId });
    const replacedReferenceRoots = new Set<string>();
    this.componentPropertyReferenceOrder(referenceNodes).forEach((node) => {
      if (runtimeNodeHasAncestorIn(node, replacedReferenceRoots, (id) => this.projectionStore.getNode(id))) return;
      const owner = referenceRoots.find((root) => runtimeNodeHasAncestorIn(node, new Set([root.id]), (id) => this.projectionStore.getNode(id)));
      if (!owner) return;
      const references = runtimeComponentPropertyReferences(node)!;
      const renamedReferences = Object.fromEntries(Object.entries(references).map(([field, name]) => [field, name === propertyName ? nextName : name])) as DocumentComponentPropertyReferences;
      const values = owner.id === componentId ? sourceValues : linkedValues.get(owner.id) ?? {};
      if (this.componentPropertyReferenceReplacesSubtree(node, renamedReferences, values, definitions)) replacedReferenceRoots.add(node.id);
      operations.push(...this.componentPropertyReferenceOperations(node, renamedReferences, values, definitions, { componentPropertyReferences: renamedReferences }));
    });
    if (existing.type === "SLOT" && nextName !== propertyName) {
      const roots = new Set([...context.components.map((component) => component.id), ...linkedInstances.map((instance) => instance.id)]);
      this.projectionStore.listLiveNodes()
        .filter((node) => node.type === "SLOT" && runtimeSlotPropertyName(node) === propertyName && runtimeNodeHasAncestorIn(node, roots, (id) => this.projectionStore.getNode(id)))
        .forEach((slot) => operations.push({
          type: "update",
          nodeId: slot.id,
          patch: { slotMetadata: { ...(structuredClone(slot.slotMetadata as Record<string, unknown>)), propertyName: nextName } },
        }));
    }
    if (operations.length > this.maxSynchronousQueryNodes) throw runtimeError("RESOURCE_LIMIT", { nodeId: componentId });
    this.enqueueOperations(operations);
    return nextName;
  }

  deleteComponentProperty(componentId: string, propertyName: string): void {
    this.assertOpen();
    const context = this.mutableComponentPropertyContext(componentId);
    const { metadata, linkedInstances } = context;
    const existing = metadata.componentPropertyDefinitions[propertyName];
    if (!existing) throw runtimeError("INVALID_ARGUMENT", { nodeId: componentId });
    if (existing.type === "VARIANT") throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: componentId });
    const definitions = structuredClone(metadata.componentPropertyDefinitions);
    delete definitions[propertyName];
    const operations = this.componentPropertyDefinitionOperations(context, definitions, propertyName, undefined, undefined);
    if (existing.type === "SLOT") {
      const componentIds = new Set(context.components.map((component) => component.id));
      const sourceSlots = this.projectionStore.listLiveNodes().filter((node) =>
        node.type === "SLOT" && runtimeSlotPropertyName(node) === propertyName && typeof node.parentId === "string" && componentIds.has(node.parentId));
      sourceSlots.forEach((slot) => {
        operations.push(...this.slotComponentPropertyReferenceOperations(slot, undefined, this.componentPropertyReferenceContext(slot), true));
      });
      if (operations.length > this.maxSynchronousQueryNodes) throw runtimeError("RESOURCE_LIMIT", { nodeId: componentId });
      this.enqueueOperations(operations);
      return;
    }
    linkedInstances.forEach((instance) => {
      const instanceMetadata = instance.instanceMetadata as Record<string, unknown>;
      const componentProperties = { ...structuredClone(instanceMetadata.componentProperties as Record<string, string | boolean>) };
      delete componentProperties[propertyName];
      operations.push({ type: "update", nodeId: instance.id, patch: { instanceMetadata: { ...structuredClone(instanceMetadata), componentProperties } } });
    });
    const referenceRoots = new Set([...context.components.map((component) => component.id), ...linkedInstances.map((instance) => instance.id)]);
    const referenceNodes = this.projectionStore.listLiveNodes().filter((node) =>
      runtimeNodeHasAncestorIn(node, referenceRoots, (id) => this.projectionStore.getNode(id)) &&
      Object.values(runtimeComponentPropertyReferences(node) ?? {}).includes(propertyName));
    if (referenceNodes.length > this.maxSynchronousQueryNodes) throw runtimeError("RESOURCE_LIMIT", { nodeId: componentId });
    referenceNodes.forEach((node) => {
      const references = runtimeComponentPropertyReferences(node)!;
      const retained = Object.fromEntries(Object.entries(references).filter(([, name]) => name !== propertyName)) as DocumentComponentPropertyReferences;
      operations.push({ type: "update", nodeId: node.id, patch: { componentPropertyReferences: Object.keys(retained).length ? retained : undefined } });
    });
    if (operations.length > this.maxSynchronousQueryNodes) throw runtimeError("RESOURCE_LIMIT", { nodeId: componentId });
    this.enqueueOperations(operations);
  }

  setComponentPropertyReferences(nodeId: string, value: DocumentComponentPropertyReferences | null): void {
    this.assertOpen();
    const node = this.projectionStore.getNode(nodeId);
    if (!node || node.removed === true) throw runtimeError("NODE_NOT_FOUND", { nodeId });
    const context = this.componentPropertyReferenceContext(node);
    const references = validateRuntimeComponentPropertyReferences(value, node, context.definitions, nodeId);
    if (node.type === "SLOT" || references?.slotContentId) {
      this.setSlotComponentPropertyReferences(node, references, context);
      return;
    }
    const operations: PendingProjectionOperation[] = [];
    operations.push(...(references
      ? this.componentPropertyReferenceOperations(node, references, context.values, context.definitions, { componentPropertyReferences: references })
      : [{ type: "update" as const, nodeId, patch: { componentPropertyReferences: undefined } }]));
    if (context.owner.type === "COMPONENT") {
      const linkedInstances = this.projectionStore.listLiveNodes().filter((candidate) =>
        candidate.type === "INSTANCE" && instanceMainComponentId(candidate) === context.owner.id);
      if (linkedInstances.length > this.maxSynchronousQueryNodes) throw runtimeError("RESOURCE_LIMIT", { nodeId });
      linkedInstances.forEach((instance) => {
        const values = (instance.instanceMetadata as { componentProperties?: Record<string, string | boolean> } | undefined)?.componentProperties ?? {};
        this.projectionStore.listLiveNodes()
          .filter((candidate) => runtimeNodeHasAncestorIn(candidate, new Set([instance.id]), (id) => this.projectionStore.getNode(id)) && runtimeInstanceSourceNodeId(candidate) === nodeId)
          .forEach((candidate) => operations.push(...(references
            ? this.componentPropertyReferenceOperations(candidate, references, values, context.definitions, { componentPropertyReferences: references })
            : [{ type: "update" as const, nodeId: candidate.id, patch: { componentPropertyReferences: undefined } }])));
      });
    }
    if (operations.length > this.maxSynchronousQueryNodes) throw runtimeError("RESOURCE_LIMIT", { nodeId });
    this.enqueueOperations(operations);
  }

  private setSlotComponentPropertyReferences(
    node: RuntimeProjectionNode,
    references: DocumentComponentPropertyReferences | undefined,
    context: ReturnType<RuntimeSession["componentPropertyReferenceContext"]>,
  ): void {
    this.enqueueOperations(this.slotComponentPropertyReferenceOperations(node, references, context));
  }

  private slotComponentPropertyReferenceOperations(
    node: RuntimeProjectionNode,
    references: DocumentComponentPropertyReferences | undefined,
    context: ReturnType<RuntimeSession["componentPropertyReferenceContext"]>,
    resetLinkedContents = false,
  ): PendingProjectionOperation[] {
    if (context.owner.type !== "COMPONENT" || node.parentId !== context.owner.id || !["FRAME", "SLOT"].includes(node.type)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: node.id });
    }
    const propertyName = references?.slotContentId;
    const targetType = propertyName ? "SLOT" : "FRAME";
    const linkedInstances = this.projectionStore.listLiveNodes().filter((candidate) =>
      candidate.type === "INSTANCE" && instanceMainComponentId(candidate) === context.owner.id);
    const linkedRoots = new Set(linkedInstances.map((instance) => instance.id));
    const linkedNodes = this.projectionStore.listLiveNodes().filter((candidate) =>
      runtimeInstanceSourceNodeId(candidate) === node.id &&
      runtimeNodeHasAncestorIn(candidate, linkedRoots, (id) => this.projectionStore.getNode(id)));
    if (linkedNodes.some((candidate) => !["FRAME", "SLOT"].includes(candidate.type))) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: node.id });
    }
    const sourceDescendantCount = resetLinkedContents
      ? this.projectionStore.listLiveNodes().filter((candidate) => runtimeNodeHasAncestorIn(candidate, new Set([node.id]), (id) => this.projectionStore.getNode(id))).length
      : this.siblingsOf(node.id).length;
    const linkedDescendantCount = linkedNodes.reduce((count, candidate) => count + (resetLinkedContents
      ? this.projectionStore.listLiveNodes().filter((descendant) => runtimeNodeHasAncestorIn(descendant, new Set([candidate.id]), (id) => this.projectionStore.getNode(id))).length
      : this.siblingsOf(candidate.id).length), 0);
    const touched = 1 + linkedNodes.length + sourceDescendantCount + linkedDescendantCount;
    if (touched > this.maxSynchronousQueryNodes) throw runtimeError("RESOURCE_LIMIT", { nodeId: node.id });

    const operations: PendingProjectionOperation[] = [];
    let sourceId = node.id;
    if (node.type === targetType) {
      operations.push({
        type: "update",
        nodeId: node.id,
        patch: {
          componentPropertyReferences: references,
          slotMetadata: propertyName ? { propertyName } : undefined,
        },
      });
    } else {
      const conversion = this.replaceRuntimeContainerOperation(node, targetType, {
        componentPropertyReferences: references,
        slotMetadata: propertyName ? { propertyName } : undefined,
      });
      sourceId = conversion.replacement.id;
      operations.push(conversion.operation);
    }

    linkedNodes.forEach((candidate) => {
      const extensions = candidate.extensions && typeof candidate.extensions === "object" && !Array.isArray(candidate.extensions)
        ? structuredClone(candidate.extensions as Record<string, number[]>)
        : {};
      extensions[INSTANCE_SOURCE_NODE_EXTENSION] = [...new TextEncoder().encode(sourceId)];
      const patch = {
        componentPropertyReferences: references,
        slotMetadata: propertyName ? { propertyName, sourceSlotId: sourceId } : undefined,
        extensions,
      };
      if (candidate.type === targetType) {
        operations.push({ type: "update", nodeId: candidate.id, patch });
        return;
      }
      let childIds: readonly string[] | undefined;
      if (resetLinkedContents && node.type === "SLOT" && candidate.type === "SLOT") {
        const resetOperations = this.replaceRuntimeSubtreeOperations(node, candidate);
        operations.push(...resetOperations);
        childIds = resetOperations.flatMap((operation) => operation.type === "create" && operation.node.parentId === candidate.id ? [operation.node.id] : []);
      }
      operations.push(this.replaceRuntimeContainerOperation(candidate, targetType, patch, childIds).operation);
    });
    return operations;
  }

  private replaceRuntimeContainerOperation(
    source: RuntimeProjectionNode,
    type: "FRAME" | "SLOT",
    patch: Readonly<Record<string, unknown>>,
    childIds: readonly string[] = this.siblingsOf(source.id).map((child) => child.id),
  ): Readonly<{
    replacement: RuntimeProjectionNode;
    operation: Extract<PendingProjectionOperation, { type: "replaceContainer" }>;
  }> {
    if (typeof source.parentId !== "string") throw runtimeError("INVALID_ARGUMENT", { nodeId: source.id });
    const siblings = this.siblingsOf(source.parentId);
    const sourceIndex = siblings.findIndex((candidate) => candidate.id === source.id);
    const id = this.createId();
    const finalPositionId = typeof source.positionId === "string" && source.positionId
      ? source.positionId
      : positionIdForLayerInsertion(siblings.filter((candidate) => candidate.id !== source.id), sourceIndex);
    if (sourceIndex < 0 || !finalPositionId) throw runtimeError("INVALID_ARGUMENT", { nodeId: source.id });
    const replacement: RuntimeProjectionNode = {
      ...structuredClone(source),
      ...structuredClone(patch),
      id,
      type,
      removed: false,
      positionId: finalPositionId,
      siblingIndex: sourceIndex,
    };
    if (type === "FRAME") {
      const extensions = replacement.extensions && typeof replacement.extensions === "object" && !Array.isArray(replacement.extensions)
        ? structuredClone(replacement.extensions as Record<string, number[]>)
        : {};
      delete extensions["figma.slot.metadata.v1"];
      (replacement as Record<string, unknown>).extensions = extensions;
    }
    return {
      replacement,
      operation: {
        type: "replaceContainer",
        sourceId: source.id,
        replacement,
        childIds,
        temporaryPositionId: runtimeTemporaryPositionId(id, finalPositionId),
        finalPositionId,
      },
    };
  }

  renameVariantComponent(componentId: string, name: string): boolean {
    this.assertOpen();
    const component = this.projectionStore.getNode(componentId);
    const parent = component?.type === "COMPONENT" && typeof component.parentId === "string"
      ? this.projectionStore.getNode(component.parentId)
      : undefined;
    if (!component || component.removed === true || parent?.type !== "COMPONENT_SET") return false;
    if (component.name === name) return true;
    const context = this.mutableComponentPropertyContext(parent.id);
    const metadata = context.metadata as DocumentComponentSetMetadata;
    const candidates = context.components.map((candidate) => candidate.id === componentId ? { ...structuredClone(candidate), name } : candidate);
    const variantMetadata = runtimeVariantMetadata(candidates);
    const variantNames = Object.keys(variantMetadata.variantGroupProperties);
    if (!variantNames.length || candidates.some((candidate) => {
      const properties = runtimeVariantProperties(candidate);
      return variantNames.some((property) => properties[property] === undefined);
    })) throw runtimeError("INVALID_ARGUMENT", { nodeId: componentId });
    const tuples = candidates.map((candidate) => JSON.stringify(variantNames.map((property) => runtimeVariantProperties(candidate)[property])));
    if (new Set(tuples).size !== tuples.length) throw runtimeError("INVALID_ARGUMENT", { nodeId: componentId });
    const customDefinitions = Object.fromEntries(Object.entries(metadata.componentPropertyDefinitions).filter(([, definition]) => definition.type !== "VARIANT"));
    const definitions = { ...variantMetadata.componentPropertyDefinitions, ...structuredClone(customDefinitions) };
    const previousVariantNames = new Set(Object.entries(metadata.componentPropertyDefinitions).flatMap(([property, definition]) => definition.type === "VARIANT" ? [property] : []));
    const propertiesByComponent = new Map(candidates.map((candidate) => [candidate.id, runtimeVariantProperties(candidate)]));
    const operations: PendingProjectionOperation[] = [{
      type: "update",
      nodeId: parent.id,
      patch: {
        componentSetMetadata: {
          ...structuredClone(metadata),
          componentPropertyDefinitions: definitions,
          variantGroupProperties: variantMetadata.variantGroupProperties,
        },
      },
    }, { type: "update", nodeId: componentId, patch: { name } }];
    context.linkedInstances.forEach((instance) => {
      const instanceMetadata = instance.instanceMetadata as DocumentInstanceMetadata;
      const componentProperties = structuredClone(instanceMetadata.componentProperties);
      previousVariantNames.forEach((property) => { delete componentProperties[property]; });
      const sourceProperties = propertiesByComponent.get(instanceMainComponentId(instance) ?? "") ?? {};
      variantNames.forEach((property) => {
        const value = sourceProperties[property] ?? variantMetadata.componentPropertyDefinitions[property]?.defaultValue;
        if (typeof value === "string") componentProperties[property] = value;
      });
      operations.push({
        type: "update",
        nodeId: instance.id,
        patch: { instanceMetadata: { ...structuredClone(instanceMetadata), componentProperties } },
      });
    });
    if (operations.length > this.maxSynchronousQueryNodes) throw runtimeError("RESOURCE_LIMIT", { nodeId: componentId });
    this.enqueueOperations(operations);
    return true;
  }

  setInstanceExposed(instanceId: string, value: boolean): void {
    this.assertOpen();
    const source = this.projectionStore.getNode(instanceId);
    const sourceMetadata = source?.instanceMetadata as DocumentInstanceMetadata | undefined;
    if (!source || source.removed === true || source.type !== "INSTANCE" || !sourceMetadata) {
      throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: instanceId });
    }
    let current = typeof source.parentId === "string" ? this.projectionStore.getNode(source.parentId) : undefined;
    const visited = new Set<string>();
    let owner: RuntimeProjectionNode | undefined;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      if (current.type === "INSTANCE") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: instanceId });
      if (current.type === "COMPONENT") { owner = current; break; }
      current = typeof current.parentId === "string" ? this.projectionStore.getNode(current.parentId) : undefined;
    }
    const ownerMetadata = owner?.componentMetadata as DocumentComponentMetadata | undefined;
    if (!owner || !ownerMetadata || ownerMetadata.remote) throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: instanceId });
    const ownerId = owner.id;
    const linkedRoots = new Set(this.projectionStore.listLiveNodes().filter((node) =>
      node.type === "INSTANCE" && instanceMainComponentId(node) === ownerId).map((node) => node.id));
    const inherited = this.projectionStore.listLiveNodes().filter((node) =>
      node.type === "INSTANCE" &&
      runtimeInstanceSourceNodeId(node) === source.id &&
      runtimeNodeHasAncestorIn(node, linkedRoots, (id) => this.projectionStore.getNode(id)));
    if (inherited.length + 1 > this.maxSynchronousQueryNodes) throw runtimeError("RESOURCE_LIMIT", { nodeId: instanceId });
    this.enqueueOperations([source, ...inherited].map((node) => {
      const metadata = node.instanceMetadata as DocumentInstanceMetadata;
      return {
        type: "update" as const,
        nodeId: node.id,
        patch: { instanceMetadata: { ...structuredClone(metadata), isExposedInstance: value } },
      };
    }));
  }

  setInstanceProperties(instanceId: string, properties: Readonly<Record<string, string | boolean>>): void {
    this.assertOpen();
    const instance = this.projectionStore.getNode(instanceId);
    const instanceMetadata = instance?.instanceMetadata as DocumentInstanceMetadata | undefined;
    if (!instance || instance.removed === true || instance.type !== "INSTANCE" || !instanceMetadata) {
      throw runtimeError("RESOURCE_UNAVAILABLE", { nodeId: instanceId });
    }
    const mainComponentId = instanceMainComponentId(instance);
    const component = mainComponentId ? this.projectionStore.getNode(mainComponentId) : undefined;
    if (!component || component.type !== "COMPONENT" || !component.componentMetadata) throw runtimeError("RESOURCE_UNAVAILABLE", { nodeId: instanceId });
    const sourceState = this.componentPropertyState(component);
    const nextRequested = { ...sourceState.values, ...structuredClone(instanceMetadata.componentProperties), ...structuredClone(properties) };
    for (const [name, value] of Object.entries(properties)) {
      const definition = sourceState.definitions[name];
      if (!definition || definition.type === "SLOT") throw runtimeError("INVALID_ARGUMENT", { nodeId: instanceId });
      if (definition.type === "BOOLEAN" ? typeof value !== "boolean" : typeof value !== "string") {
        throw runtimeError("INVALID_ARGUMENT", { nodeId: instanceId });
      }
      if (definition.type === "INSTANCE_SWAP" && !this.isComponentPropertySwapTarget(value)) {
        throw runtimeError("INVALID_ARGUMENT", { nodeId: instanceId });
      }
      if (definition.type === "VARIANT" && definition.variantOptions && !definition.variantOptions.includes(value as string)) {
        throw runtimeError("INVALID_ARGUMENT", { nodeId: instanceId });
      }
    }
    const target = this.variantTargetForProperties(component, sourceState, nextRequested, instanceId);
    const targetState = this.componentPropertyState(target);
    const componentProperties = { ...targetState.values };
    Object.entries(nextRequested).forEach(([name, value]) => {
      const before = sourceState.definitions[name];
      const after = targetState.definitions[name];
      if (before && after && before.type === after.type && after.type !== "SLOT") componentProperties[name] = value;
    });
    if (targetState.componentSet) Object.assign(componentProperties, targetState.variantProperties);
    const operations: PendingProjectionOperation[] = [];
    if (target.id !== component.id) {
      const overridePlan = this.variantOverridePlan(instance, target);
      const nextOverrides: DocumentInstanceMetadata["overrides"] = [];
      const subtreeOperations = this.replaceRuntimeSubtreeOperations(target, instance, (source, clone) => {
        const references = runtimeComponentPropertyReferences(clone);
        const patched = references
          ? { ...clone, ...this.componentPropertyReferenceValuePatch(clone, references, componentProperties, targetState.definitions) }
          : clone;
        const override = overridePlan.get(source.id);
        if (!override) return patched;
        const mutable = patched as Record<string, unknown>;
        const retainedFields = override.fields.filter((field) => !RUNTIME_STRUCTURAL_OVERRIDE_FIELDS.has(field) && Object.hasOwn(override.node, field));
        retainedFields.forEach((field) => { mutable[field] = structuredClone(override.node[field]); });
        if (retainedFields.length) nextOverrides.push({ id: clone.id, overriddenFields: retainedFields });
        return patched;
      });
      const extensions = instance.extensions && typeof instance.extensions === "object" && !Array.isArray(instance.extensions)
        ? structuredClone(instance.extensions as Record<string, number[]>)
        : {};
      extensions[INSTANCE_SOURCE_NODE_EXTENSION] = [...new TextEncoder().encode(target.id)];
      operations.push({
        type: "update",
        nodeId: instanceId,
        patch: {
          extensions,
          instanceMetadata: {
            ...structuredClone(instanceMetadata),
            mainComponentId: target.id,
            componentProperties,
            overrides: nextOverrides,
          },
        },
      }, ...subtreeOperations);
    } else {
      operations.push({
        type: "update",
        nodeId: instanceId,
        patch: { instanceMetadata: { ...structuredClone(instanceMetadata), componentProperties } },
      });
    }
    const descendants = this.projectionStore.listLiveNodes().filter((node) =>
      node.id !== instanceId && runtimeNodeHasAncestorIn(node, new Set([instanceId]), (id) => this.projectionStore.getNode(id)));
    if (descendants.length > this.maxSynchronousQueryNodes) throw runtimeError("RESOURCE_LIMIT", { nodeId: instanceId });
    if (target.id === component.id) {
      const replacedReferenceRoots = new Set<string>();
      this.componentPropertyReferenceOrder(descendants.filter((descendant) => runtimeComponentPropertyReferences(descendant))).forEach((descendant) => {
        if (runtimeNodeHasAncestorIn(descendant, replacedReferenceRoots, (id) => this.projectionStore.getNode(id))) return;
        const references = runtimeComponentPropertyReferences(descendant)!;
        if (this.componentPropertyReferenceReplacesSubtree(descendant, references, componentProperties, targetState.definitions)) replacedReferenceRoots.add(descendant.id);
        operations.push(...this.componentPropertyReferenceOperations(descendant, references, componentProperties, targetState.definitions));
      });
    }
    if (operations.length > this.maxSynchronousQueryNodes) throw runtimeError("RESOURCE_LIMIT", { nodeId: instanceId });
    this.enqueueOperations(operations);
  }

  private componentPropertyReferenceContext(node: RuntimeProjectionNode): Readonly<{
    owner: RuntimeProjectionNode;
    definitions: DocumentComponentMetadata["componentPropertyDefinitions"];
    values: Readonly<Record<string, string | boolean>>;
  }> {
    let current = typeof node.parentId === "string" ? this.projectionStore.getNode(node.parentId) : undefined;
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      if (current.type === "COMPONENT") {
        const metadata = current.componentMetadata as DocumentComponentMetadata | undefined;
        if (!metadata || metadata.remote || !metadata.componentPropertyDefinitions || typeof metadata.componentPropertyDefinitions !== "object") {
          throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: node.id });
        }
        const values = Object.fromEntries(Object.entries(metadata.componentPropertyDefinitions).flatMap(([name, definition]) =>
          definition.defaultValue === undefined ? [] : [[name, definition.defaultValue]]));
        return { owner: current, definitions: metadata.componentPropertyDefinitions, values };
      }
      if (current.type === "INSTANCE") {
        const metadata = current.instanceMetadata as Record<string, unknown> | undefined;
        const mainComponentId = instanceMainComponentId(current);
        const main = mainComponentId ? this.projectionStore.getNode(mainComponentId) : undefined;
        const mainMetadata = main?.componentMetadata as DocumentComponentMetadata | undefined;
        const componentProperties = metadata?.componentProperties;
        if (!metadata || !mainMetadata?.componentPropertyDefinitions || typeof mainMetadata.componentPropertyDefinitions !== "object" || !componentProperties || typeof componentProperties !== "object" || Array.isArray(componentProperties)) {
          throw runtimeError("RESOURCE_UNAVAILABLE", { nodeId: node.id });
        }
        return {
          owner: current,
          definitions: mainMetadata.componentPropertyDefinitions,
          values: componentProperties as Record<string, string | boolean>,
        };
      }
      current = typeof current.parentId === "string" ? this.projectionStore.getNode(current.parentId) : undefined;
    }
    throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: node.id });
  }

  private componentPropertyReferenceValuePatch(
    node: RuntimeProjectionNode,
    references: DocumentComponentPropertyReferences,
    values: Readonly<Record<string, string | boolean>>,
    definitions: DocumentComponentMetadata["componentPropertyDefinitions"],
  ): Readonly<Record<string, unknown>> {
    const patch: Record<string, unknown> = {};
    if (references.visible) {
      const value = values[references.visible] ?? definitions[references.visible]?.defaultValue;
      if (typeof value === "boolean") patch.visible = value;
    }
    if (references.characters) {
      const value = values[references.characters] ?? definitions[references.characters]?.defaultValue;
      if (typeof value === "string" && ["TEXT", "TEXT_PATH"].includes(node.type)) {
        const before = typeof node.characters === "string" ? node.characters : "";
        const properties = node.textProperties as DocumentTextProperties | undefined;
        this.assertFontsLoaded(fontsForRuntimeTextRange(before, properties));
        Object.assign(patch, updateRuntimeText(before, value, properties));
      }
    }
    if (references.mainComponent) {
      const value = values[references.mainComponent] ?? definitions[references.mainComponent]?.defaultValue;
      const target = typeof value === "string" ? this.projectionStore.getNode(value) : undefined;
      const targetMetadata = target?.componentMetadata as DocumentComponentMetadata | undefined;
      const currentMetadata = node.instanceMetadata as Record<string, unknown> | undefined;
      if (node.type === "INSTANCE" && target?.type === "COMPONENT" && targetMetadata && currentMetadata) {
        patch.instanceMetadata = {
          ...structuredClone(currentMetadata),
          mainComponentId: target.id,
          componentProperties: Object.fromEntries(Object.entries(targetMetadata.componentPropertyDefinitions).flatMap(([name, definition]) =>
            definition.type === "SLOT" || definition.defaultValue === undefined ? [] : [[name, definition.defaultValue]])),
          overrides: [],
        };
      }
    }
    return patch;
  }

  private componentPropertyReferenceOperations(
    node: RuntimeProjectionNode,
    references: DocumentComponentPropertyReferences,
    values: Readonly<Record<string, string | boolean>>,
    definitions: DocumentComponentMetadata["componentPropertyDefinitions"],
    extraPatch: Readonly<Record<string, unknown>> = {},
    forceSubtreeReplacement = false,
  ): PendingProjectionOperation[] {
    const patch = { ...extraPatch, ...this.componentPropertyReferenceValuePatch(node, references, values, definitions) };
    const operations: PendingProjectionOperation[] = Object.keys(patch).length
      ? [{ type: "update", nodeId: node.id, patch }]
      : [];
    const target = this.componentPropertyReferenceTarget(node, references, values, definitions);
    if (!target || (!forceSubtreeReplacement && instanceMainComponentId(node) === target.id)) return operations;
    const targetMetadata = target.componentMetadata as DocumentComponentMetadata | undefined;
    if (!targetMetadata) throw runtimeError("RESOURCE_UNAVAILABLE", { nodeId: node.id });
    const targetValues = Object.fromEntries(Object.entries(targetMetadata.componentPropertyDefinitions).flatMap(([name, definition]) =>
      definition.type === "SLOT" || definition.defaultValue === undefined ? [] : [[name, definition.defaultValue]]));
    operations.push(...this.replaceRuntimeSubtreeOperations(target, node, (_source, clone) => {
      const nestedReferences = runtimeComponentPropertyReferences(clone);
      return nestedReferences
        ? { ...clone, ...this.componentPropertyReferenceValuePatch(clone, nestedReferences, targetValues, targetMetadata.componentPropertyDefinitions) }
        : clone;
    }));
    return operations;
  }

  private componentPropertyReferenceReplacesSubtree(
    node: RuntimeProjectionNode,
    references: DocumentComponentPropertyReferences,
    values: Readonly<Record<string, string | boolean>>,
    definitions: DocumentComponentMetadata["componentPropertyDefinitions"],
  ): boolean {
    const target = this.componentPropertyReferenceTarget(node, references, values, definitions);
    return Boolean(target && instanceMainComponentId(node) !== target.id);
  }

  private componentPropertyReferenceTarget(
    node: RuntimeProjectionNode,
    references: DocumentComponentPropertyReferences,
    values: Readonly<Record<string, string | boolean>>,
    definitions: DocumentComponentMetadata["componentPropertyDefinitions"],
  ): RuntimeProjectionNode | undefined {
    if (node.type !== "INSTANCE" || !references.mainComponent) return undefined;
    const targetId = values[references.mainComponent] ?? definitions[references.mainComponent]?.defaultValue;
    const target = typeof targetId === "string" ? this.projectionStore.getNode(targetId) : undefined;
    return target?.type === "COMPONENT" && target.removed !== true ? target : undefined;
  }

  private componentPropertyReferenceOrder(nodes: readonly RuntimeProjectionNode[]): RuntimeProjectionNode[] {
    const depths = new Map<string, number>();
    const depth = (node: RuntimeProjectionNode): number => {
      const chain: RuntimeProjectionNode[] = [];
      const visited = new Set<string>();
      let current: RuntimeProjectionNode | undefined = node;
      while (current && !depths.has(current.id) && !visited.has(current.id)) {
        visited.add(current.id);
        chain.push(current);
        current = typeof current.parentId === "string" ? this.projectionStore.getNode(current.parentId) : undefined;
      }
      let result = current ? depths.get(current.id) ?? 0 : -1;
      chain.reverse().forEach((candidate) => {
        result += 1;
        depths.set(candidate.id, result);
      });
      return depths.get(node.id) ?? 0;
    };
    return nodes.map((node) => ({ node, depth: depth(node) }))
      .sort((left, right) => left.depth - right.depth)
      .map(({ node }) => node);
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

  createGif(hash: string): RuntimeNodeProxy {
    this.assertOpen();
    if (!hash) throw runtimeError("INVALID_ARGUMENT");
    const assets = this.projectionStore.getNode(this.rootNodeId)?.assets;
    const asset = Array.isArray(assets)
      ? assets.find((candidate): candidate is DocumentAsset => Boolean(
          candidate
          && typeof candidate === "object"
          && (candidate as DocumentAsset).assetId === hash
          && (candidate as DocumentAsset).mediaType === "image/gif",
        ))
      : undefined;
    if (!asset || !Number.isFinite(asset.pixelWidth) || !Number.isFinite(asset.pixelHeight)
      || (asset.pixelWidth ?? 0) <= 0 || (asset.pixelHeight ?? 0) <= 0) {
      throw runtimeError("RESOURCE_UNAVAILABLE");
    }
    return this.createNode("MEDIA", {
      name: "Gif",
      assetId: asset.assetId,
      width: asset.pixelWidth,
      height: asset.pixelHeight,
      mediaMetadata: { hash: asset.assetId },
    });
  }

  async createLinkPreviewAsync(url: string, timeoutMs?: number): Promise<RuntimeNodeProxy> {
    this.assertOpen();
    if (!validRuntimeHttpUrl(url) || !this.resourceTransport.resolveLinkPreviewAsync) {
      throw runtimeError("RESOURCE_UNAVAILABLE");
    }
    const preview = await this.resourceTransport.resolveLinkPreviewAsync(url, timeoutMs);
    this.assertOpen();
    if (preview.type === "EMBED" && validRuntimeEmbedMetadata(preview.data)) {
      return this.createNode("EMBED", {
        name: preview.data.title || "Embed",
        width: 360,
        height: 240,
        embedMetadata: structuredClone(preview.data),
      });
    }
    if (preview.type === "LINK_UNFURL" && validRuntimeLinkUnfurlMetadata(preview.data)) {
      return this.createNode("LINK_UNFURL", {
        name: preview.data.title || "Link unfurl",
        width: 360,
        height: 180,
        linkUnfurlMetadata: structuredClone(preview.data),
      });
    }
    throw runtimeError("RESOURCE_UNAVAILABLE");
  }

  combineAsVariants(
    nodes: readonly RuntimeNodeProxy[],
    parent: RuntimeContainerNodeProxy,
    index?: number,
  ): RuntimeContainerNodeProxy {
    this.assertOpen();
    if (
      parent.handle.sessionId !== this.sessionId ||
      parent.removed ||
      !["PAGE", "FRAME", "SECTION"].includes(parent.type) ||
      !nodes.length ||
      new Set(nodes.map((node) => node.id)).size !== nodes.length
    ) throw runtimeError("INVALID_ARGUMENT", { nodeId: parent.handle.nodeId });
    const parentNode = this.projectionStore.getNode(parent.id)!;
    const pageId = this.pageIdFor(parentNode);
    if (!pageId || runtimeOwnsAutoLayout(parentNode) || runtimeBooleanHasImmutableAncestor((nodeId) => this.projectionStore.getNode(nodeId), parentNode)) {
      throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: parent.id });
    }
    const selected = nodes.map((proxy) => {
      if (proxy.handle.sessionId !== this.sessionId || proxy.removed || proxy.type !== "COMPONENT") {
        throw runtimeError("INVALID_ARGUMENT", { nodeId: proxy.handle.nodeId });
      }
      const node = this.projectionStore.getNode(proxy.id);
      const metadata = node?.componentMetadata as DocumentComponentMetadata | undefined;
      const sourceParent = node?.parentId ? this.projectionStore.getNode(node.parentId) : undefined;
      if (
        !node ||
        !metadata ||
        metadata.remote ||
        this.pageIdFor(node) !== pageId ||
        !sourceParent ||
        sourceParent.type === "GROUP" ||
        sourceParent.type === "BOOLEAN_OPERATION" ||
        sourceParent.type === "COMPONENT_SET" ||
        runtimeOwnsAutoLayout(sourceParent) ||
        runtimeBooleanHasImmutableAncestor((nodeId) => this.projectionStore.getNode(nodeId), node)
      ) throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: proxy.id });
      return node;
    });
    const orderedSelected = sortRuntimeNodesByDocumentOrder(this.projectionStore.listLiveNodes(), selected, pageId);
    const selectedIds = new Set(orderedSelected.map((node) => node.id));
    const remaining = this.siblingsOf(parent.id).filter((node) => !selectedIds.has(node.id));
    const destination = index ?? remaining.length;
    if (!Number.isSafeInteger(destination) || destination < 0 || destination > remaining.length) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: parent.id });
    }
    const childWorldTransforms = orderedSelected.map((node) => runtimeWorldTransformForNode((nodeId) => this.projectionStore.getNode(nodeId), node));
    if (childWorldTransforms.some((transform) => !transform)) throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: parent.id });
    const bounds = orderedSelected.map((node, selectedIndex) => runtimeBoundsForTransform(node, childWorldTransforms[selectedIndex]!));
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
    const positionId = positionIdForLayerInsertion(remaining, destination);
    if (!positionId) throw runtimeError("RESOURCE_LIMIT", { nodeId: parent.id });
    const componentSet: RuntimeProjectionNode = {
      id,
      type: "COMPONENT_SET",
      parentId: parent.id,
      pageId,
      name: "Component set",
      x: wrapperLocal.e,
      y: wrapperLocal.f,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
      rotation: Math.atan2(wrapperLocal.b, wrapperLocal.a) * 180 / Math.PI,
      relativeTransform: wrapperLocal,
      fill: "transparent",
      stroke: "transparent",
      strokeWidth: 0,
      opacity: 1,
      visible: true,
      siblingIndex: destination,
      positionId,
      componentSetMetadata: {
        key: id,
        remote: false,
        description: "",
        descriptionMarkdown: "",
        documentationLinks: [],
        ...runtimeVariantMetadata(orderedSelected),
      },
    };
    const childPositions: Readonly<Record<string, unknown>>[] = [];
    const childPatches = orderedSelected.map((component, siblingIndex): Readonly<Record<string, unknown>> => {
      const childPositionId = positionIdForLayerInsertion(childPositions, childPositions.length);
      if (!childPositionId) throw runtimeError("RESOURCE_LIMIT", { nodeId: component.id });
      childPositions.push({ positionId: childPositionId });
      return {
        parentId: id,
        siblingIndex,
        positionId: childPositionId,
        ...runtimeBooleanOperandPatch(multiplyRuntimeTransforms(wrapperInverse, childWorldTransforms[siblingIndex]!)),
      };
    });
    const siblingIndexes: Array<Readonly<{ nodeId: string; siblingIndex: number }>> = [];
    [...remaining.slice(0, destination), componentSet, ...remaining.slice(destination)].forEach((sibling, siblingIndex) => {
      if (sibling.id !== id && sibling.siblingIndex !== siblingIndex) {
        siblingIndexes.push({ nodeId: sibling.id, siblingIndex });
      }
    });
    for (const sourceParentId of new Set(orderedSelected.map((component) => component.parentId))) {
      if (sourceParentId === parent.id) continue;
      this.siblingsOf(sourceParentId)
        .filter((sibling) => !selectedIds.has(sibling.id))
        .forEach((sibling, siblingIndex) => {
          if (sibling.siblingIndex !== siblingIndex) siblingIndexes.push({ nodeId: sibling.id, siblingIndex });
        });
    }
    this.enqueueOperations([{
      type: "componentSet",
      node: componentSet,
      childIds: orderedSelected.map((component) => component.id),
      childPatches,
      siblingIndexes,
    }]);
    return this.containerFor(id);
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
    const sourceProxy = nodes[0]!;
    if (sourceProxy.handle.sessionId !== this.sessionId || sourceProxy.removed) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: sourceProxy.handle.nodeId });
    }
    if (["VECTOR", "RECTANGLE", "ELLIPSE", "POLYGON", "STAR", "LINE"].includes(sourceProxy.type)) {
      return this.flattenVectorLikeNode(sourceProxy, parent, index);
    }
    const booleanProxy = sourceProxy;
    if (booleanProxy.type !== "BOOLEAN_OPERATION") throw runtimeError("INVALID_ARGUMENT", { nodeId: booleanProxy.handle.nodeId });
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

  private flattenVectorLikeNode(sourceProxy: RuntimeNodeProxy, parent?: RuntimeContainerNodeProxy, index?: number): RuntimeNodeProxy {
    const source = this.projectionStore.getNode(sourceProxy.id)!;
    if (!this.projectionStore.confirmedProjection.nodes.some((node) => node.id === source.id && node.removed !== true) || this.queuedTransactionId) {
      throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: source.id });
    }
    const targetParent = parent ?? this.currentPage;
    if (targetParent.handle.sessionId !== this.sessionId || targetParent.removed || !["PAGE", "FRAME", "GROUP", "SECTION", "COMPONENT", "BOOLEAN_OPERATION", "TRANSFORM_GROUP"].includes(targetParent.type)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: targetParent.handle.nodeId });
    }
    const targetParentNode = this.projectionStore.getNode(targetParent.id)!;
    if (this.pageIdFor(targetParentNode) !== this.pageIdFor(source) || runtimeBooleanHasImmutableAncestor((nodeId) => this.projectionStore.getNode(nodeId), source) || runtimeBooleanHasImmutableAncestor((nodeId) => this.projectionStore.getNode(nodeId), targetParentNode)) {
      throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: source.id });
    }
    const movesAcrossParents = targetParent.id !== source.parentId;
    const sourceParent = typeof source.parentId === "string" ? this.projectionStore.getNode(source.parentId) : undefined;
    if (movesAcrossParents && (
      runtimeOwnsAutoLayout(targetParentNode)
      || runtimeOwnsAutoLayout(sourceParent ?? { id: "", type: "" })
      || sourceParent?.type === "GROUP"
      || sourceParent?.type === "BOOLEAN_OPERATION"
    )) throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: source.id });
    const targetSiblings = this.siblingsOf(targetParent.id).filter((node) => node.id !== source.id);
    const destination = index ?? targetSiblings.length;
    if (!Number.isSafeInteger(destination) || destination < 0 || destination > targetSiblings.length) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: targetParent.id });
    }
    const sourceWorld = runtimeWorldTransformForNode((nodeId) => this.projectionStore.getNode(nodeId), source);
    const targetParentWorld = runtimeWorldTransformForNode((nodeId) => this.projectionStore.getNode(nodeId), targetParentNode);
    const targetParentInverse = targetParentWorld && invertRuntimeTransform(targetParentWorld);
    if (!sourceWorld || !targetParentInverse) throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: source.id });
    const replacementLocal = multiplyRuntimeTransforms(targetParentInverse, sourceWorld);
    const kind = sourceProxy.type === "VECTOR" ? "vector" : sourceProxy.type === "RECTANGLE" ? "rectangle" : sourceProxy.type === "ELLIPSE" ? "ellipse" : sourceProxy.type === "POLYGON" ? "polygon" : sourceProxy.type === "STAR" ? "star" : "line";
    const resolvedPath = resolveTextPathVectorPath({
      kind,
      width: typeof source.width === "number" ? source.width : 0,
      height: typeof source.height === "number" ? source.height : 0,
      radius: typeof source.radius === "number" ? source.radius : 0,
      cornerRadii: source.cornerRadii as [number, number, number, number] | undefined,
      arcData: source.arcData as NonNullable<Parameters<typeof resolveTextPathVectorPath>[0]["arcData"]> | undefined,
      parametricShape: source.parametricShape as NonNullable<Parameters<typeof resolveTextPathVectorPath>[0]["parametricShape"]> | undefined,
      vectorPath: source.vectorPath as DocumentVectorPath | undefined,
    }, this.createId);
    if (!resolvedPath) throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: source.id });
    const vectorPath: DocumentVectorPath = kind === "vector"
      ? {
          fillRule: resolvedPath.fillRule,
          subpaths: resolvedPath.subpaths.map((subpath) => ({
            closed: subpath.closed,
            points: subpath.points.map((point) => ({ ...structuredClone(point), id: this.createId() })),
          })),
        }
      : resolvedPath;
    const replacementId = this.createId();
    const replacementPositionId = positionIdForLayerInsertion(targetSiblings, destination);
    if (!replacementPositionId) throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: source.id });
    const replacement: RuntimeProjectionNode = {
      ...structuredClone(source),
      id: replacementId,
      type: "VECTOR",
      name: `${typeof source.name === "string" ? source.name : source.type} flattened`,
      parentId: targetParent.id,
      x: replacementLocal.e,
      y: replacementLocal.f,
      rotation: Math.atan2(replacementLocal.b, replacementLocal.a) * 180 / Math.PI,
      relativeTransform: replacementLocal,
      siblingIndex: destination,
      positionId: replacementPositionId,
      vectorPath,
      arcData: undefined,
      parametricShape: undefined,
      booleanOperation: undefined,
      radius: 0,
      cornerRadii: undefined,
      cornerSmoothing: 0,
      removed: false,
    };
    const siblingIndexes = [...targetSiblings.slice(0, destination), replacement, ...targetSiblings.slice(destination)].flatMap((sibling, siblingIndex) =>
      sibling.id === replacementId || sibling.siblingIndex === siblingIndex ? [] : [{ nodeId: sibling.id, siblingIndex }]);
    if (movesAcrossParents) {
      this.siblingsOf(source.parentId)
        .filter((sibling) => sibling.id !== source.id)
        .forEach((sibling, siblingIndex) => {
          if (sibling.siblingIndex !== siblingIndex) siblingIndexes.push({ nodeId: sibling.id, siblingIndex });
        });
    }
    this.enqueueOperations([{ type: "flattenNode", sourceId: source.id, replacement, siblingIndexes }]);
    return this.proxyFor(replacementId);
  }

  createNode(type: M1SceneNodeType, initial: Readonly<Record<string, unknown>> = {}): RuntimeNodeProxy {
    this.assertOpen();
    if (!CREATABLE_TYPES.has(type)) throw runtimeError("UNSUPPORTED_NODE_TYPE");
    const parent = this.currentPage;
    const id = this.createId();
    const typeDefaults = type === "COMPONENT"
      ? {
          componentMetadata: {
            key: id,
            remote: false,
            description: "",
            descriptionMarkdown: "",
            documentationLinks: [],
            componentPropertyDefinitions: {},
          } satisfies DocumentComponentMetadata,
        }
      : type === "SLICE"
        ? { fill: "transparent", stroke: "transparent", strokeWidth: 0 }
        : {};
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
      ...typeDefaults,
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
    this.assertOpen();
    const source = this.projectionStore.getNode(nodeId);
    if (!source || source.removed === true) throw runtimeError("NODE_REMOVED", { nodeId });
    if (!RUNTIME_CLONE_TYPES.has(source.type as M1SceneNodeType)) {
      throw runtimeError("UNSUPPORTED_NODE_TYPE", { nodeId });
    }

    const subtree: RuntimeProjectionNode[] = [];
    const visited = new Set<string>();
    const visit = (node: RuntimeProjectionNode): void => {
      if (visited.has(node.id)) throw runtimeError("INVALID_ARGUMENT", { nodeId: node.id });
      visited.add(node.id);
      if (subtree.length >= this.maxSynchronousQueryNodes) throw runtimeError("RESOURCE_LIMIT", { nodeId });
      if (!(node.id === source.id ? RUNTIME_CLONE_TYPES : RUNTIME_CLONE_DESCENDANT_TYPES).has(node.type as M1SceneNodeType)) {
        throw runtimeError("UNSUPPORTED_NODE_TYPE", { nodeId: node.id });
      }
      subtree.push(node);
      this.siblingsOf(node.id).forEach(visit);
    };
    visit(source);

    const currentPage = this.projectionStore.getNode(this.currentPageId)!;
    const sourceWorld = runtimeWorldTransformForNode((id) => this.projectionStore.getNode(id), source);
    const pageWorld = runtimeWorldTransformForNode((id) => this.projectionStore.getNode(id), currentPage);
    const pageInverse = pageWorld && invertRuntimeTransform(pageWorld);
    if (!sourceWorld || !pageInverse) throw runtimeError("UNSUPPORTED_FEATURE", { nodeId });
    const rootTransform = multiplyRuntimeTransforms(pageInverse, sourceWorld);
    const pageSiblings = this.siblingsOf(this.currentPageId);
    const rootPositionId = positionIdForLayerInsertion(pageSiblings, pageSiblings.length);
    if (!rootPositionId) throw runtimeError("RESOURCE_LIMIT", { nodeId });

    const ids = new Map(subtree.map((node) => [node.id, this.createId()]));
    const clonedComponentIds = new Set(subtree
      .filter((node) => node.type === "COMPONENT" && (node.id === source.id || (source.type === "COMPONENT_SET" && node.parentId === source.id)))
      .map((node) => node.id));
    const instanceRoots = new Set(subtree
      .filter((node) => node.type === "COMPONENT" && !clonedComponentIds.has(node.id))
      .map((node) => node.id));
    const instanceRootFor = new Map<string, string>();
    for (const node of subtree) {
      const instanceRootId = instanceRoots.has(node.id) ? node.id : node.parentId ? instanceRootFor.get(node.parentId) : undefined;
      if (instanceRootId) instanceRootFor.set(node.id, instanceRootId);
    }
    const operations = subtree.map((original): PendingProjectionOperation => {
      const id = ids.get(original.id)!;
      const isRoot = original.id === source.id;
      const instanceRootId = instanceRootFor.get(original.id);
      const becomesInstance = instanceRootId === original.id;
      const type = isRoot && original.type === "SLOT" ? "FRAME" : becomesInstance ? "INSTANCE" : original.type;
      const clone: Record<string, unknown> = {
        ...structuredClone(original),
        id,
        type,
        parentId: isRoot ? this.currentPageId : ids.get(original.parentId!),
        pageId: this.currentPageId,
        siblingIndex: isRoot ? pageSiblings.length : original.siblingIndex,
        positionId: isRoot ? rootPositionId : original.positionId,
        x: isRoot ? rootTransform.e : original.x,
        y: isRoot ? rootTransform.f : original.y,
        rotation: isRoot ? Math.atan2(rootTransform.b, rootTransform.a) * 180 / Math.PI : original.rotation,
        relativeTransform: isRoot ? rootTransform : original.relativeTransform,
        removed: false,
      };
      if (instanceRootId) {
        const extensions = clone.extensions && typeof clone.extensions === "object" && !Array.isArray(clone.extensions)
          ? structuredClone(clone.extensions as Record<string, number[]>)
          : {};
        delete extensions["figma.component.metadata.v1"];
        extensions[INSTANCE_SOURCE_NODE_EXTENSION] = [...new TextEncoder().encode(original.id)];
        clone.extensions = extensions;
      }
      if (clone.vectorPath && typeof clone.vectorPath === "object") {
        const path = clone.vectorPath as DocumentVectorPath;
        clone.vectorPath = {
          ...path,
          subpaths: path.subpaths.map((subpath) => ({
            ...subpath,
            points: subpath.points.map((point) => ({ ...point, id: this.createId() })),
          })),
        };
      }
      if (becomesInstance) {
        const metadata = original.componentMetadata as DocumentComponentMetadata | undefined;
        if (!metadata) throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: original.id });
        delete clone.componentMetadata;
        clone.instanceMetadata = {
          mainComponentId: original.id,
          scaleFactor: 1,
          componentProperties: Object.fromEntries(Object.entries(metadata.componentPropertyDefinitions).flatMap(([name, definition]) =>
            definition.type === "SLOT" || definition.defaultValue === undefined ? [] : [[name, definition.defaultValue]])),
          overrides: [],
          isExposedInstance: false,
        };
      } else if (clone.componentMetadata && typeof clone.componentMetadata === "object") {
        clone.componentMetadata = { ...(clone.componentMetadata as DocumentComponentMetadata), key: id, remote: false };
      }
      if (clone.componentSetMetadata && typeof clone.componentSetMetadata === "object") {
        clone.componentSetMetadata = { ...(clone.componentSetMetadata as DocumentComponentSetMetadata), key: id, remote: false };
      }
      if (clone.instanceMetadata && typeof clone.instanceMetadata === "object") {
        const metadata = clone.instanceMetadata as Record<string, unknown>;
        const mainComponentId = typeof metadata.mainComponentId === "string" && clonedComponentIds.has(metadata.mainComponentId)
          ? ids.get(metadata.mainComponentId)!
          : metadata.mainComponentId;
        clone.instanceMetadata = { ...metadata, mainComponentId };
      }
      if (clone.slotMetadata && typeof clone.slotMetadata === "object") {
        const metadata = clone.slotMetadata as Record<string, unknown>;
        const sourceSlotId = typeof metadata.sourceSlotId === "string" ? ids.get(metadata.sourceSlotId) ?? metadata.sourceSlotId : metadata.sourceSlotId;
        if (type === "FRAME") delete clone.slotMetadata;
        else clone.slotMetadata = { ...metadata, sourceSlotId };
      }
      if (type === "FRAME" && original.type === "SLOT") {
        const extensions = clone.extensions && typeof clone.extensions === "object" && !Array.isArray(clone.extensions)
          ? structuredClone(clone.extensions as Record<string, number[]>)
          : {};
        delete extensions["figma.slot.metadata.v1"];
        clone.extensions = extensions;
      }
      if (clone.connectorMetadata && typeof clone.connectorMetadata === "object") {
        clone.connectorMetadata = remapRuntimeConnectorMetadata(clone.connectorMetadata as DocumentConnectorMetadata, ids);
      }
      if (Array.isArray(clone.reactions)) clone.reactions = remapRuntimeReactions(clone.reactions, ids);
      return { type: "create", node: clone as RuntimeProjectionNode };
    });
    this.enqueueOperations(operations);
    return this.proxyFor(ids.get(source.id)!);
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

  private mutableComponentPropertyContext(componentId: string): Readonly<{
    owner: RuntimeProjectionNode;
    metadata: DocumentComponentMetadata;
    metadataField: "componentMetadata" | "componentSetMetadata";
    components: readonly RuntimeProjectionNode[];
    linkedInstances: readonly RuntimeProjectionNode[];
  }> {
    const owner = this.projectionStore.getNode(componentId);
    const metadataField = owner?.type === "COMPONENT_SET" ? "componentSetMetadata" : "componentMetadata";
    const metadata = owner?.[metadataField] as DocumentComponentMetadata | undefined;
    if (!owner || owner.removed === true || !["COMPONENT", "COMPONENT_SET"].includes(owner.type) || !metadata) {
      throw runtimeError("NODE_NOT_FOUND", { nodeId: componentId });
    }
    if (metadata.remote) throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: componentId });
    const components = owner.type === "COMPONENT"
      ? [owner]
      : this.siblingsOf(owner.id).filter((node) => node.type === "COMPONENT");
    if (!components.length) throw runtimeError("RESOURCE_UNAVAILABLE", { nodeId: componentId });
    if (components.some((component) => {
      const componentMetadata = component.componentMetadata as DocumentComponentMetadata | undefined;
      return !componentMetadata || componentMetadata.remote;
    })) throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: componentId });
    const componentIds = new Set(components.map((component) => component.id));
    const linkedInstances = this.projectionStore.listLiveNodes().filter((node) =>
      node.type === "INSTANCE" && componentIds.has(instanceMainComponentId(node) ?? ""));
    const touchedNodeIds = new Set([owner.id, ...components.map((component) => component.id), ...linkedInstances.map((instance) => instance.id)]);
    if (touchedNodeIds.size > this.maxSynchronousQueryNodes) {
      throw runtimeError("RESOURCE_LIMIT", { nodeId: componentId });
    }
    return {
      owner,
      metadata,
      metadataField,
      components,
      linkedInstances,
    };
  }

  private componentPropertyState(component: RuntimeProjectionNode): Readonly<{
    definitions: DocumentComponentMetadata["componentPropertyDefinitions"];
    values: Record<string, string | boolean>;
    componentSet?: RuntimeProjectionNode;
    variantProperties: Record<string, string>;
  }> {
    const metadata = component.componentMetadata as DocumentComponentMetadata | undefined;
    if (component.type !== "COMPONENT" || !metadata) throw runtimeError("RESOURCE_UNAVAILABLE", { nodeId: component.id });
    const definitions = structuredClone(metadata.componentPropertyDefinitions);
    const parent = typeof component.parentId === "string" ? this.projectionStore.getNode(component.parentId) : undefined;
    const componentSet = parent?.type === "COMPONENT_SET" && parent.componentSetMetadata && typeof parent.componentSetMetadata === "object"
      ? parent
      : undefined;
    const setMetadata = componentSet?.componentSetMetadata as DocumentComponentSetMetadata | undefined;
    if (setMetadata) {
      Object.entries(setMetadata.componentPropertyDefinitions).forEach(([name, definition]) => {
        if (definition.type === "VARIANT" || definitions[name] === undefined) definitions[name] = structuredClone(definition);
      });
    }
    const authoredVariants = runtimeVariantProperties(component);
    const variantProperties: Record<string, string> = {};
    Object.entries(definitions).forEach(([name, definition]) => {
      if (definition.type !== "VARIANT") return;
      const authored = authoredVariants[name];
      const value = typeof authored === "string" && authored ? authored : definition.defaultValue;
      if (typeof value === "string") variantProperties[name] = value;
    });
    const values = Object.fromEntries(Object.entries(definitions).flatMap(([name, definition]) => {
      if (definition.type === "SLOT") return [];
      const value = definition.type === "VARIANT" ? variantProperties[name] : definition.defaultValue;
      return value === undefined ? [] : [[name, value]];
    })) as Record<string, string | boolean>;
    return { definitions, values, componentSet, variantProperties };
  }

  private variantTargetForProperties(
    component: RuntimeProjectionNode,
    state: ReturnType<RuntimeSession["componentPropertyState"]>,
    values: Readonly<Record<string, string | boolean>>,
    nodeId: string,
  ): RuntimeProjectionNode {
    if (!state.componentSet) return component;
    const variantNames = Object.entries(state.definitions).flatMap(([name, definition]) => definition.type === "VARIANT" ? [name] : []);
    if (!variantNames.length) return component;
    const desired = Object.fromEntries(variantNames.map((name) => [name, values[name]]));
    if (Object.values(desired).some((value) => typeof value !== "string")) throw runtimeError("INVALID_ARGUMENT", { nodeId });
    const candidates = this.siblingsOf(state.componentSet.id).filter((candidate) => {
      if (candidate.type !== "COMPONENT") return false;
      const properties = this.componentPropertyState(candidate).variantProperties;
      return variantNames.every((name) => properties[name] === desired[name]);
    });
    if (candidates.length !== 1) throw runtimeError("INVALID_ARGUMENT", { nodeId });
    return candidates[0]!;
  }

  private variantOverridePlan(
    instance: RuntimeProjectionNode,
    target: RuntimeProjectionNode,
  ): ReadonlyMap<string, Readonly<{ node: RuntimeProjectionNode; fields: string[] }>> {
    const metadata = instance.instanceMetadata as DocumentInstanceMetadata;
    if (!metadata.overrides.length) return new Map();
    const instancePaths = this.runtimeSubtreePaths(instance.id);
    const targetPaths = this.runtimeSubtreePaths(target.id);
    const targetByPath = new Map([...targetPaths].map(([id, path]) => [path, this.projectionStore.getNode(id)!]));
    const currentNodes = [...instancePaths.keys()].map((id) => this.projectionStore.getNode(id)!).filter(Boolean);
    const result = new Map<string, { node: RuntimeProjectionNode; fields: string[] }>();
    metadata.overrides.forEach((override) => {
      const current = currentNodes.find((node) => node.id === override.id || runtimeInstanceSourceNodeId(node) === override.id);
      const path = current ? instancePaths.get(current.id) : undefined;
      const targetNode = path ? targetByPath.get(path) : undefined;
      if (!current || !targetNode || current.type !== targetNode.type) return;
      const planned = result.get(targetNode.id);
      result.set(targetNode.id, {
        node: current,
        fields: [...new Set([...(planned?.fields ?? []), ...override.overriddenFields])],
      });
    });
    return result;
  }

  private runtimeSubtreePaths(rootId: string): ReadonlyMap<string, string> {
    const result = new Map<string, string>();
    const childrenByParent = new Map<string, RuntimeProjectionNode[]>();
    this.projectionStore.listLiveNodes().forEach((node) => {
      if (typeof node.parentId !== "string" || !this.isNodeVisible(node)) return;
      const children = childrenByParent.get(node.parentId) ?? [];
      children.push(node);
      childrenByParent.set(node.parentId, children);
    });
    childrenByParent.forEach((children) => children.sort((left, right) => numericSiblingIndex(left) - numericSiblingIndex(right) || left.id.localeCompare(right.id)));
    const visit = (parentId: string, parentPath: string): void => {
      const occurrences = new Map<string, number>();
      (childrenByParent.get(parentId) ?? []).forEach((child) => {
        if (result.size >= this.maxSynchronousQueryNodes) throw runtimeError("RESOURCE_LIMIT", { nodeId: rootId });
        const label = `${child.type}:${typeof child.name === "string" ? child.name : ""}`;
        const occurrence = occurrences.get(label) ?? 0;
        occurrences.set(label, occurrence + 1);
        const path = `${parentPath}/${label}[${occurrence}]`;
        result.set(child.id, path);
        visit(child.id, path);
      });
    };
    visit(rootId, "");
    return result;
  }

  private replaceRuntimeSubtreeOperations(
    sourceRoot: RuntimeProjectionNode,
    targetRoot: RuntimeProjectionNode,
    decorate?: (source: RuntimeProjectionNode, clone: RuntimeProjectionNode) => RuntimeProjectionNode,
  ): PendingProjectionOperation[] {
    const collect = (rootId: string): RuntimeProjectionNode[] => {
      const result: RuntimeProjectionNode[] = [];
      const visit = (parentId: string): void => {
        this.siblingsOf(parentId).forEach((child) => {
          if (result.length >= this.maxSynchronousQueryNodes) throw runtimeError("RESOURCE_LIMIT", { nodeId: targetRoot.id });
          result.push(child);
          visit(child.id);
        });
      };
      visit(rootId);
      return result;
    };
    const current = collect(targetRoot.id);
    const sourceNodes = collect(sourceRoot.id);
    if (current.length + sourceNodes.length > this.maxSynchronousQueryNodes) throw runtimeError("RESOURCE_LIMIT", { nodeId: targetRoot.id });
    if (sourceNodes.some((node) => !INSTANCE_CLONE_TYPES.has(node.type as M1SceneNodeType))) throw runtimeError("UNSUPPORTED_NODE_TYPE", { nodeId: targetRoot.id });
    const ids = new Map(sourceNodes.map((node) => [node.id, this.createId()]));
    const replacements = sourceNodes.map((sourceNode): RuntimeProjectionNode => {
      const extensions = sourceNode.extensions && typeof sourceNode.extensions === "object" && !Array.isArray(sourceNode.extensions)
        ? structuredClone(sourceNode.extensions as Record<string, number[]>)
        : {};
      extensions[INSTANCE_SOURCE_NODE_EXTENSION] = [...new TextEncoder().encode(sourceNode.id)];
      let clone: RuntimeProjectionNode = {
        ...structuredClone(sourceNode),
        id: ids.get(sourceNode.id)!,
        parentId: sourceNode.parentId === sourceRoot.id ? targetRoot.id : ids.get(sourceNode.parentId!),
        pageId: targetRoot.pageId,
        removed: false,
        extensions,
        ...(sourceNode.type === "SLOT" && sourceNode.slotMetadata && typeof sourceNode.slotMetadata === "object"
          ? { slotMetadata: { ...(structuredClone(sourceNode.slotMetadata) as { propertyName: string }), sourceSlotId: sourceNode.id } }
          : {}),
      };
      const mutableClone = clone as unknown as Record<string, unknown>;
      if (clone.connectorMetadata && typeof clone.connectorMetadata === "object") mutableClone.connectorMetadata = remapRuntimeConnectorMetadata(clone.connectorMetadata as DocumentConnectorMetadata, ids);
      if (Array.isArray(clone.reactions)) mutableClone.reactions = remapRuntimeReactions(clone.reactions, ids);
      if (decorate) clone = decorate(sourceNode, clone);
      return clone;
    });
    return [
      ...current.reverse().map((node) => ({ type: "remove" as const, nodeId: node.id })),
      ...replacements.map((node) => ({ type: "create" as const, node })),
    ];
  }

  private addVariantComponentProperty(
    context: ReturnType<RuntimeSession["mutableComponentPropertyContext"]>,
    propertyName: string,
    defaultValue: string | boolean | RuntimeVariableAlias,
    options: RuntimeComponentPropertyOptions | undefined,
  ): string {
    if (context.owner.type !== "COMPONENT_SET") throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: context.owner.id });
    validateRuntimeVariantPropertyName(propertyName, context.owner.id);
    if (typeof defaultValue !== "string" || !defaultValue || defaultValue !== defaultValue.trim() || defaultValue.includes(",") || (options && Object.keys(options).length)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: context.owner.id });
    }
    const metadata = context.metadata as DocumentComponentSetMetadata;
    if (metadata.componentPropertyDefinitions[propertyName] || metadata.variantGroupProperties[propertyName]) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: context.owner.id });
    }
    context.components.forEach((component) => {
      const properties = runtimeVariantProperties(component);
      if (properties[propertyName] !== undefined) throw runtimeError("INVALID_ARGUMENT", { nodeId: component.id });
    });
    const baseDefinition = runtimeComponentPropertyDefinition("VARIANT", defaultValue, undefined, context.owner.id);
    const definition = {
      ...baseDefinition,
      variantOptions: [defaultValue],
    };
    const operations: PendingProjectionOperation[] = [{
      type: "update",
      nodeId: context.owner.id,
      patch: {
        componentSetMetadata: {
          ...structuredClone(metadata),
          componentPropertyDefinitions: {
            ...structuredClone(metadata.componentPropertyDefinitions),
            [propertyName]: definition,
          },
          variantGroupProperties: {
            ...structuredClone(metadata.variantGroupProperties),
            [propertyName]: { values: [defaultValue] },
          },
        },
      },
    }];
    context.components.forEach((component) => {
      operations.push({
        type: "update",
        nodeId: component.id,
        patch: { name: runtimeVariantNameWithProperty(component, propertyName, defaultValue) },
      });
    });
    context.linkedInstances.forEach((instance) => {
      const instanceMetadata = instance.instanceMetadata as DocumentInstanceMetadata;
      operations.push({
        type: "update",
        nodeId: instance.id,
        patch: {
          instanceMetadata: {
            ...structuredClone(instanceMetadata),
            componentProperties: {
              ...structuredClone(instanceMetadata.componentProperties),
              [propertyName]: defaultValue,
            },
          },
        },
      });
    });
    if (operations.length > this.maxSynchronousQueryNodes) throw runtimeError("RESOURCE_LIMIT", { nodeId: context.owner.id });
    this.enqueueOperations(operations);
    return propertyName;
  }

  private editVariantComponentProperty(
    context: ReturnType<RuntimeSession["mutableComponentPropertyContext"]>,
    propertyName: string,
    value: RuntimeComponentPropertyEdit,
  ): string {
    if (context.owner.type !== "COMPONENT_SET") throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: context.owner.id });
    if (value.defaultValue !== undefined || value.preferredValues !== undefined || value.description !== undefined || value.slotSettings !== undefined) {
      throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: context.owner.id });
    }
    if (value.name === undefined) return propertyName;
    const nextName = validatedRuntimeComponentPropertyBaseName(value.name, context.owner.id);
    validateRuntimeVariantPropertyName(nextName, context.owner.id);
    if (nextName === propertyName) return propertyName;
    const metadata = context.metadata as DocumentComponentSetMetadata;
    if (metadata.componentPropertyDefinitions[nextName] || metadata.variantGroupProperties[nextName]) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: context.owner.id });
    }
    const existing = metadata.componentPropertyDefinitions[propertyName];
    const group = metadata.variantGroupProperties[propertyName];
    if (!existing || existing.type !== "VARIANT" || !group) throw runtimeError("INVALID_ARGUMENT", { nodeId: context.owner.id });
    const definitions = structuredClone(metadata.componentPropertyDefinitions);
    const groups = structuredClone(metadata.variantGroupProperties);
    delete definitions[propertyName];
    delete groups[propertyName];
    definitions[nextName] = structuredClone(existing);
    groups[nextName] = structuredClone(group);
    const componentNames = new Map<string, string>();
    context.components.forEach((component) => {
      const properties = runtimeVariantProperties(component);
      if (properties[propertyName] === undefined || properties[nextName] !== undefined) {
        throw runtimeError("INVALID_ARGUMENT", { nodeId: component.id });
      }
      componentNames.set(component.id, runtimeVariantNameRenamingProperty(component, propertyName, nextName));
    });
    const operations: PendingProjectionOperation[] = [{
      type: "update",
      nodeId: context.owner.id,
      patch: {
        componentSetMetadata: {
          ...structuredClone(metadata),
          componentPropertyDefinitions: definitions,
          variantGroupProperties: groups,
        },
      },
    }];
    context.components.forEach((component) => operations.push({
      type: "update",
      nodeId: component.id,
      patch: { name: componentNames.get(component.id)! },
    }));
    context.linkedInstances.forEach((instance) => {
      const instanceMetadata = instance.instanceMetadata as DocumentInstanceMetadata;
      const componentProperties = structuredClone(instanceMetadata.componentProperties);
      const currentValue = componentProperties[propertyName];
      delete componentProperties[propertyName];
      if (currentValue !== undefined) componentProperties[nextName] = currentValue;
      operations.push({
        type: "update",
        nodeId: instance.id,
        patch: { instanceMetadata: { ...structuredClone(instanceMetadata), componentProperties } },
      });
    });
    if (operations.length > this.maxSynchronousQueryNodes) throw runtimeError("RESOURCE_LIMIT", { nodeId: context.owner.id });
    this.enqueueOperations(operations);
    return nextName;
  }

  private componentPropertyDefinitionOperations(
    context: ReturnType<RuntimeSession["mutableComponentPropertyContext"]>,
    definitions: DocumentComponentMetadata["componentPropertyDefinitions"],
    previousName: string | undefined,
    nextName: string | undefined,
    definition: DocumentComponentMetadata["componentPropertyDefinitions"][string] | undefined,
  ): PendingProjectionOperation[] {
    const operations: PendingProjectionOperation[] = [{
      type: "update",
      nodeId: context.owner.id,
      patch: {
        [context.metadataField]: {
          ...structuredClone(context.metadata),
          componentPropertyDefinitions: structuredClone(definitions),
        },
      },
    }];
    if (context.owner.type === "COMPONENT_SET") {
      context.components.forEach((component) => {
        const metadata = component.componentMetadata as DocumentComponentMetadata;
        const componentDefinitions = structuredClone(metadata.componentPropertyDefinitions);
        if (previousName !== undefined) delete componentDefinitions[previousName];
        if (nextName !== undefined && definition !== undefined) componentDefinitions[nextName] = structuredClone(definition);
        if (previousName === undefined && nextName === undefined) {
          Object.entries(definitions).forEach(([name, candidate]) => {
            if (candidate.type !== "VARIANT" && componentDefinitions[name]) componentDefinitions[name] = structuredClone(candidate);
          });
        }
        operations.push({
          type: "update",
          nodeId: component.id,
          patch: {
            componentMetadata: {
              ...structuredClone(metadata),
              componentPropertyDefinitions: componentDefinitions,
            },
          },
        });
      });
    }
    return operations;
  }

  private componentPropertyVariableOperations(
    variableOverrides: ReadonlyMap<string, DocumentVariableResource>,
    collectionOverrides: ReadonlyMap<string, DocumentVariableCollectionResource> = new Map(),
    modeOverride?: Readonly<{ nodeId: string; modes: Readonly<Record<string, string>> }>,
  ): PendingProjectionOperation[] {
    const liveNodes = this.projectionStore.listLiveNodes();
    const owners = liveNodes.filter((node) => {
      if (modeOverride && node.id !== modeOverride.nodeId && !runtimeNodeHasAncestorIn(node, new Set([modeOverride.nodeId]), (id) => this.projectionStore.getNode(id))) return false;
      if (node.type === "COMPONENT_SET") return true;
      if (node.type !== "COMPONENT") return false;
      return this.projectionStore.getNode(node.parentId ?? "")?.type !== "COMPONENT_SET";
    });
    if (owners.length > this.maxSynchronousQueryNodes) throw runtimeError("RESOURCE_LIMIT");
    const operations: PendingProjectionOperation[] = [];
    for (const owner of owners) {
      const context = this.mutableComponentPropertyContext(owner.id);
      const definitions = structuredClone(context.metadata.componentPropertyDefinitions);
      const changes = new Map<string, Readonly<{ before: string | boolean | undefined; after: string | boolean }>>();
      for (const [name, definition] of Object.entries(definitions)) {
        const alias = definition.boundVariables?.defaultValue;
        if (!alias) continue;
        const resolved = this.resolveVariableValueFromResources(alias.id, owner.id, modeOverride, variableOverrides, collectionOverrides);
        const expectedType = definition.type === "BOOLEAN" ? "BOOLEAN" : "STRING";
        if (resolved.resolvedType !== expectedType || (definition.type === "BOOLEAN" ? typeof resolved.value !== "boolean" : typeof resolved.value !== "string")) {
          throw runtimeError("INVALID_ARGUMENT", { nodeId: owner.id });
        }
        const value = resolved.value as string | boolean;
        if (definition.type === "INSTANCE_SWAP" && !this.isComponentPropertySwapTarget(value)) throw runtimeError("INVALID_ARGUMENT", { nodeId: owner.id });
        if (value === definition.defaultValue) continue;
        changes.set(name, { before: definition.defaultValue, after: value });
        definition.defaultValue = value;
      }
      if (!changes.size) continue;
      operations.push(...this.componentPropertyDefinitionOperations(context, definitions, undefined, undefined, undefined));
      const linkedValues = new Map<string, Record<string, string | boolean>>();
      context.linkedInstances.forEach((instance) => {
        const metadata = instance.instanceMetadata as DocumentInstanceMetadata;
        const values = structuredClone(metadata.componentProperties);
        changes.forEach(({ before, after }, name) => { if (values[name] === before) values[name] = after; });
        linkedValues.set(instance.id, values);
        operations.push({ type: "update", nodeId: instance.id, patch: { instanceMetadata: { ...structuredClone(metadata), componentProperties: values } } });
      });
      const roots = [...context.components, ...context.linkedInstances];
      const sourceValues = Object.fromEntries(Object.entries(definitions).flatMap(([name, definition]) => definition.defaultValue === undefined ? [] : [[name, definition.defaultValue]]));
      const referenceNodes = liveNodes.filter((node) => Object.values(runtimeComponentPropertyReferences(node) ?? {}).some((name) => changes.has(name)));
      const replacedReferenceRoots = new Set<string>();
      this.componentPropertyReferenceOrder(referenceNodes).forEach((node) => {
        if (runtimeNodeHasAncestorIn(node, replacedReferenceRoots, (id) => this.projectionStore.getNode(id))) return;
        const root = roots.find((candidate) => runtimeNodeHasAncestorIn(node, new Set([candidate.id]), (id) => this.projectionStore.getNode(id)));
        if (!root) return;
        const references = runtimeComponentPropertyReferences(node)!;
        const values = context.components.some((component) => component.id === root.id) ? sourceValues : linkedValues.get(root.id) ?? {};
        if (this.componentPropertyReferenceReplacesSubtree(node, references, values, definitions)) replacedReferenceRoots.add(node.id);
        operations.push(...this.componentPropertyReferenceOperations(node, references, values, definitions));
      });
      if (operations.length > this.maxSynchronousQueryNodes) throw runtimeError("RESOURCE_LIMIT", { nodeId: owner.id });
    }
    return operations;
  }

  private isComponentPropertySwapTarget(value: string | boolean | undefined): boolean {
    if (typeof value !== "string") return false;
    const target = this.projectionStore.getNode(value);
    return Boolean(target && target.removed !== true && target.type === "COMPONENT");
  }

  private componentPropertyDefaultValue(
    type: RuntimeComponentPropertyType,
    value: string | boolean | RuntimeVariableAlias,
    nodeId: string,
  ): Readonly<{ value: string | boolean; alias?: RuntimeVariableAlias }> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { value } as Readonly<{ value: string | boolean }>;
    if (value.type !== "VARIABLE_ALIAS" || typeof value.id !== "string" || !value.id || type === "SLOT" || type === "VARIANT") {
      throw runtimeError("INVALID_ARGUMENT", { nodeId });
    }
    const resolved = this.resolveVariableValue(value.id, nodeId);
    const expectedType = type === "BOOLEAN" ? "BOOLEAN" : "STRING";
    if (resolved.resolvedType !== expectedType || (type === "BOOLEAN" ? typeof resolved.value !== "boolean" : typeof resolved.value !== "string")) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId });
    }
    return { value: resolved.value as string | boolean, alias: { type: "VARIABLE_ALIAS", id: value.id } };
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

function validateRuntimeComponentPropertyBaseName(name: string, nodeId: string): void {
  validatedRuntimeComponentPropertyBaseName(name, nodeId);
}

function validatedRuntimeComponentPropertyBaseName(name: string, nodeId: string): string {
  if (typeof name !== "string" || name.length === 0 || name.length > 256 || /[\u0000-\u001f]/u.test(name)) {
    throw runtimeError("INVALID_ARGUMENT", { nodeId });
  }
  return name;
}

function validateRuntimeVariantPropertyName(name: string, nodeId: string): void {
  if (name !== name.trim() || /[=,]/u.test(name)) throw runtimeError("INVALID_ARGUMENT", { nodeId });
}

function validateRuntimeComponentPropertyOptions(
  options: RuntimeComponentPropertyOptions | RuntimeComponentPropertyEdit | undefined,
  nodeId: string,
): void {
  if (options === undefined) return;
  if (!options || typeof options !== "object" || Array.isArray(options)) throw runtimeError("INVALID_ARGUMENT", { nodeId });
  if (options.preferredValues !== undefined && (
    !Array.isArray(options.preferredValues) ||
    options.preferredValues.length > 256 ||
    options.preferredValues.some((value) => !value || typeof value !== "object" || Array.isArray(value) || !["COMPONENT", "COMPONENT_SET"].includes(value.type) || typeof value.key !== "string" || !value.key || value.key.length > 256 || Object.keys(value).some((key) => !["type", "key"].includes(key)))
  )) throw runtimeError("INVALID_ARGUMENT", { nodeId });
  if (options.slotSettings !== undefined) validateRuntimeSlotSettings(options.slotSettings, nodeId);
  if (options.description !== undefined && (
    typeof options.description !== "string" ||
    options.description.includes("\0") ||
    new TextEncoder().encode(options.description).byteLength > 2_048
  )) throw runtimeError("INVALID_ARGUMENT", { nodeId });
}

function validateRuntimeComponentPropertyOptionCompatibility(
  type: RuntimeComponentPropertyType,
  options: RuntimeComponentPropertyOptions | RuntimeComponentPropertyEdit | undefined,
  nodeId: string,
): void {
  if (options?.preferredValues !== undefined && type !== "INSTANCE_SWAP" && type !== "SLOT") throw runtimeError("INVALID_ARGUMENT", { nodeId });
  if (options?.slotSettings !== undefined && type !== "SLOT") throw runtimeError("INVALID_ARGUMENT", { nodeId });
}

function validateRuntimeSlotSettings(value: Readonly<Record<string, unknown>>, nodeId: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["stretchChildOnInsert", "displayEmptyByDefault", "minChildren", "maxChildren", "allowPreferredValuesOnly"].includes(key))) {
    throw runtimeError("INVALID_ARGUMENT", { nodeId });
  }
  for (const key of ["stretchChildOnInsert", "displayEmptyByDefault", "allowPreferredValuesOnly"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") throw runtimeError("INVALID_ARGUMENT", { nodeId });
  }
  for (const key of ["minChildren", "maxChildren"] as const) {
    const count = value[key];
    if (count !== undefined && count !== null && (!Number.isSafeInteger(count) || (count as number) < 0)) throw runtimeError("INVALID_ARGUMENT", { nodeId });
  }
  const min = value.minChildren;
  const max = value.maxChildren;
  if (typeof min === "number" && typeof max === "number" && min > max) throw runtimeError("INVALID_ARGUMENT", { nodeId });
}

function runtimeComponentPropertyDefinition(
  type: RuntimeComponentPropertyType,
  defaultValue: string | boolean | RuntimeVariableAlias,
  options: RuntimeComponentPropertyOptions | undefined,
  nodeId: string,
): DocumentComponentMetadata["componentPropertyDefinitions"][string] {
  if (!["BOOLEAN", "TEXT", "INSTANCE_SWAP", "VARIANT", "SLOT"].includes(type)) {
    throw runtimeError("INVALID_ARGUMENT", { nodeId });
  }
  if (typeof defaultValue === "object") throw runtimeError("UNSUPPORTED_FEATURE", { nodeId });
  const valid = type === "BOOLEAN"
    ? typeof defaultValue === "boolean"
    : typeof defaultValue === "string" && !defaultValue.includes("\0") && new TextEncoder().encode(defaultValue).byteLength <= 2_048;
  if (!valid || ((type === "INSTANCE_SWAP" || type === "VARIANT") && defaultValue === "")) {
    throw runtimeError("INVALID_ARGUMENT", { nodeId });
  }
  return {
    type,
    ...(type === "SLOT" ? {} : { defaultValue }),
    ...(options?.description === undefined ? {} : { description: options.description }),
    ...(options?.preferredValues === undefined ? {} : { preferredValues: options.preferredValues.map((preferred) => ({ ...preferred })) }),
    ...(options?.slotSettings === undefined ? {} : { slotSettings: { ...options.slotSettings } }),
  };
}

function runtimeSlotPropertyName(node: RuntimeProjectionNode): string | undefined {
  const metadata = node.slotMetadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const name = (metadata as { propertyName?: unknown }).propertyName;
  return typeof name === "string" ? name : undefined;
}

function validateRuntimeComponentPropertyReferences(
  value: DocumentComponentPropertyReferences | null,
  node: RuntimeProjectionNode,
  definitions: DocumentComponentMetadata["componentPropertyDefinitions"],
  nodeId: string,
): DocumentComponentPropertyReferences | undefined {
  if (value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw runtimeError("INVALID_ARGUMENT", { nodeId });
  const entries = Object.entries(value);
  if (entries.some(([field, propertyName]) => !["visible", "characters", "mainComponent", "slotContentId"].includes(field) || typeof propertyName !== "string" || !propertyName)) {
    throw runtimeError("INVALID_ARGUMENT", { nodeId });
  }
  if (value.characters !== undefined && !["TEXT", "TEXT_PATH"].includes(node.type)) throw runtimeError("INVALID_ARGUMENT", { nodeId });
  if (value.mainComponent !== undefined && node.type !== "INSTANCE") throw runtimeError("INVALID_ARGUMENT", { nodeId });
  if (value.slotContentId !== undefined && !["FRAME", "SLOT"].includes(node.type)) throw runtimeError("INVALID_ARGUMENT", { nodeId });
  const expectedTypes: Readonly<Record<keyof DocumentComponentPropertyReferences, DocumentComponentMetadata["componentPropertyDefinitions"][string]["type"]>> = {
    visible: "BOOLEAN",
    characters: "TEXT",
    mainComponent: "INSTANCE_SWAP",
    slotContentId: "SLOT",
  };
  for (const [field, propertyName] of entries as Array<[keyof DocumentComponentPropertyReferences, string]>) {
    const definition = definitions[propertyName];
    if (!definition || definition.type !== expectedTypes[field] || (field !== "slotContentId" && definition.defaultValue === undefined)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId });
    }
  }
  return structuredClone(value);
}

function runtimeComponentPropertyReferences(node: RuntimeProjectionNode): DocumentComponentPropertyReferences | undefined {
  const value = node.componentPropertyReferences;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const propertyName = node.type === "SLOT" ? runtimeSlotPropertyName(node) : undefined;
    return propertyName ? { slotContentId: propertyName } : undefined;
  }
  const entries = Object.entries(value);
  if (entries.some(([field, propertyName]) => !["visible", "characters", "mainComponent", "slotContentId"].includes(field) || typeof propertyName !== "string" || !propertyName)) return undefined;
  return value as DocumentComponentPropertyReferences;
}

function runtimeInstanceSourceNodeId(node: RuntimeProjectionNode): string | undefined {
  const extensions = node.extensions;
  if (!extensions || typeof extensions !== "object" || Array.isArray(extensions)) return undefined;
  const bytes = (extensions as Record<string, unknown>)[INSTANCE_SOURCE_NODE_EXTENSION];
  if (!Array.isArray(bytes) || bytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return undefined;
  const value = new TextDecoder().decode(Uint8Array.from(bytes as number[]));
  return value || undefined;
}

function runtimeVariantMetadata(
  components: readonly RuntimeProjectionNode[],
): Pick<DocumentComponentSetMetadata, "componentPropertyDefinitions" | "variantGroupProperties"> {
  const values = new Map<string, string[]>();
  components.forEach((component) => {
    const name = typeof component.name === "string" ? component.name : "";
    name.split(",").forEach((part) => {
      const separator = part.indexOf("=");
      const property = separator < 0 ? "" : part.slice(0, separator).trim();
      const value = separator < 0 ? "" : part.slice(separator + 1).trim();
      if (!property || !value) return;
      const variants = values.get(property) ?? [];
      if (!variants.includes(value)) variants.push(value);
      values.set(property, variants);
    });
  });
  const variantGroupProperties = Object.fromEntries([...values].map(([property, variants]) => [property, { values: variants }]));
  const componentPropertyDefinitions = Object.fromEntries([...values].map(([property, variants]) => [property, {
    type: "VARIANT" as const,
    defaultValue: variants[0]!,
    variantOptions: [...variants],
  }]));
  return { componentPropertyDefinitions, variantGroupProperties };
}

type RuntimeVariantNamePart =
  | Readonly<{ property: string; value: string }>
  | Readonly<{ raw: string }>;

function runtimeVariantNameParts(node: RuntimeProjectionNode): RuntimeVariantNamePart[] {
  const name = typeof node.name === "string" ? node.name : "";
  return name.split(",").flatMap((raw): RuntimeVariantNamePart[] => {
    const normalized = raw.trim();
    const separator = normalized.indexOf("=");
    const property = separator < 0 ? "" : normalized.slice(0, separator).trim();
    const value = separator < 0 ? "" : normalized.slice(separator + 1).trim();
    return property && value ? [{ property, value }] : normalized ? [{ raw: normalized }] : [];
  });
}

function runtimeVariantProperties(node: RuntimeProjectionNode): Record<string, string> {
  const result: Record<string, string> = {};
  runtimeVariantNameParts(node).forEach((part) => {
    if ("property" in part) result[part.property] = part.value;
  });
  return result;
}

function runtimeVariantName(parts: readonly RuntimeVariantNamePart[]): string {
  return parts.map((part) => "property" in part ? `${part.property}=${part.value}` : part.raw).join(", ");
}

function runtimeVariantNameWithProperty(node: RuntimeProjectionNode, propertyName: string, value: string): string {
  return runtimeVariantName([...runtimeVariantNameParts(node), { property: propertyName, value }]);
}

function runtimeVariantNameRenamingProperty(node: RuntimeProjectionNode, propertyName: string, nextName: string): string {
  return runtimeVariantName(runtimeVariantNameParts(node).map((part) =>
    "property" in part && part.property === propertyName ? { property: nextName, value: part.value } : part));
}

function runtimeNodeHasAncestorIn(
  node: RuntimeProjectionNode,
  roots: ReadonlySet<string>,
  read: (nodeId: string) => RuntimeProjectionNode | undefined,
): boolean {
  const visited = new Set<string>();
  let parentId = node.parentId;
  while (typeof parentId === "string" && !visited.has(parentId)) {
    if (roots.has(parentId)) return true;
    visited.add(parentId);
    parentId = read(parentId)?.parentId;
  }
  return false;
}

function instanceMainComponentId(node: RuntimeProjectionNode): string | undefined {
  const metadata = node.instanceMetadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const mainComponentId = (metadata as { mainComponentId?: unknown }).mainComponentId;
  return typeof mainComponentId === "string" ? mainComponentId : undefined;
}

function remapRuntimeConnectorMetadata(
  metadata: DocumentConnectorMetadata,
  ids: ReadonlyMap<string, string>,
): DocumentConnectorMetadata {
  const remapEndpoint = (endpoint: DocumentConnectorMetadata["start"]): DocumentConnectorMetadata["start"] => ({
    ...structuredClone(endpoint),
    ...(endpoint.endpointNodeId ? { endpointNodeId: ids.get(endpoint.endpointNodeId) ?? endpoint.endpointNodeId } : {}),
  });
  return { ...structuredClone(metadata), start: remapEndpoint(metadata.start), end: remapEndpoint(metadata.end) };
}

function remapRuntimeReactions(reactions: readonly unknown[], ids: ReadonlyMap<string, string>): unknown[] {
  return reactions.map((reaction) => {
    if (!reaction || typeof reaction !== "object" || !Array.isArray((reaction as { actions?: unknown }).actions)) {
      return structuredClone(reaction);
    }
    const value = reaction as { actions: unknown[] } & Record<string, unknown>;
    return {
      ...structuredClone(value),
      actions: value.actions.map((action) => {
        if (!action || typeof action !== "object") return structuredClone(action);
        const next = structuredClone(action) as Record<string, unknown>;
        if (typeof next.destinationId === "string" && ids.has(next.destinationId)) {
          next.destinationId = ids.get(next.destinationId)!;
        }
        return next;
      }),
    };
  });
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

function runtimeTemporaryPositionId(nodeId: string, finalPositionId: string): string {
  const compact = nodeId.replaceAll("-", "").toLowerCase();
  const actor = /^[0-9a-f]{32}$/.test(compact) ? compact : "00000000000000000000000000000007";
  const high = `fffffffffffffffffffffffffffffffe:${actor}`;
  return high === finalPositionId ? `00000000000000000000000000000001:${actor}` : high;
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

function validRuntimeHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value || new TextEncoder().encode(value).byteLength > 2_048) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function validRuntimeNullablePreviewText(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && new TextEncoder().encode(value).byteLength <= 4_096);
}

function validRuntimeEmbedMetadata(value: unknown): value is DocumentEmbedMetadata {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DocumentEmbedMetadata>;
  return validRuntimeHttpUrl(candidate.srcUrl)
    && (candidate.canonicalUrl === null || validRuntimeHttpUrl(candidate.canonicalUrl))
    && validRuntimeNullablePreviewText(candidate.title)
    && validRuntimeNullablePreviewText(candidate.provider);
}

function validRuntimeLinkUnfurlMetadata(value: unknown): value is DocumentLinkUnfurlMetadata {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DocumentLinkUnfurlMetadata>;
  return validRuntimeHttpUrl(candidate.url)
    && validRuntimeNullablePreviewText(candidate.title)
    && validRuntimeNullablePreviewText(candidate.description)
    && validRuntimeNullablePreviewText(candidate.provider);
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

function runtimeNodeUsesTextStyle(node: RuntimeProjectionNode, styleId: string): boolean {
  const properties = node.textProperties;
  if (!properties || typeof properties !== "object") return false;
  const value = properties as {
    baseStyle?: { textStyleId?: unknown };
    runs?: readonly { textStyleId?: unknown }[];
  };
  return value.baseStyle?.textStyleId === styleId
    || value.runs?.some((run) => run.textStyleId === styleId) === true;
}

function runtimeNodeUsesPaintStyle(node: RuntimeProjectionNode, styleId: string): boolean {
  const properties = node.textProperties;
  if (!properties || typeof properties !== "object") return false;
  const value = properties as {
    baseStyle?: { paintStyleId?: unknown };
    runs?: readonly { paintStyleId?: unknown }[];
  };
  return value.baseStyle?.paintStyleId === styleId
    || value.runs?.some((run) => run.paintStyleId === styleId) === true;
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
