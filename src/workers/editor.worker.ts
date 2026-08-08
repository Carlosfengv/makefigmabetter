/// <reference lib="webworker" />

import type { CanvasNode, CanvasPage, CoreJournalOperation, CoreLocalSnapshot, DocumentAsset, DocumentFontReference, EditorClipboard, EditorCommand, EditorSnapshot, LocalJournalEntry, MainToWorker, PendingOperationReplay, PendingRemoteOperation, PresentationNode, RendererPreference, SimulatedGpuFault, ToolKind, WorkerToMain } from "@/lib/editor-protocol";
import { createDiagnosticRecorder } from "@/lib/diagnostics";
import { findTopmostHit } from "@/lib/hit-test";
import { createRenderPerformanceSampler } from "@/lib/performance-sampling";
import { admitRenderSurface, MAX_RENDER_SURFACE_BYTES } from "@/lib/render-surface-budget";
import { assessWasmHeap, MAX_WASM_HEAP_BYTES } from "@/lib/wasm-heap-budget";
import { createNode, DEFAULT_TEXT_LINE_HEIGHT, documentColorFromCssHex } from "@/lib/editor-protocol";
import { sampleLinearGradientForCanvas } from "@/lib/color-rendering";
import { layoutTextRanges, resolveTextRenderMetrics } from "@/lib/text-layout";
import { styledTextSpans, type RenderTextStyle } from "@/lib/text-style-runs";
import { classifyWebGpuRendererFailure, GpuSceneResourceLimitError, MAX_GPU_SCENE_RESOURCE_BYTES, WebGpuSceneRenderer, type WebGpuTextGlyph } from "@/lib/webgpu-scene";
import { decodeInputBatch } from "@/lib/input-transfer";
import { captureClipboard, coreProjectionNode, resolveCoreBatch, resolvePasteBatch, type CoreBatchCommand, type CoreProjectionNode } from "@/lib/transaction-batch";
import { encodeCoreBatchPayload, encodeCreatePagePayload, encodeOperationPayloadEnvelope, encodeRegisterResourcePayload } from "@/lib/protocol-operation-codec";
import { migrateLegacyCoreRotationSnapshot } from "@/lib/legacy-rotation-migration";
import { classifyEditorError, editorError, type EditorErrorCode } from "@/lib/editor-error";
import { resetDocumentProjection } from "@/lib/document-reset";
import { resolveInsideRoundedRect } from "@/lib/rounded-rect";
import { perSideStrokeCenters } from "@/lib/per-side-stroke";
import { resolveCornerRadii } from "@/lib/corner-radii";
import { insetRoundedRectRadii, outsetRoundedRectRadii } from "@/lib/aligned-rounded-rect";
import { cornerSmoothingExponent, resolveCornerSmoothing } from "@/lib/corner-smoothing";
import { clampCanvasZoom, resolveVisibleCanvasGridStep, shouldRenderCanvasGrid, snapCanvasPoint } from "@/lib/canvas-grid";
import { toolAfterLayerCreated } from "@/lib/creation-tool";
import { gpuLayerPrefix } from "@/lib/gpu-layer-prefix";
import { exceedsMarqueeDragThreshold, lineSelectionBounds, marqueeRect, resolveMarqueeSelection, rotatedNodeBounds } from "@/lib/marquee-selection";
import { resolveMultiResizeSelection, type MultiResizeSelection } from "@/lib/multi-selection";
import { worldLineVisualBounds } from "@/lib/line-world-bounds";
import { selectionDimensions } from "@/lib/selection-label";
import { resolveCanvasObjectSelection, resolveGroupSelectionTarget } from "@/lib/canvas-selection";
import { movableSelectionIds } from "@/lib/selection-move-roots";
import { boundsIntersect, viewportWorldBounds } from "@/lib/scene-visibility";
import { createSpatialGridIndex } from "@/lib/spatial-grid";
import { renderDpr, resolveRenderQuality, type RenderQualityState } from "@/lib/render-quality";
import { canvasDesignTokens, canvasFont } from "@/lib/canvas-design-tokens";
import { cacheAsset, readCachedAsset } from "@/lib/asset-byte-cache";
import { ImageBitmapCache } from "@/lib/image-bitmap-cache";
import { decodeRasterInWorker } from "@/lib/asset-decode-client";
import { MAX_RASTER_DECODED_BYTES } from "@/lib/untrusted-asset";
import { FontFaceRegistry } from "@/lib/font-face-registry";
import { cssLineBoxBaseline as resolveCssLineBoxBaseline } from "@/lib/text-baseline";
import { parseRustGpuSceneBatch } from "@/lib/rust-gpu-batch";
import { parseRustTextLayout, type RustTextLayout } from "@/lib/rust-text-layout";
import { parseRustTextCaretLayout } from "@/lib/rust-text-caret";
import { parseRustGlyphRaster } from "@/lib/rust-glyph-raster";
import { orderNodesByRustRenderCommands, parseRustRenderGraphPlan, type RustRenderGraphPlan } from "@/lib/rust-render-graph";
import { projectGpuTextGlyphs } from "@/lib/gpu-text-projection";
import { hasCommittedResize, resizeGeometryFromCenter, resizeGeometryFromCorner, resizeGeometryFromCornerWithFlip, resizeRotatedLegacyGeometry, type CanvasResizeHandle, type ResizeGeometry } from "@/lib/canvas-resize";
import { resizeRelativeTransformFromWorldGesture } from "@/lib/relative-transform-resize";
import { hasCommittedLineEndpointResize, lineEndpoints, resizeLegacyLineEndpoint, type LineEndpoint } from "@/lib/line-endpoint-resize";
import { resizeRelativeLineEndpointFromWorldGesture } from "@/lib/relative-line-endpoint-resize";
import { editorKeyCommand } from "@/lib/editor-key-command";
import { isEffectivelyLocked } from "@/lib/hierarchy-lock";
import { createKeyboardToolNode } from "@/lib/keyboard-node-create";
import { solidLineStrokeOutline } from "@/lib/line-stroke-outline";
import { decorativeCapMesh, isDecorativeCap } from "@/lib/decorative-cap-mesh";
import { hasCommittedSelectionResize, scaleLegacySelectionGeometry } from "@/lib/selection-resize";
import { hasCommittedSelectionTransform, scaleSelectionTransforms, type SelectionTransformPatch } from "@/lib/selection-transform-resize";
import { wasmHydrationBatches } from "@/lib/wasm-hydration-batches";
import { orderNewLayerAtFront, sortNodesByLayerOrder } from "@/lib/layer-order";
import { planPendingOperationReconciliation } from "@/lib/pending-operation-reconciliation";
import { rebaseCoreBatchForSnapshot } from "@/lib/rebase-core-batch";
import { fullStateReplayBatch, historyReplayBatch } from "@/lib/history-replay-batch";
import { visibleNodesOnPage } from "@/lib/hierarchy-visibility";
import { invertAffine, multiplyAffine, nodePropsForWorldTransform, normalizeGroupBounds, transformPoint, translateNodeWorldPatch, worldBoundsForNode, worldSpaceProjectionNode, worldTransformForNode, type AffineMatrix } from "@/lib/scene-transform";
import { worldVisualBoundsForNode } from "@/lib/world-visual-bounds";
import { closedShapeStrokeLocalBounds } from "@/lib/closed-shape-stroke-bounds";
import { ellipseStrokeRing } from "@/lib/ellipse-stroke-ring";

declare const self: DedicatedWorkerGlobalScope;

type Drag =
  | { mode: "draw"; startX: number; startY: number; node: CanvasNode }
  | { mode: "move"; startX: number; startY: number; before: CanvasNode[]; initial: Set<string> }
  | { mode: "resize"; id: string; handle: CanvasResizeHandle; start: { x: number; y: number }; node: CanvasNode; before: CanvasNode[] }
  | { mode: "multi-resize"; handle: CanvasResizeHandle; start: { x: number; y: number }; bounds: ResizeGeometry; before: CanvasNode[]; ids: string[]; requiresAffine: boolean }
  | { mode: "line-resize"; id: string; endpoint: LineEndpoint; node: CanvasNode; before: CanvasNode[] }
  | { mode: "pan"; startX: number; startY: number }
  | { mode: "select"; startX: number; startY: number; currentX: number; currentY: number; startScreenX: number; startScreenY: number; marqueeStarted: boolean; initialSelection: string[]; additive: boolean };
type WasmProjectionNode = CoreProjectionNode;
type WasmProjectionSnapshot = { schemaVersion: number; documentId?: string; revision: number; canUndo: boolean; canRedo: boolean; pages?: CanvasPage[]; resourceIndex?: DocumentAsset[]; nodes: WasmProjectionNode[] };
type WasmDocumentEngine = {
  readonly revision: bigint;
  readonly can_undo: boolean;
  readonly can_redo: boolean;
  canonical_hash(): string;
  snapshot_protobuf(): Uint8Array;
  memory_stats_json(): string;
  create_node(transactionId: string, baseRevision: bigint, nodeId: string, kind: string, name: string, x: number, y: number, width: number, height: number, rotation: number, fill: string, stroke: string, strokeWidth: number, opacity: number, cornerRadius: number, visible: boolean, locked: boolean, text: string): bigint;
  create_node_on_page(transactionId: string, baseRevision: bigint, pageId: string, nodeId: string, kind: string, name: string, x: number, y: number, width: number, height: number, rotation: number, fill: string, stroke: string, strokeWidth: number, opacity: number, cornerRadius: number, visible: boolean, locked: boolean, text: string): bigint;
  create_page(transactionId: string, baseRevision: bigint, pageId: string, name: string): bigint;
  seed_node(transactionId: string, baseRevision: bigint, nodeId: string, kind: string, name: string, x: number, y: number, width: number, height: number, rotation: number, fill: string, stroke: string, strokeWidth: number, opacity: number, cornerRadius: number, visible: boolean, locked: boolean, text: string): bigint;
  rename_node(transactionId: string, baseRevision: bigint, nodeId: string, name: string): bigint;
  update_node(transactionId: string, baseRevision: bigint, nodeId: string, name: string, x: number, y: number, width: number, height: number, rotation: number, fill: string, stroke: string, strokeWidth: number, opacity: number, cornerRadius: number, visible: boolean, locked: boolean, text: string): bigint;
  delete_nodes(transactionId: string, baseRevision: bigint, nodeIds: string): bigint;
  move_nodes(transactionId: string, baseRevision: bigint, updatesJson: string): bigint;
  apply_transaction_json(transactionId: string, baseRevision: bigint, commandsJson: string): bigint;
  register_asset(transactionId: string, baseRevision: bigint, assetId: string, contentHash: string, mediaType: string, byteLength: bigint, pixelWidth: number, pixelHeight: number): bigint;
  undo(): bigint;
  redo(): bigint;
  snapshot_json(): string;
  render_graph_plan_for_page_json(pageId: string, viewportX: number, viewportY: number, viewportWidth: number, viewportHeight: number): string;
  gpu_scene_instances_json(pageId: string): string;
  load_snapshot_protobuf(bytes: Uint8Array): bigint;
  load_snapshot_json(value: string): bigint;
  seed_batch_json(value: string): bigint;
};

let canvas: OffscreenCanvas | undefined;
const defaultPageId = "00000000-0000-0000-0000-000000000001";
let pages: CanvasPage[] = [{ id: defaultPageId, name: "Page 1", positionId: "00000000000000000000000000000001:00000000000000000000000000000000" }];
let activePageId = defaultPageId;
let context: OffscreenCanvasRenderingContext2D | null = null;
let width = 0;
let height = 0;
let dpr = 1;
let deviceDpr = 1;
let renderQuality: RenderQualityState = { tier: "settled", zoomBucket: "normal" };
let renderQualityTimer: ReturnType<typeof setTimeout> | undefined;
let tool: ToolKind = "select";
let nodes: CanvasNode[] = starterNodes();
let assets: DocumentAsset[] = [];
/** The Worker-owned copy/cut clipboard. It carries subtree projections by value
 * and image references by AssetId only (never raw bytes), so paste re-validates
 * against the target document's Resource Index (P0-1). */
/** The durable projection version last emitted by the Core. It stamps the
 * clipboard so a stale cross-tab payload can be rejected on paste (P0-1). */
let documentSchemaVersion = 19;
let clipboard: EditorClipboard | undefined;
const imageBitmaps = new ImageBitmapCache<ImageBitmap>(MAX_RASTER_DECODED_BYTES);
const imageLoads = new Set<string>();
const fontFaces = new FontFaceRegistry();
let nodeById = new Map(nodes.map((node) => [node.id, node]));
let nodeBoundsById = new Map(nodes.map((node) => [node.id, boundsForNode(node)]));
let spatialGrid = createSpatialGridIndex(nodes, (node) => nodeBoundsById.get(node.id) ?? boundsForNode(node));
let selectedIds: string[] = [nodes[0].id];
let viewport = { x: 0, y: 0, zoom: 1 };
type LocalHistoryEntry = { nodes: CanvasNode[]; advancesRevision: boolean };
const history: LocalHistoryEntry[] = [];
let future: LocalHistoryEntry[] = [];
type HistoryKind = "core" | "local";
const undoOrder: HistoryKind[] = [];
let redoOrder: HistoryKind[] = [];
const preservedProjectionNodes = new Map<string, PresentationNode>();
let revision = 0;
let documentId = "00000000-0000-0000-0000-000000000000";
let drag: Drag | undefined;
let hoveredId: string | undefined;
let editingTextNodeId: string | undefined;
let documentCore: EditorSnapshot["documentCore"] = "Starting Rust/WASM bridge";
let wasmDocument: WasmDocumentEngine | undefined;
let bridgeLoadSequence = 0;
let ephemeralBenchmarkProjection = false;
let remoteBootstrapPending = false;
let remoteResetPending = false;
const localDevActorId = "00000000-0000-0000-0000-000000000007";
const assetApiUrl = new URL("/asset-api", self.location.origin).toString().replace(/\/$/, "");
const remoteSessionId = crypto.randomUUID();
let remoteClientSequence = 0n;
let remoteOperationQueue = Promise.resolve();
let gpuStatus: NonNullable<EditorSnapshot["gpu"]>["webgpu"] = "checking";
let webgl2Available = false;
let gpuProbeSequence = 0;
let gpuRecoveryAttempts = 0;
let gpuRenderer: WebGpuSceneRenderer | undefined;
let rendererPreference: RendererPreference = "auto";
let simulatedGpuLossesRequested = 0;
let simulatedGpuLosses = 0;
let simulateGpuLossAfterImage = false;
let simulatedGpuFault: SimulatedGpuFault | undefined;
let simulatedGpuFaultReported = false;
let gpuSceneBytes = 0;
let gpuSceneWithinBudget = true;
let gpuSceneLimitReported = false;
let textAtlasStatsSignature = "";
let imageTextureStatsSignature = "";
let rustRenderGraphFailureSignature = "";
type RustGpuScene = { revision: number; pageId: string; transientSceneVersion: number; instances: Float32Array; renderedNodeIds: ReadonlySet<string> };
let rustGpuScene: RustGpuScene | undefined;
const MAX_RUST_GPU_INSTANCE_NODES = 20_000;
type RustTextLayoutProjection = { revision: number; key: string; layout: RustTextLayout };
const rustTextLayouts = new Map<string, RustTextLayoutProjection>();
const rustTextLayoutLoads = new Set<string>();
type RustGpuTextProjection = { revision: number; key: string; glyphs: readonly WebGpuTextGlyph[] };
const rustGpuTextGlyphs = new Map<string, RustGpuTextProjection>();
const rustGpuTextLoads = new Set<string>();
const MAX_RUST_GPU_TEXT_GLYPHS_PER_NODE = 4_096;
let renderSurfaceBytes = 0;
let wasmMemory: WebAssembly.Memory | undefined;
let wasmRuntimePromise: Promise<typeof import("@/wasm/generated/editor_wasm")> | undefined;
let wasmRuntime: typeof import("@/wasm/generated/editor_wasm") | undefined;
let wasmHeapOverBudget = false;
type StrokeMeshPoint = Readonly<{ x: number; y: number }>;
type StrokeMeshTriangle = readonly [StrokeMeshPoint, StrokeMeshPoint, StrokeMeshPoint];
type StrokeMesh = readonly StrokeMeshTriangle[];
const canonicalStrokeMeshes = new Map<string, StrokeMesh | null>();
const canonicalPerSideStrokeMeshes = new Map<string, readonly StrokeMesh[] | null>();
// Drag positions are intentionally not committed to the document revision until
// pointer-up, but the GPU scene must still redraw them on every pointer move.
let transientSceneVersion = 0;
const diagnostics = createDiagnosticRecorder();
const renderPerformance = createRenderPerformanceSampler();

function starterNodes(): CanvasNode[] {
  return [
    { id: "00000000-0000-4000-8000-000000000001", pageId: defaultPageId, name: "Product card", kind: "frame", x: -250, y: -170, width: 500, height: 340, rotation: 0, fill: "#fbfbf8", stroke: "#d4d5cb", strokeWidth: 1, radius: 18, opacity: 1, visible: true },
    { id: "00000000-0000-4000-8000-000000000002", pageId: defaultPageId, name: "Sun disc", kind: "ellipse", x: -194, y: -112, width: 130, height: 130, rotation: 0, fill: "#f6ad62", stroke: "#b4612d", strokeWidth: 1, radius: 0, opacity: 1, visible: true },
    { id: "00000000-0000-4000-8000-000000000003", pageId: defaultPageId, name: "Signal", kind: "rectangle", x: 48, y: -92, width: 150, height: 46, rotation: 0, fill: "#e6edff", stroke: "#0048FF", strokeWidth: 1, radius: 23, opacity: 1, visible: true },
    { id: "00000000-0000-4000-8000-000000000004", pageId: defaultPageId, name: "Headline", kind: "text", x: -194, y: 65, width: 370, height: 64, rotation: 0, fill: "#20221c", stroke: "transparent", strokeWidth: 0, radius: 0, opacity: 1, text: "Design, with intent.", visible: true },
  ];
}

function cloneDocument() { return structuredClone(nodes); }
function activeNodes() {
  const visible = visibleNodesOnPage(nodes, activePageId, defaultPageId);
  return sortNodesByLayerOrder(visible.map((node) => worldSpaceProjectionNode(nodes, node) ?? node));
}
/** A projected legacy node can continue through the fast Canvas/GPU paths.
 * Skew and reflection intentionally retain their local geometry, so this pass
 * applies the exact world affine directly to Canvas instead of decomposing it.
 */
function nativeAffineForNode(node: CanvasNode): AffineMatrix | undefined {
  return node.relativeTransform ? worldTransformForNode(nodes, node.id) : undefined;
}
function boundsForNode(node: CanvasNode) {
  if (node.kind === "line") {
    const visual = worldLineVisualBounds(nodes, node);
    if (visual) return { x: visual.left, y: visual.top, width: visual.right - visual.left, height: visual.bottom - visual.top };
  }
  const alignedClosedShape = (node.kind === "ellipse" && !node.arcData) || node.kind === "frame" || node.kind === "rectangle";
  if (alignedClosedShape && (node.strokeAlign ?? "inside") !== "inside" && node.strokeWidth > 0) {
    const visual = worldVisualBoundsForNode(nodes, node);
    if (visual) return { x: visual.left, y: visual.top, width: visual.right - visual.left, height: visual.bottom - visual.top };
  }
  const bounds = nativeAffineForNode(node) ? worldBoundsForNode(nodes, node) : undefined;
  return bounds ? { x: bounds.left, y: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top } : rotatedNodeBounds(node);
}
function applyNativeAffine(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode) {
  const affine = nativeAffineForNode(node);
  if (!affine) return false;
  const origin = toScreen(affine.e, affine.f);
  // Render coordinates below are already scaled by viewport.zoom. Therefore
  // the linear world matrix is used as-is while only its translation enters
  // screen space: screen(M * (local * zoom)) + screen(translation).
  ctx.transform(affine.a, affine.b, affine.c, affine.d, origin.x, origin.y);
  return true;
}
function containsWorldPoint(node: CanvasNode, point: { x: number; y: number }) {
  const affine = nativeAffineForNode(node);
  if (!affine) return findTopmostHit([node], point) === node;
  const inverse = invertAffine(affine);
  if (!inverse) return false;
  const local = transformPoint(inverse, point);
  return findTopmostHit([{ ...node, x: 0, y: 0, rotation: 0, relativeTransform: undefined }], local) !== undefined;
}
/** Frame clipping is structural: an object remains a child even when only a
 * portion of it is visible. Keep this test beside hit testing so no pointer
 * target can escape a clipped ancestor. Groups and Sections intentionally do
 * not create a clip. */
function isInsideClippingFrames(node: CanvasNode, point: { x: number; y: number }) {
  const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]));
  const visited = new Set<string>();
  let parentId = node.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) return false;
    if (parent.kind === "frame" && parent.clipsContent !== false && !containsWorldPoint(parent, point)) return false;
    parentId = parent.parentId;
  }
  return true;
}
function refreshTransientGroupBounds(preservedGroupIds: ReadonlySet<string> = new Set()) {
  const normalized = normalizeGroupBounds(nodes, { excludeGroupIds: preservedGroupIds });
  if (normalized) nodes = normalized;
}
function rebuildNodeIndex() {
  const projected = nodes.map((node) => worldSpaceProjectionNode(nodes, node) ?? node);
  nodeById = new Map(projected.map((node) => [node.id, node]));
  nodeBoundsById = new Map(projected.map((node) => [node.id, boundsForNode(node)]));
  spatialGrid = createSpatialGridIndex(activeNodes(), (node) => nodeBoundsById.get(node.id) ?? boundsForNode(node));
}
function emit(message: WorkerToMain) { self.postMessage(message); }
function emitError(error: unknown, code?: EditorErrorCode, transactionId?: string) {
  const classified = code ? editorError(code) : classifyEditorError(error);
  const diagnostic = diagnostics.record({ category: "lifecycle", code: `ENGINE_${classified.code}`, documentRevision: revision, details: { errorCode: classified.code } });
  emit({ type: "error", ...classified, documentRevision: revision, diagnosticId: diagnostic.sequence, transactionId });
}
function emitSnapshot(localJournalEntry?: LocalJournalEntry, persistable = true) {
  const documentHash = wasmDocument?.canonical_hash();
  const localSnapshot = persistable && !ephemeralBenchmarkProjection && wasmDocument ? { format: "rust-core-v1", coreRevision: Number(wasmDocument.revision), coreSnapshot: wasmDocument.snapshot_json(), ...(documentHash ? { documentHash } : {}), viewport: { ...viewport }, presentation: nodes.map(presentationNode) } satisfies CoreLocalSnapshot : undefined;
  const memory = wasmDocument ? JSON.parse(wasmDocument.memory_stats_json()) as EditorSnapshot["memory"] : undefined;
  const wasmHeap = assessWasmHeap(wasmMemory?.buffer.byteLength ?? 0);
  if (!wasmHeap.withinBudget && wasmHeap.reason === "RESOURCE_LIMIT" && !wasmHeapOverBudget) {
    wasmHeapOverBudget = true;
    diagnostics.record({ category: "lifecycle", code: "WASM_HEAP_SOFT_LIMIT" });
  }
  if (wasmHeap.withinBudget) wasmHeapOverBudget = false;
  const fontAvailability = Object.fromEntries(assets.filter((asset) => asset.mediaType.startsWith("font/")).map((asset) => [asset.assetId, fontFaces.statusFor(asset.assetId)]));
  emit({ type: "snapshot", snapshot: { documentId, revision, documentHash, memory, resources: { documentNodes: memory?.nodeCount ?? nodes.length, maxDocumentNodes: 100_000, documentBytes: memory?.nodeBytes ?? 0, maxDocumentBytes: memory?.maxDocumentBytes ?? 256 * 1024 * 1024, wasmHeapBytes: wasmHeap.bytes, maxWasmHeapBytes: MAX_WASM_HEAP_BYTES, renderSurfaceBytes, maxRenderSurfaceBytes: MAX_RENDER_SURFACE_BYTES, gpuSceneBytes, maxGpuSceneBytes: MAX_GPU_SCENE_RESOURCE_BYTES, gpuSceneWithinBudget }, diagnostics: diagnostics.summary(), performance: renderPerformance.summary(), nodes, assets, fontAvailability, pages, activePageId, selectedIds, viewport, canUndo: undoOrder.length > 0, canRedo: redoOrder.length > 0, renderer: gpuRenderer && gpuSceneWithinBudget ? "WebGPU + Canvas 2D overlay" : "Canvas 2D", gpu: { webgpu: gpuStatus, webgl2Available, recoveryAttempts: gpuRecoveryAttempts, ...(simulatedGpuLossesRequested ? { developmentSimulation: { requestedLosses: simulatedGpuLossesRequested, completedLosses: simulatedGpuLosses } } : {}) }, documentCore, localSnapshot, localJournalEntry } });
}
function emitRemoteBootstrap() {
  if (!wasmDocument || documentCore !== "Rust/WASM bridge ready") return;
  remoteBootstrapPending = false;
  const snapshot = wasmDocument.snapshot_protobuf();
  self.postMessage({ type: "remote-bootstrap", documentId, revision, snapshot } satisfies WorkerToMain, [snapshot.buffer]);
}
function applyRemoteSnapshot(snapshot: Uint8Array, publish = true) {
  if (!wasmDocument) {
    emitError(undefined, "TRANSIENT");
    return false;
  }
  try {
    wasmDocument.load_snapshot_protobuf(snapshot);
    history.length = 0;
    future = [];
    undoOrder.length = 0;
    redoOrder = [];
    selectedIds = [];
    syncProjectionFromWasm(false);
    if (!pages.some((page) => page.id === activePageId)) activePageId = pages[0]?.id ?? defaultPageId;
    rebuildNodeIndex();
    render();
    if (publish) {
      diagnostics.record({ category: "recovery", code: "REMOTE_SNAPSHOT_APPLIED", documentRevision: revision });
      emitSnapshot();
    }
    return true;
  } catch (error) {
    diagnostics.record({ category: "recovery", code: "REMOTE_SNAPSHOT_REJECTED", documentRevision: revision });
    // A newer-engine node yields DOCUMENT_REQUIRES_NEWER_CLIENT, which classifies
    // as UNSUPPORTED_DOCUMENT_VERSION (read-only), not corruption. The prior core
    // document is untouched by the rejected load, so the editor stays consistent.
    const message = error instanceof Error ? error.message : "";
    emitError(error, /DOCUMENT_REQUIRES_NEWER_CLIENT/.test(message) ? undefined : "CORRUPT_DATA");
    return false;
  }
}
function hydrateRemoteSnapshot(snapshot: Uint8Array) { applyRemoteSnapshot(snapshot); }

/** Serializing envelope derivation preserves the same client sequence and order
 * as the locally committed Core revision stream, even when WebCrypto resolves
 * hashes asynchronously. */
function queueRemoteOperation(transactionId: string, baseRevision: number, batch: readonly CoreBatchCommand[], localDocumentHash: string) {
  queueRemotePayload(transactionId, baseRevision, encodeCoreBatchPayload(batch), localDocumentHash, { kind: "core-batch", batch: structuredClone([...batch]) });
}

async function buildPendingRemoteOperation(transactionId: string, baseRevision: number, payload: Uint8Array, localDocumentHash: string, replay?: PendingOperationReplay): Promise<PendingRemoteOperation> {
  const documentForOperation = documentId;
  const clientSequence = ++remoteClientSequence;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(payload).buffer));
  const envelope = await encodeOperationPayloadEnvelope({
    documentId: documentForOperation,
    operationId: transactionId,
    transactionId,
    actorId: localDevActorId,
    sessionId: remoteSessionId,
    clientSequence,
    baseRevision: BigInt(baseRevision),
    engineSemanticsVersion: 3,
  }, payload);
  return {
    format: "pending-operation-v1",
    operationId: transactionId,
    transactionId,
    documentId: documentForOperation,
    baseRevision,
    envelope,
    payloadHash: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    localDocumentHash,
    createdAtMs: Date.now(),
    attempts: 0,
    ...(replay ? { replay } : {}),
  };
}
function queueRemotePayload(transactionId: string, baseRevision: number, payload: Uint8Array, localDocumentHash: string, replay?: PendingOperationReplay) {
  remoteOperationQueue = remoteOperationQueue
    .catch(() => undefined)
    .then(async () => {
      const operation = await buildPendingRemoteOperation(transactionId, baseRevision, payload, localDocumentHash, replay);
      self.postMessage({ type: "remote-operation", operation } satisfies WorkerToMain, [operation.envelope.buffer]);
    })
    .catch((error) => emitError(error, "TRANSIENT", transactionId));
}

function applyPendingReplay(replay: PendingOperationReplay, transactionId: string) {
  if (!wasmDocument) throw new Error("WASM_DOCUMENT_UNAVAILABLE");
  const baseRevision = Number(wasmDocument.revision);
  let payload: Uint8Array;
  if (replay.kind === "core-batch") {
    const batch = rebaseCoreBatchForSnapshot(nodes, replay.batch);
    wasmDocument.apply_transaction_json(transactionId, wasmDocument.revision, JSON.stringify(batch));
    payload = encodeCoreBatchPayload(batch);
    replay = { kind: "core-batch", batch };
  } else if (replay.kind === "create-page") {
    wasmDocument.create_page(transactionId, wasmDocument.revision, replay.page.id, replay.page.name);
    payload = encodeCreatePagePayload(replay.page);
  } else {
    const asset = replay.asset;
    wasmDocument.register_asset(transactionId, wasmDocument.revision, asset.assetId, asset.contentHash, asset.mediaType, BigInt(asset.byteLength), asset.pixelWidth ?? 0, asset.pixelHeight ?? 0);
    payload = encodeRegisterResourcePayload(asset);
  }
  return { baseRevision, payload, replay };
}

/** Rebuilds the local projection from the service-owned Snapshot, then applies
 * only concrete intents that Rust still accepts. Every replacement receives a
 * fresh Operation/Transaction ID and current base revision; old envelopes are
 * never mutated, preserving service idempotency and the causal audit trail. */
async function reconcileRemoteSnapshot(snapshot: Uint8Array, operations: PendingRemoteOperation[]) {
  if (!applyRemoteSnapshot(snapshot, false) || !wasmDocument) return;
  const plan = planPendingOperationReconciliation(operations);
  const removeOperationIds = [...plan.removeOperationIds];
  const discardedOperationIds = [...plan.discardedOperationIds];
  const rejectionDiagnostics = operations
    .filter((operation) => plan.discardedOperationIds.includes(operation.operationId) && operation.reconciliation?.kind === "rejected")
    .map((operation) => operation.reconciliation?.diagnostic)
    .filter((diagnostic): diagnostic is string => Boolean(diagnostic));
  const coreRejectedOperationIds: string[] = [];
  const blockedOperationIds = [...plan.blockedOperationIds];
  const replacements: PendingRemoteOperation[] = [];
  for (const operation of plan.replayable) {
    const replay = operation.replay;
    // `planPendingOperationReconciliation` only returns records with replay
    // data. Keep this guard at the Worker boundary in case an old IndexedDB
    // record is malformed after structured-clone deserialization.
    if (!replay) {
      blockedOperationIds.push(operation.operationId);
      break;
    }
    const replacementId = crypto.randomUUID();
    let replayed: ReturnType<typeof applyPendingReplay>;
    try {
      replayed = applyPendingReplay(replay, replacementId);
    } catch {
      // The target may have been deleted or become invalid in the authoritative
      // remote state. It is no longer a valid local intent; continue so a later
      // independent create can still be recovered.
      diagnostics.record({ category: "recovery", code: "REMOTE_REPLAY_CORE_REJECTED", documentRevision: revision, transactionId: operation.transactionId });
      removeOperationIds.push(operation.operationId);
      discardedOperationIds.push(operation.operationId);
      coreRejectedOperationIds.push(operation.operationId);
      continue;
    }
    try {
      const replacement = await buildPendingRemoteOperation(
        replacementId,
        replayed.baseRevision,
        replayed.payload,
        wasmDocument.canonical_hash(),
        structuredClone(replayed.replay),
      );
      removeOperationIds.push(operation.operationId);
      replacements.push(replacement);
    } catch {
      // The Core has tentatively accepted this intent, but the replacement
      // cannot be made durable without its envelope. Restore the authoritative
      // snapshot and retain every replay candidate: emitting an earlier
      // replacement while an older original remains queued would invert their
      // causal order on the next flush.
      applyRemoteSnapshot(snapshot, false);
      removeOperationIds.splice(plan.removeOperationIds.length);
      replacements.splice(0);
      diagnostics.record({ category: "recovery", code: "REMOTE_REPLAY_ENVELOPE_FAILED", documentRevision: revision, transactionId: operation.transactionId });
      blockedOperationIds.push(operation.operationId);
      break;
    }
  }
  // A render/projection refresh is recoverable presentation work. It must never
  // turn an already accepted Rust replay into a discarded document operation.
  try { syncProjectionFromWasm(false); }
  catch {
    diagnostics.record({ category: "renderer", code: "REMOTE_RECONCILIATION_PROJECTION_FAILED", documentRevision: revision });
  }
  diagnostics.record({
    category: "recovery",
    code: blockedOperationIds.length ? "REMOTE_RECONCILIATION_BLOCKED" : "REMOTE_RECONCILIATION_APPLIED",
    documentRevision: revision,
    details: { replacements: replacements.length, discarded: discardedOperationIds.length, blocked: blockedOperationIds.length },
  });
  emitSnapshot();
  self.postMessage({ type: "remote-reconciled", removeOperationIds, replacements, discardedOperationIds, coreRejectedOperationIds, blockedOperationIds, rejectionDiagnostics } satisfies WorkerToMain);
}
function emitViewportCheckpoint() {
  if (!wasmDocument) return;
  emit({ type: "viewport-checkpoint", viewport: { ...viewport }, documentHash: wasmDocument.canonical_hash(), coreRevision: Number(wasmDocument.revision) });
}
function emitViewState(viewportChanged = false) {
  emit({ type: "view-state", viewport: { ...viewport }, selectedIds: [...selectedIds], performance: renderPerformance.summary(), viewportChanged });
}
function setRenderSurface(nextWidth: number, nextHeight: number, nextDeviceDpr: number) {
  const nextDpr = renderDpr(nextDeviceDpr, renderQuality);
  const admission = admitRenderSurface(nextWidth, nextHeight, nextDpr);
  if (!admission.accepted) {
    diagnostics.record({ category: "renderer", code: "RENDER_SURFACE_REJECTED" });
    emitError(undefined, "RESOURCE_LIMIT");
    emitSnapshot(undefined, false);
    return false;
  }
  width = nextWidth;
  height = nextHeight;
  deviceDpr = nextDeviceDpr;
  dpr = nextDpr;
  renderSurfaceBytes = admission.bytes;
  if (canvas && (canvas.width !== admission.pixelWidth || canvas.height !== admission.pixelHeight)) {
    canvas.width = Math.max(1, admission.pixelWidth);
    canvas.height = Math.max(1, admission.pixelHeight);
  }
  return true;
}
function scheduleSettledRenderQuality() {
  if (renderQualityTimer) clearTimeout(renderQualityTimer);
  renderQualityTimer = setTimeout(() => {
    renderQualityTimer = undefined;
    renderQuality = resolveRenderQuality(renderQuality, viewport.zoom, false);
    if (setRenderSurface(width, height, deviceDpr)) {
      render();
      emitViewState(true);
    }
  }, 160);
}
function activateInteractiveRenderQuality() {
  renderQuality = resolveRenderQuality(renderQuality, viewport.zoom, true);
  setRenderSurface(width, height, deviceDpr);
  scheduleSettledRenderQuality();
}
function probeWebgl2() {
  try { return typeof OffscreenCanvas !== "undefined" && Boolean(new OffscreenCanvas(1, 1).getContext("webgl2")); } catch { return false; }
}
async function probeGpuDevice(recovery = false) {
  const sequence = ++gpuProbeSequence;
  webgl2Available = probeWebgl2();
  if (rendererPreference === "canvas2d") {
    gpuRenderer?.destroy();
    gpuRenderer = undefined;
    gpuSceneBytes = 0;
    gpuSceneWithinBudget = true;
    gpuStatus = "unavailable";
    diagnostics.record({ category: "renderer", code: "WEBGPU_DISABLED_FOR_CAPTURE" });
    emitSnapshot(undefined, false);
    return;
  }
  if (!(navigator as Navigator & { gpu?: unknown }).gpu) { gpuStatus = "unavailable"; diagnostics.record({ category: "renderer", code: "WEBGPU_UNAVAILABLE" }); emitSnapshot(undefined, false); return; }
  gpuStatus = recovery ? "recovering" : "checking";
  emitSnapshot(undefined, false);
  try {
    const renderer = await WebGpuSceneRenderer.create();
    if (sequence !== gpuProbeSequence) { renderer.destroy(); return; }
    gpuRenderer?.destroy();
    gpuRenderer = renderer;
    renderer.setFailureListener((code) => {
      if (gpuRenderer !== renderer) return;
      diagnostics.record({ category: "renderer", code, documentRevision: revision, details: { errorKind: code } });
      // OOM means the current derived allocation set is no longer trustworthy.
      // Follow the same bounded recovery path as device loss; validation errors
      // remain observable but do not discard a device that the browser keeps valid.
      if (code === "WEBGPU_OUT_OF_MEMORY" || code === "WEBGPU_UPLOAD_FAILED") {
        renderer.destroy();
        handleGpuDeviceLoss(renderer);
      } else emitSnapshot(undefined, false);
    });
    gpuSceneBytes = 0;
    gpuSceneWithinBudget = true;
    gpuSceneLimitReported = false;
    textAtlasStatsSignature = "";
    imageTextureStatsSignature = "";
    gpuStatus = "ready";
    diagnostics.record({ category: "renderer", code: "WEBGPU_SCENE_READY" });
    // The first draw uploads the derived instance scene. It is renderer startup,
    // not a zoom-frame cost, so begin a fresh steady-state sampling window after it.
    renderPerformance.reset();
    render();
    renderPerformance.start();
    emitSnapshot(undefined, false);
    maybeSimulateGpuLoss();
    maybeSimulateGpuFault();
    void renderer.deviceLost.then(() => { handleGpuDeviceLoss(renderer); });
  } catch (error) {
    if (sequence !== gpuProbeSequence) return;
    gpuRenderer?.destroy();
    gpuRenderer = undefined;
    gpuSceneBytes = 0;
    gpuStatus = "unavailable";
    const code = classifyWebGpuRendererFailure(error);
    diagnostics.record({ category: "renderer", code, documentRevision: revision, details: { errorKind: code } });
    emitSnapshot(undefined, false);
  }
}

/**
 * Handles loss exactly once for the renderer that still owns presentation.
 * The browser's `device.lost` promise is the production signal. Development
 * fault injection also calls this after destroying a real device: Chromium
 * may not settle `device.lost` a second time promptly after explicit destroy,
 * but the renderer is already unusable and must follow the same bounded path.
 */
function handleGpuDeviceLoss(renderer: WebGpuSceneRenderer) {
  if (gpuRenderer !== renderer) return;
  gpuRenderer = undefined;
  gpuSceneBytes = 0;
  textAtlasStatsSignature = "";
  imageTextureStatsSignature = "";
  if (gpuRecoveryAttempts >= 1) {
    gpuStatus = "unavailable";
    diagnostics.record({ category: "renderer", code: "WEBGPU_RECOVERY_EXHAUSTED" });
    emitSnapshot(undefined, false);
    return;
  }
  gpuRecoveryAttempts += 1;
  gpuStatus = "recovering";
  emitSnapshot(undefined, false);
  setTimeout(() => {
    if (gpuRenderer === undefined && gpuStatus === "recovering") void probeGpuDevice(true);
  }, 250);
}

/** Destroy only derived GPU state. The image-fixture variant waits until a
 * decoded bitmap is actually bound to a visible Image node, so recovery proves
 * texture recreation rather than merely rebuilding an empty renderer. */
function maybeSimulateGpuLoss() {
  if (!gpuRenderer || simulatedGpuLosses >= simulatedGpuLossesRequested) return;
  if (simulateGpuLossAfterImage && !activeNodes().some((node) => node.kind === "image" && Boolean(node.assetId) && imageBitmaps.has(node.assetId!))) return;
  setTimeout(() => {
    // Fault injection must target the renderer that is actively presenting at
    // execution time. A recovery can replace the initially captured renderer
    // before this timer runs; destroying that stale device neither tests nor
    // protects the bounded fallback path.
    const activeRenderer = gpuRenderer;
    if (!activeRenderer || simulatedGpuLosses >= simulatedGpuLossesRequested) return;
    simulatedGpuLosses += 1;
    diagnostics.record({ category: "renderer", code: "WEBGPU_DEVICE_LOSS_SIMULATION", details: { loss: simulatedGpuLosses, afterImage: simulateGpuLossAfterImage } });
    activeRenderer.destroy();
    handleGpuDeviceLoss(activeRenderer);
  }, 100);
}

/** Development-only evidence uses the same renderer error listener as a real
 * uncaptured GPU failure while keeping actual device allocation untouched. */
function maybeSimulateGpuFault() {
  if (!gpuRenderer || !simulatedGpuFault || simulatedGpuFaultReported) return;
  simulatedGpuFaultReported = true;
  setTimeout(() => {
    const activeRenderer = gpuRenderer;
    if (!activeRenderer || !simulatedGpuFault) return;
    const error = simulatedGpuFault === "out-of-memory"
      ? { name: "GPUOutOfMemoryError", message: "simulated allocation" }
      : simulatedGpuFault === "upload"
        ? { name: "GPUValidationError", message: "queue.writeTexture simulated" }
        : { name: "GPUValidationError", message: "simulated validation" };
    diagnostics.record({ category: "renderer", code: "WEBGPU_FAULT_SIMULATION", documentRevision: revision, details: { errorKind: simulatedGpuFault } });
    activeRenderer.reportFailure(error);
  }, 100);
}
function presentationNode(node: CanvasNode): PresentationNode {
  return { id: node.id };
}
function journalEntry(operation: CoreJournalOperation, baseRevision: number, id = crypto.randomUUID()): LocalJournalEntry | undefined {
  if (!wasmDocument || ephemeralBenchmarkProjection) return undefined;
  return {
    format: "rust-core-operation-v1",
    id,
    baseRevision,
    acceptedRevision: Number(wasmDocument.revision),
    operation,
    fallbackCoreSnapshot: wasmDocument.snapshot_json(),
    presentation: nodes.map(presentationNode),
    viewport: { ...viewport },
  };
}
function rememberProjection(nodesToRemember = nodes) {
  nodesToRemember.forEach((node) => preservedProjectionNodes.set(node.id, presentationNode(node)));
}
function canvasNodeFromProjection(node: WasmProjectionNode): CanvasNode {
  return {
    id: node.id, pageId: node.pageId, parentId: node.parentId, name: node.name, kind: node.kind, x: node.x, y: node.y, width: node.width, height: node.height,
    rotation: node.rotation, fill: node.fill, fillColor: node.fillColor, fillGradient: node.fillGradient, fills: node.fills, positionId: node.positionId,
    stroke: node.stroke, strokeColor: node.strokeColor, strokeGradient: node.strokeGradient, strokes: node.strokes, strokeWidth: node.strokeWidth, strokeCapStart: node.strokeCapStart, strokeCapEnd: node.strokeCapEnd, strokeJoin: node.strokeJoin, strokeMiterLimit: node.strokeMiterLimit, strokeDashPattern: node.strokeDashPattern, strokeWeights: node.strokeWeights?.length === 4 ? [node.strokeWeights[0], node.strokeWeights[1], node.strokeWeights[2], node.strokeWeights[3]] : undefined, strokeAlign: node.strokeAlign, arcData: node.arcData, relativeTransform: node.relativeTransform, clipsContent: node.clipsContent,
    radius: node.cornerRadius, cornerRadii: node.cornerRadii?.length === 4 ? [node.cornerRadii[0], node.cornerRadii[1], node.cornerRadii[2], node.cornerRadii[3]] : undefined, cornerSmoothing: node.cornerSmoothing, constraints: node.constraints, opacity: node.opacity, text: node.text, textProperties: node.textProperties, assetId: node.assetId, visible: node.visible, locked: node.locked, contentsHidden: node.contentsHidden, extensions: node.extensions,
  };
}
function syncProjectionFromWasm(rememberExisting = true) {
  if (!wasmDocument) return;
  if (rememberExisting) rememberProjection();
  const snapshot = JSON.parse(wasmDocument.snapshot_json()) as WasmProjectionSnapshot;
  documentId = snapshot.documentId ?? documentId;
  documentSchemaVersion = snapshot.schemaVersion;
  pages = snapshot.pages?.length ? snapshot.pages : pages;
  assets = snapshot.resourceIndex ?? [];
  if (!pages.some((page) => page.id === activePageId)) activePageId = pages[0]?.id ?? defaultPageId;
  nodes = snapshot.nodes.map((node) => {
    const previous = preservedProjectionNodes.get(node.id);
    const projected = canvasNodeFromProjection(node);
    if (snapshot.schemaVersion < 3) projected.text = previous?.text;
    preservedProjectionNodes.set(projected.id, presentationNode(projected));
    return projected;
  });
  selectedIds = selectedIds.filter((id) => nodes.some((node) => node.id === id));
  rebuildNodeIndex();
  revision = snapshot.revision;
  refreshRustGpuScene();
  nodes.filter((node) => node.assetId).forEach((node) => void ensureImageBitmap(node.assetId!));
  nodes.filter((node) => node.kind === "text").forEach((node) => {
    const properties = node.textProperties;
    if (!properties) return;
    const fontIds = [
      ...properties.runs.flatMap((run) => run.font ? [run.font.assetId] : []),
      ...(properties.fallbackFonts ?? []).map((font) => font.assetId),
    ];
    new Set(fontIds).forEach((assetId) => void ensureFontFace(assetId));
  });
  refreshRustTextLayouts();
  refreshRustGpuTextGlyphs();
}

/** Builds the immutable, committed solid-shape batch once per Canonical sync.
 * A drag deliberately invalidates it and uses the local projection until the
 * resulting move transaction is accepted and projected again. */
function refreshRustGpuScene() {
  if (!wasmDocument || nodes.length > MAX_RUST_GPU_INSTANCE_NODES) {
    rustGpuScene = undefined;
    return;
  }
  try {
    const payload = parseRustGpuSceneBatch(wasmDocument.gpu_scene_instances_json(activePageId));
    if (!payload) throw new Error("INVALID_RUST_GPU_BATCH");
    rustGpuScene = {
      revision,
      pageId: activePageId,
      transientSceneVersion,
      instances: payload.instances,
      renderedNodeIds: payload.renderedNodeIds,
    };
  } catch {
    rustGpuScene = undefined;
    diagnostics.record({ category: "renderer", code: "RUST_GPU_BATCH_UNAVAILABLE", documentRevision: revision });
  }
}

/**
 * The Rust graph is the authoritative derived command stream for the current
 * visible scene. A missing node or revision mismatch is treated as unavailable
 * rather than allowing a stale graph to hide a Canvas fallback node.
 */
function rustRenderGraphForVisibleNodes(viewportBounds: { x: number; y: number; width: number; height: number }, visibleNodes: readonly CanvasNode[]): RustRenderGraphPlan | undefined {
  if (!wasmDocument) return undefined;
  try {
    const plan = parseRustRenderGraphPlan(wasmDocument.render_graph_plan_for_page_json(
      activePageId,
      viewportBounds.x,
      viewportBounds.y,
      viewportBounds.width,
      viewportBounds.height,
    ));
    if (!plan || plan.documentRevision !== revision || visibleNodes.some((node) => !plan.orderByNodeId.has(node.id))) {
      throw new Error("RUST_RENDER_GRAPH_STALE_OR_INCOMPLETE");
    }
    rustRenderGraphFailureSignature = "";
    return plan;
  } catch {
    const signature = `${revision}:${activePageId}:${visibleNodes.map((node) => node.id).join(",")}`;
    if (signature !== rustRenderGraphFailureSignature) {
      rustRenderGraphFailureSignature = signature;
      diagnostics.record({ category: "renderer", code: "RUST_RENDER_GRAPH_UNAVAILABLE", documentRevision: revision });
    }
    return undefined;
  }
}

/** Derives line ranges only for a fully explicit, single-face run. Mixed runs
 * remain on the documented Canvas transition path until per-run shaping and
 * glyph raster passes are available. */
function variationAxesKey(font: DocumentFontReference | undefined) {
  return JSON.stringify([...(font?.variationAxes ?? [])]
    // Do not discard malformed coordinates here: the Rust boundary must reject
    // them instead of silently rendering the default variable-font instance.
    .sort((left, right) => left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0)
    .map((axis) => ({ tag: axis.tag, value: axis.value })));
}

function rustTextLayoutRequest(node: CanvasNode) {
  const source = node.text ?? "Text";
  const properties = node.textProperties;
  const run = properties?.runs.length === 1 ? properties.runs[0] : undefined;
  if (!run?.font || !Number.isFinite(run.fontSize) || run.fontSize <= 0 || !Number.isFinite(node.width) || node.width <= 0) return undefined;
  const sourceByteLength = new TextEncoder().encode(source).byteLength;
  if (run.start !== 0 || run.end !== sourceByteLength) return undefined;
  const axesKey = variationAxesKey(run.font);
  const key = JSON.stringify([revision, node.id, source, node.width, run.font.assetId, run.font.faceIndex, axesKey, run.fontSize]);
  return { key, source, font: run.font, axesKey, fontSize: run.fontSize, widthEm: node.width / run.fontSize };
}

function refreshRustTextLayouts() {
  const active = new Set<string>();
  nodes.filter((node) => node.kind === "text").forEach((node) => {
    const request = rustTextLayoutRequest(node);
    if (!request) return;
    active.add(node.id);
    if (rustTextLayouts.get(node.id)?.key === request.key || rustTextLayoutLoads.has(request.key)) return;
    if (fontFaces.statusFor(request.font.assetId) !== "ready") return;
    rustTextLayoutLoads.add(request.key);
    void loadRustTextLayout(node.id, request);
  });
  [...rustTextLayouts].forEach(([nodeId, cached]) => {
    if (!active.has(nodeId) || cached.revision !== revision) rustTextLayouts.delete(nodeId);
  });
}

async function loadRustTextLayout(
  nodeId: string,
  request: NonNullable<ReturnType<typeof rustTextLayoutRequest>>,
) {
  try {
    const asset = assets.find((candidate) => candidate.assetId === request.font.assetId);
    if (!asset) throw new Error("FONT_ASSET_MISSING");
    const blob = await loadAssetBlob(asset);
    if (!blob) throw new Error("FONT_ASSET_UNAVAILABLE");
    const wasm = await loadWasmRuntime();
    const payload = wasm.layout_shaped_text_with_variations_json(
      new Uint8Array(await blob.arrayBuffer()),
      request.font.faceIndex,
      request.axesKey,
      request.source,
      request.widthEm,
    );
    const layout = parseRustTextLayout(payload, request.source);
    if (!layout) throw new Error("INVALID_RUST_TEXT_LAYOUT");
    const currentNode = nodes.find((node) => node.id === nodeId);
    if (!currentNode || rustTextLayoutRequest(currentNode)?.key !== request.key) return;
    rustTextLayouts.set(nodeId, { revision, key: request.key, layout });
    refreshRustGpuTextGlyphs();
    render();
  } catch {
    diagnostics.record({ category: "renderer", code: "RUST_TEXT_LAYOUT_UNAVAILABLE", documentRevision: revision });
  } finally {
    rustTextLayoutLoads.delete(request.key);
  }
}

/** Returns the Core-owned set of legal UTF-8 caret stops for a live DOM edit.
 * This never changes the Document: it only prevents browser UTF-16 selections
 * from splitting graphemes before a later atomic text transaction commits. */
async function emitRustTextCaretLayout(request: Extract<MainToWorker, { type: "text-caret-layout" }>) {
  try {
    const wasm = await loadWasmRuntime();
    const maxGraphemes = Math.max(1, Math.min(65_535, Array.from(request.text).length));
    const layout = parseRustTextCaretLayout(JSON.parse(wasm.fallback_text_layout_json(request.text, maxGraphemes)));
    if (!layout) throw new Error("INVALID_RUST_TEXT_CARET_LAYOUT");
    emit({ type: "text-caret-layout", requestId: request.requestId, nodeId: request.nodeId, text: request.text, layout });
  } catch {
    diagnostics.record({ category: "renderer", code: "RUST_TEXT_CARET_UNAVAILABLE", documentRevision: revision });
    emit({ type: "text-caret-layout", requestId: request.requestId, nodeId: request.nodeId, text: request.text });
  }
}

/** Converts only the already-validated single-face LTR layout into ephemeral
 * GPU glyph draws. Mixed styles and RTL remain Canvas until the Text Pass has
 * the equivalent line transform model. Variable Font coordinates stay in the
 * Rust layout/raster path and renderer cache key. */
function rustGpuTextRequest(node: CanvasNode) {
  const layoutRequest = rustTextLayoutRequest(node);
  const layout = rustTextLayoutFor(node);
  if (!layoutRequest || !layout || !layout.lines.length || layout.lines.some((line) => line.direction !== "ltr")) return undefined;
  const properties = node.textProperties;
  const run = properties?.runs[0];
  // The current instance format expresses glyph-local geometry. Keep node
  // rotation, non-left alignment, synthetic styling and paragraph gaps on the
  // Canvas path until the Text Pass has the equivalent line transform model.
  if (node.rotation !== 0 || properties?.paragraph.alignment !== "left" || (properties?.paragraph.paragraphSpacing ?? 0) !== 0 || run?.italic || (run?.letterSpacing ?? 0) !== 0 || run?.fontWeight !== 400) return undefined;
  if (layout.lines.reduce((total, line) => total + line.glyphs.length, 0) > MAX_RUST_GPU_TEXT_GLYPHS_PER_NODE) return undefined;
  const pixelSize = Math.min(512, Math.max(8, Math.ceil(layoutRequest.fontSize)));
  const key = JSON.stringify([layoutRequest.key, pixelSize, node.x, node.y, node.rotation, node.fill, node.opacity, node.textProperties?.paragraph.lineHeight, node.textProperties?.paragraph.paragraphSpacing]);
  return {
    ...layoutRequest,
    key,
    layout,
    pixelSize,
    nodeX: node.x,
    nodeY: node.y,
    nodeRotation: node.rotation,
    nodeFill: node.fill,
    nodeOpacity: node.opacity,
    nodeLineHeight: node.textProperties?.paragraph.lineHeight,
  };
}

function refreshRustGpuTextGlyphs() {
  const active = new Set<string>();
  activeNodes().filter((node) => node.kind === "text" && node.visible !== false).forEach((node) => {
    const request = rustGpuTextRequest(node);
    if (!request) return;
    active.add(node.id);
    if (rustGpuTextGlyphs.get(node.id)?.key === request.key || rustGpuTextLoads.has(request.key)) return;
    rustGpuTextLoads.add(request.key);
    void loadRustGpuTextGlyphs(node.id, request);
  });
  [...rustGpuTextGlyphs].forEach(([nodeId, cached]) => {
    if (!active.has(nodeId) || cached.revision !== revision) rustGpuTextGlyphs.delete(nodeId);
  });
}

async function loadRustGpuTextGlyphs(
  nodeId: string,
  request: NonNullable<ReturnType<typeof rustGpuTextRequest>>,
) {
  try {
    const asset = assets.find((candidate) => candidate.assetId === request.font.assetId);
    if (!asset) throw new Error("FONT_ASSET_MISSING");
    const blob = await loadAssetBlob(asset);
    if (!blob) throw new Error("FONT_ASSET_UNAVAILABLE");
    const wasm = await loadWasmRuntime();
    const fontBytes = new Uint8Array(await blob.arrayBuffer());
    const rasters = new Map<number, ReturnType<typeof parseRustGlyphRaster>>();
    for (const line of request.layout.lines) {
      for (const glyph of line.glyphs) {
        if (glyph.glyphId === 0) throw new Error("MISSING_GLYPH_OUTLINE");
        if (rasters.has(glyph.glyphId)) continue;
        rasters.set(glyph.glyphId, parseRustGlyphRaster(wasm.rasterize_glyph_with_variations_json(fontBytes, request.font.faceIndex, request.axesKey, glyph.glyphId, request.pixelSize)));
      }
    }
    const glyphs = projectGpuTextGlyphs({
      nodeId,
      fontAssetId: request.font.assetId,
      faceIndex: request.font.faceIndex,
      variationAxesKey: request.axesKey,
      fontSize: request.fontSize,
      pixelSize: request.pixelSize,
      x: request.nodeX,
      y: request.nodeY,
      rotation: request.nodeRotation,
      fill: request.nodeFill,
      opacity: request.nodeOpacity,
      lineHeight: request.nodeLineHeight ?? DEFAULT_TEXT_LINE_HEIGHT,
      layout: request.layout,
      rasters,
    });
    if (!glyphs) throw new Error("INVALID_GPU_TEXT_PROJECTION");
    const currentNode = nodes.find((node) => node.id === nodeId);
    if (!currentNode || rustGpuTextRequest(currentNode)?.key !== request.key) return;
    rustGpuTextGlyphs.set(nodeId, { revision, key: request.key, glyphs });
    render();
  } catch {
    diagnostics.record({ category: "renderer", code: "RUST_TEXT_GLYPH_RASTER_UNAVAILABLE", documentRevision: revision });
  } finally {
    rustGpuTextLoads.delete(request.key);
  }
}

function rustTextLayoutFor(node: CanvasNode): RustTextLayout | undefined {
  const cached = rustTextLayouts.get(node.id);
  return cached?.revision === revision ? cached.layout : undefined;
}

function imageDecodeBudget(assetId: string) {
  const visibleAssetIds = new Set(activeNodes()
    .filter((node) => node.visible !== false && node.kind !== "text" && Boolean(node.assetId))
    .map((node) => node.assetId!));
  // Dividing the global cache budget ensures every simultaneously visible
  // background can stay resident instead of repeatedly evicting one another.
  const assetCount = Math.max(1, visibleAssetIds.has(assetId) ? visibleAssetIds.size : 1);
  return Math.max(4, Math.floor(MAX_RASTER_DECODED_BYTES / assetCount));
}

function cacheImageBitmap(assetId: string, bitmap: ImageBitmap) {
  imageBitmaps.set(assetId, bitmap, bitmap.width * bitmap.height * 4);
  render();
}

/** Image bytes are decoded by the short-lived isolation Worker. The editor
 * Worker retains only the bounded ImageBitmap used for rendering. */
async function decodeImageBitmap(asset: DocumentAsset, blob: Blob): Promise<ImageBitmap> {
  const width = asset.pixelWidth;
  const height = asset.pixelHeight;
  if (!width || !height) throw new Error("MISSING_RASTER_DIMENSIONS");
  const decoded = await decodeRasterInWorker(asset.mediaType, new Uint8Array(await blob.arrayBuffer()), { width, height }, { maxDecodedBytes: imageDecodeBudget(asset.assetId) });
  return decoded.bitmap;
}

async function ensureImageBitmap(assetId: string) {
  if (imageBitmaps.has(assetId) || imageLoads.has(assetId) || !documentId) return;
  imageLoads.add(assetId);
  try {
    const asset = assets.find((candidate) => candidate.assetId === assetId);
    if (!asset) return;
    const blob = await loadAssetBlob(asset);
    if (!blob) return;
    cacheImageBitmap(assetId, await decodeImageBitmap(asset, blob));
  } catch {
    // Rendering keeps the documented placeholder; network failure never changes Core.
  } finally { imageLoads.delete(assetId); }
}

async function loadAssetBlob(asset: DocumentAsset): Promise<Blob | undefined> {
  const cached = await readCachedAsset(asset);
  if (cached) return cached;
  if (!documentId) return undefined;
  const headers = { "content-type": "application/json", "x-makefigma-dev-tenant-id": "00000000-0000-0000-0000-000000000002", "x-makefigma-dev-actor-id": localDevActorId };
  const grant = await fetch(`${assetApiUrl}/v1/documents/${encodeURIComponent(documentId)}/assets/${encodeURIComponent(asset.assetId)}/download-grants`, { method: "POST", headers, body: JSON.stringify({ lifetimeSeconds: 300 }) });
  if (!grant.ok) return undefined;
  const { token } = await grant.json() as { token: string };
  const download = await fetch(`${assetApiUrl}/v1/assets/downloads/${encodeURIComponent(token)}`, { headers: { "x-makefigma-dev-tenant-id": headers["x-makefigma-dev-tenant-id"], "x-makefigma-dev-actor-id": localDevActorId } });
  if (!download.ok) return undefined;
  const blob = await download.blob();
  void cacheAsset(asset, blob);
  return blob;
}

async function ensureFontFace(assetId: string) {
  const status = fontFaces.statusFor(assetId);
  if (status === "ready" || status === "loading") return;
  const asset = assets.find((candidate) => candidate.assetId === assetId);
  if (!asset || !asset.mediaType.startsWith("font/")) return;
  const blob = await loadAssetBlob(asset);
  if (!blob) {
    diagnostics.record({ category: "renderer", code: "FONT_ASSET_UNAVAILABLE", details: { assetId } });
    return;
  }
  const fontScope = self as unknown as { fonts?: { add(face: { load(): Promise<unknown> }): void } };
  const create = typeof FontFace === "function"
    ? (family: string, source: ArrayBuffer) => new FontFace(family, source)
    : undefined;
  const family = await fontFaces.load(assetId, await blob.arrayBuffer(), fontScope.fonts, create);
  if (family) { refreshRustTextLayouts(); render(); }
  else diagnostics.record({ category: "renderer", code: "FONT_FACE_UNAVAILABLE", details: { assetId } });
  emitSnapshot(undefined, false);
}

function seedAssetBytes(assetId: string, mediaType: string, bytes: ArrayBuffer, decodedBitmap?: ImageBitmap) {
  const blob = new Blob([bytes], { type: mediaType });
  const asset = assets.find((candidate) => candidate.assetId === assetId);
  if (asset) void cacheAsset(asset, blob);
  if (mediaType.startsWith("font/")) {
    void ensureFontFaceFromBlob(assetId, blob);
  } else {
    const imageAsset = asset;
    if (!imageAsset) return;
    if (decodedBitmap) {
      cacheImageBitmap(assetId, decodedBitmap);
      return;
    }
    void decodeImageBitmap(imageAsset, blob)
      .then((bitmap) => cacheImageBitmap(assetId, bitmap))
      .catch(() => {
        diagnostics.record({ category: "renderer", code: "IMAGE_ASSET_DECODE_FAILED", details: { assetId } });
        emitSnapshot(undefined, false);
      });
  }
}

async function ensureFontFaceFromBlob(assetId: string, blob: Blob) {
  const fontScope = self as unknown as { fonts?: { add(face: { load(): Promise<unknown> }): void } };
  const create = typeof FontFace === "function"
    ? (family: string, source: ArrayBuffer) => new FontFace(family, source)
    : undefined;
  const family = await fontFaces.load(assetId, await blob.arrayBuffer(), fontScope.fonts, create);
  if (family) { refreshRustTextLayouts(); render(); }
  else diagnostics.record({ category: "renderer", code: "FONT_FACE_UNAVAILABLE", details: { assetId } });
  emitSnapshot(undefined, false);
}
function registerAsset(transactionId: string, asset: DocumentAsset) {
  if (!wasmDocument) { emitError(undefined, "TRANSIENT", transactionId); return; }
  const baseRevision = Number(wasmDocument.revision);
  try {
    wasmDocument.register_asset(transactionId, wasmDocument.revision, asset.assetId, asset.contentHash, asset.mediaType, BigInt(asset.byteLength), asset.pixelWidth ?? 0, asset.pixelHeight ?? 0);
    recordHistory("core");
    syncProjectionFromWasm(false);
    render();
    emitSnapshot(journalEntry({ type: "restore-core", coreSnapshot: wasmDocument.snapshot_json() }, baseRevision, transactionId));
    queueRemotePayload(transactionId, baseRevision, encodeRegisterResourcePayload(asset), wasmDocument.canonical_hash(), { kind: "register-resource", asset: structuredClone(asset) });
  } catch (error) { emitError(error, "INVALID_COMMAND", transactionId); }
}
type JournalReplayEngine = Pick<WasmDocumentEngine, "revision" | "snapshot_json" | "apply_transaction_json" | "move_nodes" | "load_snapshot_json">;

function replayJournalEntry(engine: JournalReplayEngine, entry: LocalJournalEntry) {
  if (entry.acceptedRevision <= Number(engine.revision)) return;
  try {
    if (entry.baseRevision !== Number(engine.revision)) throw new Error("JOURNAL_REVISION_CONFLICT");
    const operation = entry.operation;
    if (operation.type === "create" || operation.type === "update" || operation.type === "reposition" || operation.type === "reparent" || operation.type === "group" || operation.type === "ungroup" || operation.type === "delete") {
      const currentNodes = (JSON.parse(engine.snapshot_json()) as WasmProjectionSnapshot).nodes.map(canvasNodeFromProjection);
      const resolved = resolveCoreBatch(currentNodes, [operation]);
      if (!resolved) throw new Error("INVALID_JOURNAL_OPERATION");
      engine.apply_transaction_json(entry.id, engine.revision, JSON.stringify(resolved.batch));
    } else if (operation.type === "move") engine.move_nodes(entry.id, engine.revision, JSON.stringify(operation.updates));
    else engine.load_snapshot_json(operation.coreSnapshot);
  } catch {
    // Every entry carries the accepted Core state, so a malformed old operation cannot
    // prevent recovery from progressing to the last durable local intent.
    engine.load_snapshot_json(entry.fallbackCoreSnapshot);
  }
}
async function loadDocumentBridge(localSnapshot?: CoreLocalSnapshot, benchmarkProjection = false) {
  const loadSequence = ++bridgeLoadSequence;
  renderPerformance.reset();
  try {
    // `hydrate` can arrive immediately after `init`. wasm-bindgen's default
    // initializer mutates module-global memory, so concurrent calls must share
    // one initialized runtime. Each bridge load still creates its own document.
    const wasm = await loadWasmRuntime();
    const runtime = await wasm.default();
    wasmMemory = runtime.memory;
    if (wasm.engine_semantics_version() !== 3) throw new Error("Unsupported WASM engine semantics");
    const engine = new wasm.DocumentEngine();
    if (localSnapshot) {
      engine.load_snapshot_json(localSnapshot.coreSnapshot);
      localSnapshot.journal?.sort((a, b) => a.acceptedRevision - b.acceptedRevision).forEach((entry) => replayJournalEntry(engine, entry));
      const storedSchemaVersion = (() => { try { return JSON.parse(localSnapshot.coreSnapshot).schemaVersion; } catch { return undefined; } })();
      if (typeof storedSchemaVersion === "number" && storedSchemaVersion < 9) {
        const presentation = localSnapshot.journal?.at(-1)?.presentation ?? localSnapshot.presentation;
        const current = engine.snapshot_json();
        const migrated = migrateLegacyCoreRotationSnapshot(current, presentation as Array<PresentationNode & { rotation?: unknown; stroke?: unknown; strokeWidth?: unknown }>, true);
        if (migrated !== current) engine.load_snapshot_json(migrated);
      }
    } else {
      for (const batchNodes of wasmHydrationBatches(nodes)) {
        const hydrated = resolveCoreBatch([], batchNodes.map((node) => ({ type: "create" as const, node })));
        if (!hydrated) throw new Error("INVALID_LEGACY_PROJECTION");
        engine.seed_batch_json(JSON.stringify(hydrated.batch));
      }
      // A workspace document gets its own Canonical identity before its first
      // local or remote snapshot is emitted. The seeded starter canvas remains
      // identical, but its operation history can never collide with another file.
      const seeded = JSON.parse(engine.snapshot_json()) as WasmProjectionSnapshot;
      if (seeded.documentId !== documentId) engine.load_snapshot_json(JSON.stringify({ ...seeded, documentId }));
    }
    if (loadSequence !== bridgeLoadSequence) return;
    wasmDocument = engine;
    ephemeralBenchmarkProjection = benchmarkProjection;
    history.length = 0;
    future = [];
    undoOrder.length = 0;
    redoOrder = [];
    if (localSnapshot) {
      const recovered = localSnapshot.journal?.at(-1);
      viewport = { ...(recovered?.viewport ?? localSnapshot.viewport) };
      preservedProjectionNodes.clear();
      (recovered?.presentation ?? localSnapshot.presentation).forEach((node) => preservedProjectionNodes.set(node.id, structuredClone(node)));
      syncProjectionFromWasm(false);
    } else if (benchmarkProjection) {
      // The generated projection has just been accepted by Core. Avoid building
      // an unnecessary second 100k-node Snapshot solely for benchmark display.
      revision = Number(engine.revision);
      refreshRustGpuScene();
    } else syncProjectionFromWasm();
    render();
    // Do not report Canvas/WASM hydration as editing latency. The next render is
    // triggered by steady-state user input, resize, or a confirmed UI action.
    renderPerformance.start();
    documentCore = "Rust/WASM bridge ready";
    diagnostics.record({ category: "lifecycle", code: "WASM_BRIDGE_READY", documentRevision: revision });
  } catch (error) {
    if (loadSequence !== bridgeLoadSequence) return;
    wasmDocument = undefined;
    if (localSnapshot) {
      // A local Core snapshot carries a hash precisely so that we never render a
      // semantically different document as if it had been validated. Recreate an
      // empty Rust document instead; the already-requested remote bootstrap then
      // restores the service-owned Protobuf snapshot through the same Core codec.
      diagnostics.record({ category: "recovery", code: "LOCAL_CORE_SNAPSHOT_REJECTED", details: { errorKind: localSnapshotFailureKind(error) } });
      void loadDocumentBridge(undefined, benchmarkProjection);
      return;
    }
    documentCore = "TypeScript document prototype";
    // Preserve the failure class for local diagnosis without retaining an error
    // message, document data, or stack trace in the durable diagnostic stream.
    const errorKind = error instanceof Error
      ? error.name
      : typeof error === "string" && /^(INVALID|UNSUPPORTED|CORRUPT)_[A-Z_]+$/.test(error)
        ? error
        : "UNKNOWN";
    diagnostics.record({ category: "recovery", code: "WASM_BRIDGE_FALLBACK", details: { errorKind } });
    renderPerformance.start();
  }
  emitSnapshot();
  if (remoteResetPending && wasmDocument && documentCore === "Rust/WASM bridge ready") {
    remoteResetPending = false;
    const snapshot = wasmDocument.snapshot_protobuf();
    self.postMessage({ type: "remote-reset", documentId, revision, snapshot } satisfies WorkerToMain, [snapshot.buffer]);
  }
  if (remoteBootstrapPending) emitRemoteBootstrap();
}

function localSnapshotFailureKind(error: unknown) {
  if (error instanceof Error) return error.name;
  return typeof error === "string" && /^(INVALID|UNSUPPORTED|CORRUPT)_[A-Z_]+$/.test(error)
    ? error
    : "UNKNOWN";
}
async function loadWasmRuntime(): Promise<typeof import("@/wasm/generated/editor_wasm")> {
  if (!wasmRuntimePromise) {
    wasmRuntimePromise = import("@/wasm/generated/editor_wasm").then(async (wasm) => {
      await wasm.default();
      wasmRuntime = wasm;
      return wasm;
    });
  }
  try {
    return await wasmRuntimePromise;
  } catch (error) {
    wasmRuntimePromise = undefined;
    wasmRuntime = undefined;
    throw error;
  }
}
function normalizeIds(snapshotNodes: CanvasNode[]) {
  return snapshotNodes.map((node) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(node.id) ? node : { ...node, id: crypto.randomUUID() });
}
function admitToWasm(command: EditorCommand) {
  if (!wasmDocument) return true;
  try {
    if (command.type === "create") {
      // Do not use the legacy narrow create bridge here: it derives a PositionId
      // from the node ID, while the operation sent to the service uses the
      // resolved page-layer key. Applying that exact Core Batch keeps the local
      // reducer and the service reducer byte-for-byte equivalent.
      const resolved = resolveCoreBatch(nodes, [command]);
      if (!resolved) throw new Error("INVALID_TRANSACTION");
      wasmDocument.apply_transaction_json(crypto.randomUUID(), wasmDocument.revision, JSON.stringify(resolved.batch));
    }
    if (command.type === "update") {
      const resolved = resolveCoreBatch(nodes, [command]);
      if (!resolved) throw new Error("INVALID_TRANSACTION");
      wasmDocument.apply_transaction_json(crypto.randomUUID(), wasmDocument.revision, JSON.stringify(resolved.batch));
    }
    if (command.type === "delete") {
      wasmDocument.delete_nodes(crypto.randomUUID(), wasmDocument.revision, command.ids.join(","));
    }
    if (command.type === "reposition") {
      wasmDocument.apply_transaction_json(crypto.randomUUID(), wasmDocument.revision, JSON.stringify([{ type: "reposition", positionIds: command.positionIds }]));
    }
    return true;
  } catch (error) {
    emitError(error);
    return false;
  }
}
function isWasmDocumentCommand(command: EditorCommand) {
  return Boolean(wasmDocument) && (command.type === "create" || command.type === "delete" || command.type === "reposition" || command.type === "update");
}
function recordHistory(kind: HistoryKind) {
  undoOrder.push(kind);
  redoOrder = [];
  future = [];
}
function resetDocumentToStarterNodes() {
  // Invalidate any in-flight hydration before publishing a new projection. The
  // transient snapshot deliberately carries no Core payload, so persistence can
  // retain the last confirmed document until the replacement Core is ready.
  bridgeLoadSequence += 1;
  remoteResetPending = true;
  wasmDocument = undefined;
  ephemeralBenchmarkProjection = false;
  rustGpuScene = undefined;
  rustTextLayouts.clear();
  documentCore = "Starting Rust/WASM bridge";
  const reset = resetDocumentProjection(starterNodes());
  nodes = reset.nodes;
  rebuildNodeIndex();
  selectedIds = reset.selectedIds;
  viewport = reset.viewport;
  history.length = 0;
  future = [];
  undoOrder.length = 0;
  redoOrder = [];
  revision = reset.revision;
  preservedProjectionNodes.clear();
  render();
  emitSnapshot(undefined, false);
  void loadDocumentBridge();
}
function commit(mutator: () => void, appliedByWasm = false, operation?: CoreJournalOperation, baseRevision?: number, advancesRevision = true, remoteCommand?: EditorCommand) {
  // Resolve against the exact projection observed before this local commit. The
  // WASM narrow bridge below may publish a newer projection, but remote payloads
  // must retain this operation's original base state and revision.
  const nodesBeforeCommit = appliedByWasm && remoteCommand ? structuredClone(nodes) : undefined;
  // A journal entry and its remote envelope describe the same user intent.
  // Keeping one ID across both stores gives the reconciler a durable join key
  // instead of trying to infer intent from a later Core snapshot.
  const remoteOperationId = appliedByWasm && remoteCommand ? crypto.randomUUID() : undefined;
  if (!appliedByWasm) {
    history.push({ nodes: cloneDocument(), advancesRevision });
    if (history.length > 100) {
      history.shift();
      const oldestLocalHistory = undoOrder.indexOf("local");
      if (oldestLocalHistory >= 0) undoOrder.splice(oldestLocalHistory, 1);
    }
  }
  mutator();
  recordHistory(appliedByWasm ? "core" : "local");
  if (appliedByWasm) syncProjectionFromWasm();
  else {
    rebuildNodeIndex();
    if (advancesRevision) revision += 1;
  }
  render();
  emitSnapshot(operation && baseRevision !== undefined ? journalEntry(operation, baseRevision, remoteOperationId) : undefined);
  if (appliedByWasm && remoteCommand && nodesBeforeCommit && wasmDocument && baseRevision !== undefined) {
    const resolved = resolveCoreBatch(nodesBeforeCommit, [remoteCommand]);
    if (resolved && remoteOperationId) queueRemoteOperation(remoteOperationId, baseRevision, resolved.batch, wasmDocument.canonical_hash());
    else emitError(undefined, "TRANSIENT");
  }
}
function toWorld(x: number, y: number) { return { x: (x - width / 2) / viewport.zoom - viewport.x, y: (y - height / 2) / viewport.zoom - viewport.y }; }
function toScreen(x: number, y: number) { return { x: (x + viewport.x) * viewport.zoom + width / 2, y: (y + viewport.y) * viewport.zoom + height / 2 }; }
function frameNameMetrics(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode) {
  ctx.save();
  ctx.font = canvasFont(canvasDesignTokens.typography.layerName);
  const width = ctx.measureText(node.name).width;
  ctx.restore();
  return { width, height: canvasDesignTokens.overlay.frameName.height };
}
function isFrameNameHit(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, screenX: number, screenY: number) {
  const metrics = frameNameMetrics(ctx, node);
  const affine = nativeAffineForNode(node);
  if (affine) {
    const inverse = invertAffine(affine);
    if (!inverse) return false;
    const local = transformPoint(inverse, toWorld(screenX, screenY));
    const baselineY = -canvasDesignTokens.overlay.frameName.offsetY / viewport.zoom;
    return local.x >= 0 && local.x <= metrics.width / viewport.zoom && local.y >= baselineY - metrics.height / viewport.zoom && local.y <= baselineY;
  }
  const point = toScreen(node.x, node.y);
  const width = node.width * viewport.zoom;
  const height = node.height * viewport.zoom;
  const deltaX = screenX - (point.x + width / 2);
  const deltaY = screenY - (point.y + height / 2);
  const radians = node.rotation * Math.PI / 180;
  const localX = Math.cos(radians) * deltaX + Math.sin(radians) * deltaY + width / 2;
  const localY = -Math.sin(radians) * deltaX + Math.cos(radians) * deltaY + height / 2;
  const baselineY = -canvasDesignTokens.overlay.frameName.offsetY;
  return localX >= 0 && localX <= metrics.width && localY >= baselineY - metrics.height && localY <= baselineY;
}
function hitFrameName(screenX: number, screenY: number) {
  if (!context) return undefined;
  return [...activeNodes()].reverse().find((node) => {
    if ((node.kind !== "frame" && node.kind !== "section") || node.visible === false || node.locked) return false;
    return isFrameNameHit(context!, node, screenX, screenY);
  });
}
function hit(worldX: number, worldY: number, drillDown = false) {
  const point = { x: worldX, y: worldY };
  const active = activeNodes();
  const nodesById = new Map(active.map((node) => [node.id, node]));
  const candidates = [...active].reverse().filter((candidate) => candidate.visible !== false && !isEffectivelyLocked(nodesById, candidate.id) && isInsideClippingFrames(candidate, point) && containsWorldPoint(candidate, point));
  // Groups are the normal selection boundary; a repeated press drills through
  // that boundary to the painted child below it.
  const paintedNode = candidates.find((candidate) => candidate.kind !== "group") ?? candidates[0];
  const node = paintedNode && resolveGroupSelectionTarget(active, paintedNode.id, drillDown, selectedIds);
  if (node) return node;
  const screen = toScreen(worldX, worldY);
  return hitFrameName(screen.x, screen.y);
}
function renderGrid(ctx: OffscreenCanvasRenderingContext2D) {
  if (!shouldRenderCanvasGrid(viewport.zoom)) return;
  const gap = resolveVisibleCanvasGridStep(viewport.zoom) * viewport.zoom;
  ctx.strokeStyle = canvasDesignTokens.color.grid;
  ctx.lineWidth = canvasDesignTokens.stroke.grid.width;
  const origin = toScreen(0, 0);
  const startX = ((origin.x % gap) + gap) % gap;
  const startY = ((origin.y % gap) + gap) % gap;
  ctx.beginPath();
  for (let x = startX; x < width; x += gap) { ctx.moveTo(Math.round(x) + .5, 0); ctx.lineTo(Math.round(x) + .5, height); }
  for (let y = startY; y < height; y += gap) { ctx.moveTo(0, Math.round(y) + .5); ctx.lineTo(width, Math.round(y) + .5); }
  ctx.stroke();
}
function paintStyle(ctx: OffscreenCanvasRenderingContext2D, fallback: string, gradient: CanvasNode["fillGradient"], width: number, height: number): string | CanvasGradient {
  if (!gradient) return fallback;
  const cssGradient = ctx.createLinearGradient(gradient.start[0] * width, gradient.start[1] * height, gradient.end[0] * width, gradient.end[1] * height);
  sampleLinearGradientForCanvas(gradient).forEach((stop) => cssGradient.addColorStop(stop.position, stop.color));
  return cssGradient;
}
function fillStyle(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, width: number, height: number) { return paintStyle(ctx, node.fill, node.fillGradient, width, height); }
function strokeStyle(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, width: number, height: number) { return paintStyle(ctx, node.stroke, node.strokeGradient, width, height); }
function paintStackStyle(ctx: OffscreenCanvasRenderingContext2D, paint: NonNullable<CanvasNode["fills"]>[number], width: number, height: number) { return paintStyle(ctx, paint.css, paint.gradient, width, height); }
function activeFills(node: CanvasNode): NonNullable<CanvasNode["fills"]> { return node.fills?.length ? node.fills : [{ css: node.fill, color: node.fillColor, gradient: node.fillGradient }]; }
function activeStrokes(node: CanvasNode): NonNullable<CanvasNode["strokes"]> { return node.strokes?.length ? node.strokes : [{ css: node.stroke, color: node.strokeColor, gradient: node.strokeGradient }]; }
function fillPaintStack(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, width: number, height: number) {
  activeFills(node).forEach((paint) => { ctx.fillStyle = paintStackStyle(ctx, paint, width, height); ctx.fill(); });
}
function strokePaintStack(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, width: number, height: number) {
  activeStrokes(node).forEach((paint) => { ctx.strokeStyle = paintStackStyle(ctx, paint, width, height); ctx.stroke(); });
}
function fillCanonicalStrokeMesh(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, mesh: StrokeMesh, width: number, height: number) {
  ctx.beginPath();
  mesh.forEach(([a, b, c]) => {
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.closePath();
  });
  // Fill the complete path once per layer. The Core mesh deliberately overlaps
  // join/cap triangles, and one non-zero fill preserves its union without
  // darkening translucent paint at those overlaps.
  activeStrokes(node).forEach((paint) => {
    ctx.fillStyle = paintStackStyle(ctx, paint, width, height);
    ctx.fill();
  });
}
function canvasStrokeCap(cap: CanvasNode["strokeCapStart"]): "butt" | "round" | "square" | undefined {
  if (!cap || cap === "none") return "butt";
  if (cap === "round" || cap === "square") return cap;
  return undefined;
}
function meshPoint(value: unknown): StrokeMeshPoint | undefined {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))) return undefined;
  return { x: value[0], y: value[1] };
}
function canonicalLineStrokeMesh(node: CanvasNode): StrokeMesh | undefined {
  const startCap = canvasStrokeCap(node.strokeCapStart);
  const endCap = canvasStrokeCap(node.strokeCapEnd);
  if (!wasmRuntime || !startCap || startCap !== endCap || node.strokeWidth <= 0) return undefined;
  const width = Math.max(0, node.width * viewport.zoom);
  const strokeWidth = node.strokeWidth * viewport.zoom;
  const dash = node.strokeDashPattern?.map((segment) => segment * viewport.zoom) ?? [];
  const key = `${node.id}:${width}:${strokeWidth}:${startCap}:${node.strokeJoin ?? "miter"}:${node.strokeMiterLimit ?? 10}:${dash.join(",")}`;
  const cached = canonicalStrokeMeshes.get(key);
  if (cached !== undefined) return cached ?? undefined;
  try {
    const result: unknown = JSON.parse(dash.length
      ? wasmRuntime.stroke_mesh_for_dashed_line_json(
        width, strokeWidth, JSON.stringify(dash), startCap, node.strokeJoin ?? "miter", node.strokeMiterLimit ?? 10,
      )
      : wasmRuntime.stroke_mesh_for_polyline_json(
        JSON.stringify([[0, 0], [width, 0]]),
        strokeWidth, startCap, node.strokeJoin ?? "miter", node.strokeMiterLimit ?? 10, false,
      ));
    const triangles = typeof result === "object" && result !== null && "triangles" in result
      ? (result as { triangles?: unknown }).triangles
      : undefined;
    const mesh = Array.isArray(triangles)
      ? triangles.map((triangle) => {
        if (!Array.isArray(triangle) || triangle.length !== 3) return undefined;
        const points = triangle.map(meshPoint);
        return points.every((point): point is StrokeMeshPoint => Boolean(point))
          ? [points[0], points[1], points[2]] as StrokeMeshTriangle
          : undefined;
      })
      : [];
    const resolved = mesh.length > 0 && mesh.every((triangle): triangle is StrokeMeshTriangle => Boolean(triangle)) ? mesh : null;
    if (canonicalStrokeMeshes.size >= 2_048) canonicalStrokeMeshes.clear();
    canonicalStrokeMeshes.set(key, resolved);
    return resolved ?? undefined;
  } catch {
    // Rendering must retain its Canvas fallback when a future WASM build has
    // an incompatible presentation boundary or is temporarily unavailable.
    return undefined;
  }
}
function canonicalRectangleStrokeMesh(node: CanvasNode, width: number, height: number): StrokeMesh | undefined {
  const resolvedRadii = resolveCornerRadii(node.width, node.height, node.radius, node.cornerRadii);
  const hasSquareCorners = resolvedRadii.every((radius) => radius === 0);
  const smoothing = resolveCornerSmoothing(node.cornerSmoothing);
  const align = node.strokeAlign ?? "inside";
  if (
    !wasmRuntime
    || node.strokeWidth <= 0
    || (align !== "inside" && align !== "center" && align !== "outside")
    || node.strokeWeights?.length
    || width <= 0
    || height <= 0
  ) return undefined;
  const strokeWidth = node.strokeWidth * viewport.zoom;
  const dash = node.strokeDashPattern?.map((segment) => segment * viewport.zoom) ?? [];
  // Mesh coordinates describe the centre line. Moving it inward/outward by
  // half the width produces the same painted boundary as Figma's Inside and
  // Outside alignments while leaving the Core tessellator untouched.
  const centerlineOffset = align === "inside" ? strokeWidth / 2 : align === "outside" ? -strokeWidth / 2 : 0;
  const meshWidth = width - centerlineOffset * 2;
  const meshHeight = height - centerlineOffset * 2;
  if (meshWidth <= 0 || meshHeight <= 0) return undefined;
  const meshRadii = resolvedRadii.map((radius) => Math.max(0, radius * viewport.zoom - centerlineOffset));
  const hasUniformRoundedCorners = !hasSquareCorners && meshRadii.every((radius) => Math.abs(radius - meshRadii[0]) <= 1e-9);
  const key = `${node.id}:rect:${align}:${width}:${height}:${strokeWidth}:${meshRadii.join(",")}:${smoothing}:${node.strokeJoin ?? "miter"}:${node.strokeMiterLimit ?? 10}:${dash.join(",")}`;
  const cached = canonicalStrokeMeshes.get(key);
  if (cached !== undefined) return cached ?? undefined;
  try {
    const result: unknown = JSON.parse(smoothing > 0
      ? wasmRuntime.stroke_mesh_for_continuous_rounded_rectangle_with_radii_json(
        meshWidth,
        meshHeight,
        JSON.stringify(meshRadii),
        smoothing,
        strokeWidth,
        JSON.stringify(dash),
        node.strokeJoin ?? "miter",
        node.strokeMiterLimit ?? 10,
      )
      : dash.length
        ? hasSquareCorners
        ? wasmRuntime.stroke_mesh_for_dashed_polyline_json(
          JSON.stringify([[0, 0], [meshWidth, 0], [meshWidth, meshHeight], [0, meshHeight]]),
          strokeWidth,
          JSON.stringify(dash),
          "butt",
          node.strokeJoin ?? "miter",
          node.strokeMiterLimit ?? 10,
          true,
        )
        : wasmRuntime.stroke_mesh_for_dashed_rounded_rectangle_with_radii_json(
          meshWidth,
          meshHeight,
          JSON.stringify(meshRadii),
          strokeWidth,
          JSON.stringify(dash),
          node.strokeJoin ?? "miter",
          node.strokeMiterLimit ?? 10,
        )
      : hasUniformRoundedCorners
        ? wasmRuntime.stroke_mesh_for_rounded_rectangle_json(
        meshWidth,
        meshHeight,
        meshRadii[0],
        strokeWidth,
        node.strokeJoin ?? "miter",
        node.strokeMiterLimit ?? 10,
      )
      : !hasSquareCorners
        ? wasmRuntime.stroke_mesh_for_rounded_rectangle_with_radii_json(
          meshWidth,
          meshHeight,
          JSON.stringify(meshRadii),
          strokeWidth,
          node.strokeJoin ?? "miter",
          node.strokeMiterLimit ?? 10,
        )
      : wasmRuntime.stroke_mesh_for_polyline_json(
        JSON.stringify([[0, 0], [meshWidth, 0], [meshWidth, meshHeight], [0, meshHeight]]),
        strokeWidth,
        "butt",
        node.strokeJoin ?? "miter",
        node.strokeMiterLimit ?? 10,
        true,
      ));
    const triangles = typeof result === "object" && result !== null && "triangles" in result
      ? (result as { triangles?: unknown }).triangles
      : undefined;
    const mesh = Array.isArray(triangles)
      ? triangles.map((triangle) => {
        if (!Array.isArray(triangle) || triangle.length !== 3) return undefined;
        const points = triangle.map(meshPoint);
        return points.every((point): point is StrokeMeshPoint => Boolean(point))
          ? [
            { x: points[0].x + centerlineOffset, y: points[0].y + centerlineOffset },
            { x: points[1].x + centerlineOffset, y: points[1].y + centerlineOffset },
            { x: points[2].x + centerlineOffset, y: points[2].y + centerlineOffset },
          ] as StrokeMeshTriangle
          : undefined;
      })
      : [];
    const resolved = mesh.length > 0 && mesh.every((triangle): triangle is StrokeMeshTriangle => Boolean(triangle)) ? mesh : null;
    if (canonicalStrokeMeshes.size >= 2_048) canonicalStrokeMeshes.clear();
    canonicalStrokeMeshes.set(key, resolved);
    return resolved ?? undefined;
  } catch {
    return undefined;
  }
}
/**
 * The per-side model is four independent butt-capped straight centerlines with
 * no corner joins (see `editor_core::geometry::stroke_meshes_for_per_side_rectangle`).
 * Keep that exact paint order and source each segment's finite outline from
 * Rust. Square-corner dashes keep the established independent-edge phase
 * (Top/Right/Bottom/Left each restart) and consume the same Core mesh.
 * Rounded/smoothed corners use this identical straight-edge mesh too — the
 * rounded contour is applied purely by the caller's Inside clip (the same
 * `roundedRectPath` clip the former Canvas fallback used), so no corner
 * geometry is duplicated and every consumer shares one centerline source.
 */
function canonicalPerSideRectangleStrokeMeshes(node: CanvasNode, width: number, height: number): readonly StrokeMesh[] | undefined {
  const weights = node.strokeWeights;
  const align = node.strokeAlign ?? "inside";
  if (
    !wasmRuntime
    || !weights
    || weights.length !== 4
    || width <= 0
    || height <= 0
  ) return undefined;
  const runtime = wasmRuntime;
  const scaledWeights = weights.map((weight) => Math.max(0, weight) * viewport.zoom) as [number, number, number, number];
  const dash = node.strokeDashPattern?.map((segment) => segment * viewport.zoom) ?? [];
  const key = `${node.id}:per-side-rect:${align}:${width}:${height}:${scaledWeights.join(",")}:${dash.join(",")}`;
  const cached = canonicalPerSideStrokeMeshes.get(key);
  if (cached !== undefined) return cached ?? undefined;
  try {
    const result: unknown = JSON.parse(dash.length
      ? runtime.stroke_meshes_for_per_side_rectangle_with_dash_json(width, height, JSON.stringify(scaledWeights), align, JSON.stringify(dash))
      : runtime.stroke_meshes_for_per_side_rectangle_json(width, height, JSON.stringify(scaledWeights), align));
    const rawMeshes = typeof result === "object" && result !== null && "meshes" in result
      ? (result as { meshes?: unknown }).meshes
      : undefined;
    const meshes = Array.isArray(rawMeshes) ? rawMeshes.flatMap((rawMesh) => {
      const triangles = typeof rawMesh === "object" && rawMesh !== null && "triangles" in rawMesh
        ? (rawMesh as { triangles?: unknown }).triangles
        : undefined;
      const mesh = Array.isArray(triangles) ? triangles.map((triangle) => {
          if (!Array.isArray(triangle) || triangle.length !== 3) return undefined;
          const points = triangle.map(meshPoint);
          return points.every((point): point is StrokeMeshPoint => Boolean(point))
            ? [points[0], points[1], points[2]] as StrokeMeshTriangle
            : undefined;
        }) : [];
      return mesh.length > 0 && mesh.every((triangle): triangle is StrokeMeshTriangle => Boolean(triangle)) ? [mesh] : [];
    }) : [];
    if (!meshes.length) {
      canonicalPerSideStrokeMeshes.set(key, null);
      return undefined;
    }
    if (canonicalPerSideStrokeMeshes.size >= 2_048) canonicalPerSideStrokeMeshes.clear();
    canonicalPerSideStrokeMeshes.set(key, meshes);
    return meshes;
  } catch {
    return undefined;
  }
}
function hasVisibleStroke(node: CanvasNode): boolean {
  if (node.opacity <= 0 || node.strokeWidth <= 0) return false;
  return activeStrokes(node).some((paint) => paint.gradient?.stops.some((stop) => stop.color.alpha > 0) ?? (paint.color ?? documentColorFromCssHex(paint.css))?.alpha !== 0);
}
function applyStrokeStyle(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode) {
  ctx.lineJoin = node.strokeJoin ?? "miter";
  ctx.miterLimit = node.strokeMiterLimit ?? 10;
  ctx.setLineDash((node.strokeDashPattern ?? []).map((segment) => segment * viewport.zoom));
}
function roundedRectPath(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number, cornerRadii?: CanvasNode["cornerRadii"], cornerSmoothing?: number) {
  const radii = resolveCornerRadii(width, height, radius, cornerRadii);
  const smoothing = resolveCornerSmoothing(cornerSmoothing);
  ctx.beginPath();
  if (smoothing === 0) { ctx.roundRect(x, y, width, height, radii); return; }
  const [topLeft, topRight, bottomRight, bottomLeft] = radii;
  const exponent = cornerSmoothingExponent(smoothing);
  const segmentCount = Math.round(8 + smoothing * 8);
  ctx.moveTo(x + topLeft, y);
  ctx.lineTo(x + width - topRight, y);
  continuousCorner(ctx, x + width - topRight, y + topRight, topRight, -Math.PI / 2, 0, exponent, segmentCount);
  ctx.lineTo(x + width, y + height - bottomRight);
  continuousCorner(ctx, x + width - bottomRight, y + height - bottomRight, bottomRight, 0, Math.PI / 2, exponent, segmentCount);
  ctx.lineTo(x + bottomLeft, y + height);
  continuousCorner(ctx, x + bottomLeft, y + height - bottomLeft, bottomLeft, Math.PI / 2, Math.PI, exponent, segmentCount);
  ctx.lineTo(x, y + topLeft);
  continuousCorner(ctx, x + topLeft, y + topLeft, topLeft, Math.PI, Math.PI * 1.5, exponent, segmentCount);
  ctx.closePath();
}
function continuousCorner(ctx: OffscreenCanvasRenderingContext2D, centerX: number, centerY: number, radius: number, start: number, end: number, exponent: number, segments: number) {
  if (radius <= 0) { ctx.lineTo(centerX, centerY); return; }
  for (let index = 1; index <= segments; index += 1) {
    const angle = start + (end - start) * index / segments;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    ctx.lineTo(centerX + Math.sign(cosine) * Math.abs(cosine) ** (2 / exponent) * radius, centerY + Math.sign(sine) * Math.abs(sine) ** (2 / exponent) * radius);
  }
}
function insetCornerRadii(width: number, height: number, radius: number, cornerRadii: CanvasNode["cornerRadii"], inset: number): CanvasNode["cornerRadii"] | undefined {
  return insetRoundedRectRadii(width, height, radius, cornerRadii, inset);
}
function outsetCornerRadii(width: number, height: number, radius: number, cornerRadii: CanvasNode["cornerRadii"], outset: number): CanvasNode["cornerRadii"] | undefined {
  return outsetRoundedRectRadii(width, height, radius, cornerRadii, outset);
}
function renderNode(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode) {
  if (node.visible === false) return;
  if (node.kind === "group") return;
  const point = toScreen(node.x, node.y);
  const w = node.width * viewport.zoom;
  const h = node.height * viewport.zoom;
  if (node.kind === "line") {
    ctx.save();
    ctx.globalAlpha = node.opacity;
    if (!applyNativeAffine(ctx, node)) {
      ctx.translate(point.x, point.y);
      ctx.rotate(node.rotation * Math.PI / 180);
    }
    applyStrokeStyle(ctx, node);
    const mesh = canonicalLineStrokeMesh(node);
    if (mesh) {
      fillCanonicalStrokeMesh(ctx, node, mesh, w, 1);
    } else {
      const strokeWidth = Math.max(1, node.strokeWidth * viewport.zoom);
      ctx.lineWidth = strokeWidth;
      // A solid Line can be filled as one union of primitives, which preserves
      // independent start/end Cap semantics without alpha-darkening overlap.
      if (!node.strokeDashPattern?.length) {
        const outline = solidLineStrokeOutline(w, strokeWidth, node.strokeCapStart, node.strokeCapEnd);
        activeStrokes(node).forEach((layer) => {
          ctx.beginPath();
          outline.forEach((piece) => {
            if (piece.kind === "rect") ctx.rect(piece.x, piece.y, piece.width, piece.height);
            else ctx.arc(piece.x, piece.y, piece.radius, 0, Math.PI * 2);
          });
          ctx.fillStyle = paintStackStyle(ctx, layer, w, 1);
          ctx.fill();
          ctx.strokeStyle = ctx.fillStyle;
          renderLineEndpoint(ctx, node.strokeCapStart, 0, -1, strokeWidth);
          renderLineEndpoint(ctx, node.strokeCapEnd, w, 1, strokeWidth);
        });
      } else {
        // Canvas has a single lineCap property. For a dashed Line with
        // asymmetric caps, Butt is the conservative fallback rather than
        // applying one endpoint's cap to every dash segment.
        ctx.lineCap = node.strokeCapStart === node.strokeCapEnd && (node.strokeCapStart === "round" || node.strokeCapStart === "square")
          ? node.strokeCapStart
          : "butt";
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(w, 0);
        strokePaintStack(ctx, node, w, 1);
        activeStrokes(node).forEach((layer) => {
          const style = paintStackStyle(ctx, layer, w, 1);
          ctx.strokeStyle = style;
          ctx.fillStyle = style;
          renderLineEndpoint(ctx, node.strokeCapStart, 0, -1, strokeWidth);
          renderLineEndpoint(ctx, node.strokeCapEnd, w, 1, strokeWidth);
        });
      }
    }
    ctx.restore();
    return;
  }
  ctx.save();
  ctx.globalAlpha = node.opacity;
  if (!applyNativeAffine(ctx, node)) {
    ctx.translate(point.x + w / 2, point.y + h / 2);
    ctx.rotate(node.rotation * Math.PI / 180);
    ctx.translate(-w / 2, -h / 2);
  }
  applyStrokeStyle(ctx, node);
  const paint = fillStyle(ctx, node, w, h);
  if (node.assetId) {
    const geometry = resolveInsideRoundedRect(w, h, node.radius * viewport.zoom, 0);
    const alignedEllipse = node.kind === "ellipse" && !node.arcData;
    const align = node.strokeAlign ?? "inside";
    const strokeWidth = node.strokeWidth * viewport.zoom;
    const ring = alignedEllipse && hasVisibleStroke(node) ? ellipseStrokeRing(w, h, strokeWidth, align) : undefined;
    const imageRectangleStrokeMesh = !alignedEllipse
      && (node.kind === "frame" || node.kind === "rectangle")
      && hasVisibleStroke(node)
      ? canonicalRectangleStrokeMesh(node, w, h)
      : undefined;
    // Outside paint must sit behind the original image geometry. This uses the
    // same filled-ring model as a non-image Ellipse instead of clipping a
    // conventional Canvas stroke to the image mask.
    if (alignedEllipse && align === "outside" && ring) {
      ctx.beginPath(); ctx.ellipse(w / 2, h / 2, ring.outerRx, ring.outerRy, 0, 0, Math.PI * 2);
      activeStrokes(node).forEach((layer) => { ctx.fillStyle = paintStackStyle(ctx, layer, w, h); ctx.fill(); });
    }
    ctx.save();
    if (node.kind === "ellipse") {
      ctx.beginPath(); ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    } else roundedRectPath(ctx, 0, 0, w, h, geometry.outerRadius, node.cornerRadii, node.cornerSmoothing);
    ctx.clip();
    const bitmap = imageBitmaps.get(node.assetId);
    if (bitmap) {
      const scale = Math.max(w / bitmap.width, h / bitmap.height);
      const drawWidth = bitmap.width * scale;
      const drawHeight = bitmap.height * scale;
      ctx.drawImage(bitmap, (w - drawWidth) / 2, (h - drawHeight) / 2, drawWidth, drawHeight);
    } else {
      ctx.fillStyle = paint;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "rgba(0, 72, 255, .16)";
      for (let offset = -h; offset < w; offset += 18) ctx.fillRect(offset, 0, 8, h);
    }
    // Rectangle/Frame image Stroke keeps its existing clipped projection. A
    // full Ellipse restores first because its aligned paint can extend past
    // the image mask.
    if (!alignedEllipse && hasVisibleStroke(node) && !imageRectangleStrokeMesh) {
      if (node.kind === "ellipse") {
        ctx.beginPath(); ctx.ellipse(w / 2, h / 2, Math.max(0, w - 1) / 2, Math.max(0, h - 1) / 2, 0, 0, Math.PI * 2);
      } else roundedRectPath(ctx, 0.5, 0.5, Math.max(0, w - 1), Math.max(0, h - 1), Math.max(0, geometry.outerRadius - .5), node.cornerRadii, node.cornerSmoothing);
      ctx.lineWidth = Math.max(1, strokeWidth);
      strokePaintStack(ctx, node, w, h);
    }
    ctx.restore();
    // The image clip must end before an Outside mesh is painted, otherwise
    // the portion that intentionally extends beyond the bitmap is lost. The
    // mesh itself is a ring, so Inside/Center remain correctly overlaid on
    // the image while Outside starts exactly at its geometry boundary.
    if (imageRectangleStrokeMesh) fillCanonicalStrokeMesh(ctx, node, imageRectangleStrokeMesh, w, h);
    if (alignedEllipse && hasVisibleStroke(node)) {
      if (align === "inside" && ring) {
        ctx.beginPath(); ctx.ellipse(w / 2, h / 2, ring.outerRx, ring.outerRy, 0, 0, Math.PI * 2);
        if (ring.innerRx !== undefined && ring.innerRy !== undefined) ctx.ellipse(w / 2, h / 2, ring.innerRx, ring.innerRy, 0, 0, Math.PI * 2);
        activeStrokes(node).forEach((layer) => { ctx.fillStyle = paintStackStyle(ctx, layer, w, h); ctx.fill("evenodd"); });
      } else if (alignedEllipse && align === "outside") {
        // Already painted behind the image mask above.
      } else {
        ctx.beginPath(); ctx.ellipse(w / 2, h / 2, Math.max(0, w - 1) / 2, Math.max(0, h - 1) / 2, 0, 0, Math.PI * 2);
        ctx.lineWidth = Math.max(1, strokeWidth);
        strokePaintStack(ctx, node, w, h);
      }
    }
  } else if (node.kind === "ellipse") {
    if (node.arcData) {
      renderEllipseArc(ctx, node, w, h);
      ctx.restore();
      return;
    }
    const geometry = resolveInsideRoundedRect(w, h, 0, node.strokeWidth * viewport.zoom);
    const align = node.strokeAlign ?? "inside";
    ctx.beginPath(); ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    if (hasVisibleStroke(node) && align === "outside") {
      const outset = node.strokeWidth * viewport.zoom;
      ctx.beginPath(); ctx.ellipse(w / 2, h / 2, w / 2 + outset, h / 2 + outset, 0, 0, Math.PI * 2);
      activeStrokes(node).forEach((layer) => { ctx.fillStyle = paintStackStyle(ctx, layer, w, h); ctx.fill(); });
      ctx.beginPath(); ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      fillPaintStack(ctx, node, w, h);
    } else if (hasVisibleStroke(node) && align === "center") {
      fillPaintStack(ctx, node, w, h);
      ctx.lineWidth = Math.max(1, node.strokeWidth * viewport.zoom);
      strokePaintStack(ctx, node, w, h);
    } else if (hasVisibleStroke(node) && geometry.insideStrokeWidth > 0) {
      activeStrokes(node).forEach((layer) => { ctx.fillStyle = paintStackStyle(ctx, layer, w, h); ctx.fill(); });
      if (geometry.innerWidth > 0 && geometry.innerHeight > 0) {
        ctx.beginPath(); ctx.ellipse(w / 2, h / 2, geometry.innerWidth / 2, geometry.innerHeight / 2, 0, 0, Math.PI * 2);
        fillPaintStack(ctx, node, w, h);
      }
    } else {
      fillPaintStack(ctx, node, w, h);
    }
  } else if (node.kind === "text") {
    const primaryStyle = node.textProperties?.runs[0];
    const baseMetrics = resolveTextRenderMetrics(node.width, node.height, viewport.zoom);
    const fontSize = (primaryStyle?.fontSize ?? 31) * viewport.zoom;
    const lineHeight = (node.textProperties?.paragraph.lineHeight ?? DEFAULT_TEXT_LINE_HEIGHT) * viewport.zoom;
    const textMetrics = { ...baseMetrics, fontSize, lineHeight };
    const source = node.text ?? "Text";
    const sourceBytes = new TextEncoder().encode(source);
    const primaryRenderStyle: RenderTextStyle = primaryStyle ? {
      font: primaryStyle.font,
      fontSize: primaryStyle.fontSize,
      fontWeight: primaryStyle.fontWeight,
      italic: primaryStyle.italic,
      letterSpacing: primaryStyle.letterSpacing,
    } : { fontSize: 31, fontWeight: canvasDesignTokens.typography.canvasText.weight, italic: false, letterSpacing: 0 };
    ctx.fillStyle = paint;
    applyCanvasTextStyle(ctx, primaryRenderStyle);
    // CSS line boxes center the font's bounding ascent/descent inside the
    // declared line-height. Canvas' `middle` baseline uses a different em-box
    // convention, which was visibly a few pixels above the textarea glyphs.
    // Draw against an explicit alphabetic baseline instead.
    ctx.textBaseline = "alphabetic";
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, textMetrics.width, textMetrics.height); ctx.clip();
    let lineY = 0;
    let previousEnd = 0;
    const shapedLayout = rustTextLayoutFor(node);
    const lines = shapedLayout
      ? shapedLayout.lines.map((line) => ({ ...line, text: new TextDecoder().decode(sourceBytes.slice(line.start, line.end)) }))
      : layoutTextRanges({ text: source, maxWidth: Math.max(1, textMetrics.width), measure: (value) => ctx.measureText(value).width });
    lines.forEach((line) => {
      const skipped = new TextDecoder().decode(sourceBytes.slice(previousEnd, line.start));
      if (/\r\n|[\n\r\u2028\u2029]/u.test(skipped)) lineY += (node.textProperties?.paragraph.paragraphSpacing ?? 0) * viewport.zoom;
      const spans = styledTextSpans(source, line.start, line.end, node.textProperties);
      const lineHeight = (node.textProperties?.paragraph.lineHeight ?? DEFAULT_TEXT_LINE_HEIGHT) * viewport.zoom;
      if (lineY < textMetrics.height) {
        // A CSS line has one shared alphabetic baseline. Measuring each style
        // run separately made a larger CJK/emoji run jump a few pixels from
        // the Latin run when the DOM editor opened.
        applyCanvasTextStyle(ctx, primaryRenderStyle);
        const lineBaseline = cssLineBoxBaseline(ctx, lineY, lineHeight);
        ctx.direction = line.direction;
        const alignment = node.textProperties?.paragraph.alignment ?? "left";
        if (line.direction === "rtl" || spans.length <= 1) {
          const style = spans[0]?.style ?? primaryRenderStyle;
          applyCanvasTextStyle(ctx, style);
          ctx.textAlign = alignment === "center" ? "center" : alignment === "right" || line.direction === "rtl" ? "right" : "left";
          const x = alignment === "center" ? textMetrics.width / 2 : alignment === "right" || line.direction === "rtl" ? textMetrics.width : 0;
          ctx.fillText(line.text, x, lineBaseline);
        } else {
          ctx.direction = "ltr";
          ctx.textAlign = "left";
          const measured = spans.map((span) => {
            applyCanvasTextStyle(ctx, span.style);
            return ctx.measureText(span.text).width;
          });
          const lineWidth = measured.reduce((sum, width) => sum + width, 0);
          let x = alignment === "center" ? (textMetrics.width - lineWidth) / 2 : alignment === "right" ? textMetrics.width - lineWidth : 0;
          spans.forEach((span, index) => {
            applyCanvasTextStyle(ctx, span.style);
            ctx.fillText(span.text, x, lineBaseline);
            x += measured[index];
          });
        }
      }
      lineY += lineHeight;
      previousEnd = line.end;
    });
    ctx.restore();
  } else {
    const geometry = resolveInsideRoundedRect(w, h, node.radius * viewport.zoom, node.strokeWidth * viewport.zoom);
    if (hasVisibleStroke(node) && node.strokeWeights?.length === 4 && (node.kind === "frame" || node.kind === "rectangle")) {
      roundedRectPath(ctx, 0, 0, w, h, geometry.outerRadius, node.cornerRadii, node.cornerSmoothing);
      fillPaintStack(ctx, node, w, h);
      const meshes = canonicalPerSideRectangleStrokeMeshes(node, w, h);
      if (meshes) {
        const align = node.strokeAlign ?? "inside";
        if (align === "inside") {
          ctx.save();
          roundedRectPath(ctx, 0, 0, w, h, geometry.outerRadius, node.cornerRadii, node.cornerSmoothing);
          ctx.clip();
          meshes.forEach((mesh) => fillCanonicalStrokeMesh(ctx, node, mesh, w, h));
          ctx.restore();
        } else meshes.forEach((mesh) => fillCanonicalStrokeMesh(ctx, node, mesh, w, h));
      } else renderPerSideStroke(ctx, node, w, h, geometry.outerRadius);
    } else if (hasVisibleStroke(node) && (node.kind === "frame" || node.kind === "rectangle")) {
      const mesh = canonicalRectangleStrokeMesh(node, w, h);
      if (mesh) {
        roundedRectPath(ctx, 0, 0, w, h, geometry.outerRadius, node.cornerRadii, node.cornerSmoothing);
        fillPaintStack(ctx, node, w, h);
        fillCanonicalStrokeMesh(ctx, node, mesh, w, h);
      } else if ((node.strokeAlign ?? "inside") !== "inside") {
        renderAlignedShapeStroke(ctx, node, w, h, geometry.outerRadius);
      } else if (geometry.insideStrokeWidth > 0) {
        roundedRectPath(ctx, 0, 0, w, h, geometry.outerRadius, node.cornerRadii, node.cornerSmoothing);
        activeStrokes(node).forEach((layer) => { ctx.fillStyle = paintStackStyle(ctx, layer, w, h); ctx.fill(); });
        if (geometry.innerWidth > 0 && geometry.innerHeight > 0) {
          roundedRectPath(ctx, geometry.innerX, geometry.innerY, geometry.innerWidth, geometry.innerHeight, geometry.innerRadius, insetCornerRadii(w, h, geometry.outerRadius, node.cornerRadii, geometry.insideStrokeWidth), node.cornerSmoothing);
          fillPaintStack(ctx, node, w, h);
        }
      }
    } else if (hasVisibleStroke(node) && geometry.insideStrokeWidth > 0) {
      roundedRectPath(ctx, 0, 0, w, h, geometry.outerRadius, node.cornerRadii, node.cornerSmoothing);
      activeStrokes(node).forEach((layer) => { ctx.fillStyle = paintStackStyle(ctx, layer, w, h); ctx.fill(); });
      if (geometry.innerWidth > 0 && geometry.innerHeight > 0) {
        roundedRectPath(ctx, geometry.innerX, geometry.innerY, geometry.innerWidth, geometry.innerHeight, geometry.innerRadius, insetCornerRadii(w, h, geometry.outerRadius, node.cornerRadii, geometry.insideStrokeWidth), node.cornerSmoothing);
        fillPaintStack(ctx, node, w, h);
      }
    } else {
      roundedRectPath(ctx, 0, 0, w, h, geometry.outerRadius, node.cornerRadii, node.cornerSmoothing);
      fillPaintStack(ctx, node, w, h);
    }
  }
  ctx.restore();
}

/** Paint in structural order whenever a Frame owns visible descendants. A
 * single flat Canvas loop cannot retain a Frame's clip while drawing later
 * child layers. The renderer deliberately falls back from the GPU prefix for
 * this page shape; that preserves both clip and document z-order. */
function renderFrameClippedTree(ctx: OffscreenCanvasRenderingContext2D, orderedNodes: readonly CanvasNode[]) {
  const ids = new Set(orderedNodes.map((node) => node.id));
  const children = new Map<string, CanvasNode[]>();
  const roots: CanvasNode[] = [];
  orderedNodes.forEach((node) => {
    if (!node.parentId || !ids.has(node.parentId)) roots.push(node);
    else {
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node);
      children.set(node.parentId, siblings);
    }
  });
  const renderBranch = (node: CanvasNode) => {
    renderNode(ctx, node);
    const descendants = children.get(node.id) ?? [];
    if (!descendants.length) return;
    if (node.kind === "frame" && node.clipsContent !== false) {
      clipFrameContents(ctx, node);
      descendants.forEach(renderBranch);
      ctx.restore();
      return;
    }
    descendants.forEach(renderBranch);
  };
  roots.forEach(renderBranch);
}

function clipFrameContents(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode) {
  const point = toScreen(node.x, node.y);
  const frameWidth = node.width * viewport.zoom;
  const frameHeight = node.height * viewport.zoom;
  ctx.save();
  if (!applyNativeAffine(ctx, node)) {
    ctx.translate(point.x + frameWidth / 2, point.y + frameHeight / 2);
    ctx.rotate(node.rotation * Math.PI / 180);
    ctx.translate(-frameWidth / 2, -frameHeight / 2);
  }
  roundedRectPath(ctx, 0, 0, frameWidth, frameHeight, Math.max(0, node.radius * viewport.zoom), node.cornerRadii, node.cornerSmoothing);
  ctx.clip();
  // `clip()` stores the region in device space, but the current transform is
  // still the Frame transform. Descendants are rendered with their own world
  // matrices, so leaving it active would apply the Frame matrix twice and make
  // nested content diverge from its hit/selection bounds. Keep the clip while
  // returning to the normal screen-space basis for the child render pass.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function renderEllipseArc(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, width: number, height: number) {
  const arc = node.arcData;
  if (!arc) return;
  const start = arc.startingAngle * Math.PI / 180;
  const end = arc.endingAngle * Math.PI / 180;
  const outerX = width / 2;
  const outerY = height / 2;
  const innerRadius = Math.max(0, Math.min(.999999, arc.innerRadius));
  ctx.beginPath();
  ctx.ellipse(outerX, outerY, outerX, outerY, 0, start, end);
  if (innerRadius > 0) {
    ctx.ellipse(outerX, outerY, outerX * innerRadius, outerY * innerRadius, 0, end, start, true);
  } else {
    ctx.lineTo(outerX, outerY);
  }
  ctx.closePath();
  activeFills(node).forEach((layer) => { ctx.fillStyle = paintStackStyle(ctx, layer, width, height); ctx.fill("evenodd"); });
  if (hasVisibleStroke(node)) {
    ctx.lineWidth = Math.max(1, node.strokeWidth * viewport.zoom);
    applyStrokeStyle(ctx, node);
    strokePaintStack(ctx, node, width, height);
  }
}

/** First per-side Stroke projection. The outer rounded path clips each edge,
 * which keeps the weights inside the shape while preserving rotation, dash and
 * paint semantics. Corner joins/align are upgraded by the shared outline path
 * work; no second persistence model is introduced here. */
function renderPerSideStroke(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, width: number, height: number, radius: number) {
  const weights = node.strokeWeights;
  if (!weights || weights.length !== 4) return;
  const align = node.strokeAlign ?? "inside";
  ctx.save();
  if (align === "inside") { roundedRectPath(ctx, 0, 0, width, height, radius, node.cornerRadii, node.cornerSmoothing); ctx.clip(); }
  applyStrokeStyle(ctx, node);
  const [top, right, bottom, left] = weights.map((weight) => Math.max(0, weight) * viewport.zoom);
  const draw = (lineWidth: number, from: [number, number], to: [number, number]) => {
    if (lineWidth <= 0) return;
    ctx.lineWidth = Math.max(1, lineWidth);
    ctx.beginPath();
    ctx.moveTo(...from);
    ctx.lineTo(...to);
    strokePaintStack(ctx, node, width, height);
  };
  const { topY, rightX, bottomY, leftX } = perSideStrokeCenters(width, height, [top, right, bottom, left], align);
  draw(top, [0, topY], [width, topY]);
  draw(right, [rightX, 0], [rightX, height]);
  draw(bottom, [width, bottomY], [0, bottomY]);
  draw(left, [leftX, height], [leftX, 0]);
  ctx.restore();
}

function renderAlignedShapeStroke(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, width: number, height: number, radius: number) {
  const strokeWidth = Math.max(1, node.strokeWidth * viewport.zoom);
  const align = node.strokeAlign ?? "inside";
  if (align === "outside") {
    roundedRectPath(ctx, -strokeWidth, -strokeWidth, width + strokeWidth * 2, height + strokeWidth * 2, radius + strokeWidth, outsetCornerRadii(width, height, radius, node.cornerRadii, strokeWidth), node.cornerSmoothing);
    activeStrokes(node).forEach((layer) => { ctx.fillStyle = paintStackStyle(ctx, layer, width, height); ctx.fill(); });
    roundedRectPath(ctx, 0, 0, width, height, radius, node.cornerRadii, node.cornerSmoothing);
    fillPaintStack(ctx, node, width, height);
    return;
  }
  roundedRectPath(ctx, 0, 0, width, height, radius, node.cornerRadii, node.cornerSmoothing);
  fillPaintStack(ctx, node, width, height);
  ctx.lineWidth = strokeWidth;
  applyStrokeStyle(ctx, node);
  strokePaintStack(ctx, node, width, height);
}

function renderLineEndpoint(ctx: OffscreenCanvasRenderingContext2D, cap: CanvasNode["strokeCapStart"], x: number, direction: -1 | 1, strokeWidth: number) {
  if (!isDecorativeCap(cap)) return;
  // Canvas, hit test and SVG all consume this one mesh from the shared
  // `decorative-cap-mesh` source, so the arrowhead/diamond/dot can never drift
  // between what is drawn, what is hit and what is exported.
  const mesh = decorativeCapMesh(cap, x, direction, strokeWidth);
  ctx.beginPath();
  mesh.triangles.forEach(([a, b, c]) => {
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.closePath();
  });
  ctx.fill();
}

function applyCanvasTextStyle(ctx: OffscreenCanvasRenderingContext2D, style: RenderTextStyle) {
  const fontFamily = style.font ? fontFaces.familyFor(style.font.assetId) : undefined;
  ctx.font = `${style.italic ? "italic " : ""}${style.fontWeight} ${style.fontSize * viewport.zoom}px ${fontFamily ? `"${fontFamily}", ` : ""}${canvasDesignTokens.typography.canvasText.family}`;
  const letterSpacingTarget = ctx as unknown as { letterSpacing?: string };
  if ("letterSpacing" in letterSpacingTarget) letterSpacingTarget.letterSpacing = `${style.letterSpacing * viewport.zoom}px`;
}

/** Matches the browser's inline line-box rule: center the selected font's
 * bounding box in the line-height, then place its alphabetic baseline. */
function cssLineBoxBaseline(ctx: OffscreenCanvasRenderingContext2D, lineTop: number, lineHeight: number): number {
  const metrics = ctx.measureText("Mg");
  const fallbackSize = Number.parseFloat(ctx.font.match(/(\d+(?:\.\d+)?)px/u)?.[1] ?? "16");
  return resolveCssLineBoxBaseline(lineTop, lineHeight, metrics, fallbackSize);
}

/** Resolves Figma-style auto sizing in document coordinates before the Core
 * transaction is built. The geometry and text update therefore share one
 * revision and undo entry instead of leaving a DOM-only measurement behind. */
function withResolvedTextAutoSize(command: EditorCommand): EditorCommand {
  if (command.type !== "update" || !context) return command;
  const ctx = context;
  const previous = nodes.find((node) => node.id === command.id);
  if (!previous || previous.kind !== "text") return command;
  const node = { ...previous, ...command.patch };
  const properties = node.textProperties;
  if (!properties || properties.autoSize === "fixed") return command;

  const primary = properties.runs[0];
  const primaryStyle: RenderTextStyle = primary ? {
    font: primary.font,
    fontSize: primary.fontSize,
    fontWeight: primary.fontWeight,
    italic: primary.italic,
    letterSpacing: primary.letterSpacing,
  } : { fontSize: 31, fontWeight: canvasDesignTokens.typography.canvasText.weight, italic: false, letterSpacing: 0 };
  const source = node.text ?? "";
  const sourceBytes = new TextEncoder().encode(source);
  applyCanvasTextStyle(ctx, primaryStyle);
  const maxWidth = properties.autoSize === "widthAndHeight" ? Number.POSITIVE_INFINITY : Math.max(1, node.width * viewport.zoom);
  const lines = layoutTextRanges({ text: source, maxWidth, measure: (value) => ctx.measureText(value).width });
  let height = 0;
  let widest = 1;
  let previousEnd = 0;
  lines.forEach((line) => {
    const skipped = new TextDecoder().decode(sourceBytes.slice(previousEnd, line.start));
    if (/\r\n|[\n\r\u2028\u2029]/u.test(skipped)) height += (properties.paragraph.paragraphSpacing ?? 0) * viewport.zoom;
    const spans = styledTextSpans(source, line.start, line.end, properties);
    const lineHeight = (properties.paragraph.lineHeight ?? DEFAULT_TEXT_LINE_HEIGHT) * viewport.zoom;
    height += lineHeight;
    if (spans.length <= 1) {
      applyCanvasTextStyle(ctx, spans[0]?.style ?? primaryStyle);
      widest = Math.max(widest, ctx.measureText(line.text).width);
    } else {
      const measured = spans.reduce((total, span) => {
        applyCanvasTextStyle(ctx, span.style);
        return total + ctx.measureText(span.text).width;
      }, 0);
      widest = Math.max(widest, measured);
    }
    previousEnd = line.end;
  });
  const patch: Partial<CanvasNode> = {
    ...command.patch,
    height: Math.max(1, height / viewport.zoom),
    ...(properties.autoSize === "widthAndHeight" ? { width: Math.max(1, widest / viewport.zoom) } : {}),
  };
  return { ...command, patch };
}

/** Resolves the paste destination: the selected container when a single
 * Frame/Group/Section is selected, otherwise the selected node's parent, else
 * the active page root. Cross-parent or empty selections fall back to the page
 * root so paste always has a valid target. */
function pasteTarget(): { pageId?: string; parentId?: string } {
  const selected = selectedIds.map((id) => nodeById.get(id)).filter((node): node is CanvasNode => Boolean(node));
  if (selected.length === 1) {
    const node = selected[0];
    if (["frame", "group", "section"].includes(node.kind)) return { pageId: node.pageId ?? activePageId, parentId: node.id };
    return { pageId: node.pageId ?? activePageId, parentId: node.parentId };
  }
  return { pageId: activePageId, parentId: undefined };
}

/** New page-root layers behave like Figma: they enter above the current stack.
 * Existing explicit keys are retained for snapshots, imports and remote replay. */
function withResolvedLayerPosition(command: EditorCommand): EditorCommand {
  if (command.type !== "create" || command.node.positionId) return command;
  const pageId = command.node.pageId ?? activePageId;
  const siblings = nodes.filter((node) => (node.pageId ?? defaultPageId) === pageId);
  return { ...command, node: { ...command.node, pageId, positionId: orderNewLayerAtFront(siblings, command.node.id) } };
}
/** Resize eligibility is determined from the Canonical record, never its
 * display projection. Both Legacy and Relative-v1 nodes are supported; Group
 * bounds remain derived and Line owns a dedicated endpoint interaction. */
function canResizeOnCanvas(node: CanvasNode) {
  // `nodeById` can contain a decomposed world-space display projection.
  const canonical = nodes.find((candidate) => candidate.id === node.id);
  if (!canonical) return false;
  return selectedIds.length === 1
    && canonical.kind !== "line"
    && canonical.kind !== "group"
    && canonical.locked !== true
    && canonical.visible !== false;
}
/** Line's editable geometry is its two endpoints rather than a rectangular
 * box. Relative-v1 moves rewrite the local origin and basis while retaining
 * the parent matrix, so both paths share the same visual contract. */
function canEditLineEndpoints(node: CanvasNode) {
  const canonical = nodes.find((candidate) => candidate.id === node.id);
  return Boolean(canonical
    && selectedIds.length === 1
    && canonical.kind === "line"
    && canonical.locked !== true
    && canonical.visible !== false);
}
function rotatedLegacyPoint(node: CanvasNode, localX: number, localY: number) {
  const radians = node.rotation * Math.PI / 180;
  const centerX = node.x + node.width / 2;
  const centerY = node.y + node.height / 2;
  const deltaX = localX - node.width / 2;
  const deltaY = localY - node.height / 2;
  return {
    x: centerX + Math.cos(radians) * deltaX - Math.sin(radians) * deltaY,
    y: centerY + Math.sin(radians) * deltaX + Math.cos(radians) * deltaY,
  };
}
function resizeHandleLayoutForSize(width: number, height: number): Array<[CanvasResizeHandle, number, number]> {
  return [
    ["nw", 0, 0], ["n", width / 2, 0], ["ne", width, 0], ["e", width, height / 2],
    ["se", width, height], ["s", width / 2, height], ["sw", 0, height], ["w", 0, height / 2],
  ];
}
/** Local visual envelope for the closed-shape Stroke cases whose paint extends
 * beyond GeometryProps. This deliberately mirrors worldVisualBoundsForNode
 * before the affine transform is applied, so selection, hover and resize
 * handles never disagree with the actual Canvas paint. */
function resizeHandleLayout(node: CanvasNode) {
  const bounds = closedShapeStrokeLocalBounds(node);
  return resizeHandleLayoutForSize(bounds?.width ?? node.width, bounds?.height ?? node.height)
    .map(([handle, x, y]) => [handle, x + (bounds?.x ?? 0), y + (bounds?.y ?? 0)] as [CanvasResizeHandle, number, number]);
}
function resizeHandleWorldPoint(node: CanvasNode, localX: number, localY: number) {
  const transform = node.relativeTransform ? worldTransformForNode(nodes, node.id) : undefined;
  return transform ? transformPoint(transform, { x: localX, y: localY }) : rotatedLegacyPoint(node, localX, localY);
}
function lineEndpointHandleAtScreen(screenX: number, screenY: number): { node: CanvasNode; endpoint: LineEndpoint } | undefined {
  const selected = selectedIds.length === 1 ? nodeById.get(selectedIds[0]) : undefined;
  const canonical = selected ? nodes.find((node) => node.id === selected.id) : undefined;
  if (!selected || !canonical || !canEditLineEndpoints(selected)) return undefined;
  const endpoints = lineEndpointWorldPoints(canonical);
  const radius = canvasDesignTokens.overlay.selectionHandle.hitRadius;
  const hit = (Object.entries(endpoints) as Array<[LineEndpoint, { x: number; y: number }]>)
    .map(([endpoint, point]) => ({ endpoint, distance: Math.hypot(screenX - toScreen(point.x, point.y).x, screenY - toScreen(point.x, point.y).y) }))
    .filter(({ distance }) => distance <= radius)
    .sort((left, right) => left.distance - right.distance)[0];
  return hit ? { node: canonical, endpoint: hit.endpoint } : undefined;
}
function lineEndpointWorldPoints(node: CanvasNode): Readonly<{ start: { x: number; y: number }; end: { x: number; y: number } }> {
  const transform = node.relativeTransform ? worldTransformForNode(nodes, node.id) : undefined;
  return transform
    ? { start: transformPoint(transform, { x: 0, y: 0 }), end: transformPoint(transform, { x: node.width, y: 0 }) }
    : lineEndpoints(node);
}
function resizeHandleAtScreen(screenX: number, screenY: number): { node: CanvasNode; handle: CanvasResizeHandle } | undefined {
  const selected = selectedIds.length === 1 ? nodeById.get(selectedIds[0]) : undefined;
  const canonical = selected ? nodes.find((node) => node.id === selected.id) : undefined;
  if (!selected || !canonical || !canResizeOnCanvas(selected)) return undefined;
  const hitRadius = canvasDesignTokens.overlay.selectionHandle.hitRadius;
  const hit = resizeHandleLayout(canonical).map(([handle, localX, localY]) => {
    const world = resizeHandleWorldPoint(canonical, localX, localY);
    const screen = toScreen(world.x, world.y);
    return { handle, distance: Math.hypot(screenX - screen.x, screenY - screen.y) };
  }).filter(({ distance }) => distance <= hitRadius).sort((left, right) => left.distance - right.distance)[0];
  return hit ? { node: canonical, handle: hit.handle } : undefined;
}
/** Multi-resize maps complex leaves through an exact affine world scale. A
 * selected Group expands its complete editable subtree, including Frame and
 * Section containers. Container patches precede descendant patches so a Frame
 * can run its Core constraints while the final child transforms still preserve
 * the exact Group-scale result. Group bounds remain Core-derived. */
function multiResizeSelection() {
  return resolveMultiResizeSelection(nodes, selectedIds);
}

function multiResizeHandleAtScreen(screenX: number, screenY: number): { handle: CanvasResizeHandle; bounds: ResizeGeometry; ids: string[]; requiresAffine: boolean } | undefined {
  const selection = multiResizeSelection();
  if (!selection) return undefined;
  const radius = canvasDesignTokens.overlay.selectionHandle.hitRadius;
  const hit = resizeHandleLayoutForSize(selection.bounds.width, selection.bounds.height).map(([handle, localX, localY]) => {
    const screen = toScreen(selection.bounds.x + localX, selection.bounds.y + localY);
    return { handle, distance: Math.hypot(screenX - screen.x, screenY - screen.y) };
  }).filter(({ distance }) => distance <= radius).sort((left, right) => left.distance - right.distance)[0];
  return hit ? { handle: hit.handle, bounds: selection.bounds, ids: selection.ids, requiresAffine: selection.requiresAffine } : undefined;
}
function renderResizeHandles(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode) {
  const canonical = nodes.find((candidate) => candidate.id === node.id);
  if (!canonical || !canResizeOnCanvas(node)) return;
  const side = canvasDesignTokens.overlay.selectionHandle.side;
  const half = side / 2;
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = canvasDesignTokens.color.selection;
  ctx.lineWidth = canvasDesignTokens.stroke.selection.width;
  resizeHandleLayout(canonical).forEach(([, localX, localY]) => {
    const world = resizeHandleWorldPoint(canonical, localX, localY);
    const screen = toScreen(world.x, world.y);
    ctx.fillRect(screen.x - half, screen.y - half, side, side);
    ctx.strokeRect(screen.x - half, screen.y - half, side, side);
  });
  ctx.restore();
}
function renderMultiResizeSelection(ctx: OffscreenCanvasRenderingContext2D, selection = multiResizeSelection()) {
  if (!selection) return false;
  const point = toScreen(selection.bounds.x, selection.bounds.y);
  const width = selection.bounds.width * viewport.zoom;
  const height = selection.bounds.height * viewport.zoom;
  ctx.save();
  ctx.strokeStyle = canvasDesignTokens.color.selection;
  ctx.lineWidth = canvasDesignTokens.stroke.selection.width;
  ctx.strokeRect(point.x + canvasDesignTokens.stroke.selection.pixelInset, point.y + canvasDesignTokens.stroke.selection.pixelInset, Math.max(0, width - 1), Math.max(0, height - 1));
  const side = canvasDesignTokens.overlay.selectionHandle.side;
  const half = side / 2;
  ctx.fillStyle = "#ffffff";
  resizeHandleLayoutForSize(selection.bounds.width, selection.bounds.height).forEach(([, localX, localY]) => {
    const screen = toScreen(selection.bounds.x + localX, selection.bounds.y + localY);
    ctx.fillRect(screen.x - half, screen.y - half, side, side);
    ctx.strokeRect(screen.x - half, screen.y - half, side, side);
  });
  ctx.restore();
  return true;
}
function renderLineEndpointHandles(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode) {
  const canonical = nodes.find((candidate) => candidate.id === node.id);
  if (!canonical || !canEditLineEndpoints(node)) return;
  const radius = canvasDesignTokens.overlay.selectionHandle.side / 2;
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = canvasDesignTokens.color.selection;
  ctx.lineWidth = canvasDesignTokens.stroke.selection.width;
  Object.values(lineEndpointWorldPoints(canonical)).forEach((point) => {
    const screen = toScreen(point.x, point.y);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });
  ctx.restore();
}
function resizeGeometryForCanvasNode(
  node: CanvasNode,
  handle: CanvasResizeHandle,
  startWorld: { x: number; y: number },
  currentWorld: { x: number; y: number },
  preserveAspectRatio: boolean,
  fromCenter: boolean,
): Pick<CanvasNode, "x" | "y" | "width" | "height" | "rotation" | "relativeTransform"> | undefined {
  // A crossed resize writes a positive size plus an explicit reflection. For
  // containers, descendants retain their local coordinates: composition with
  // the reflected parent matrix mirrors the complete subtree, while Core sees
  // the new positive Frame dimensions and can apply its normal constraints
  // transaction before the final world transforms are rendered.
  if (!preserveAspectRatio && !fromCenter) {
    const world = worldTransformForNode(nodes, node.id);
    const inverse = world && invertAffine(world);
    if (world && inverse) {
      const start = transformPoint(inverse, startWorld);
      const current = transformPoint(inverse, currentWorld);
      const flipped = resizeGeometryFromCornerWithFlip(
        { x: 0, y: 0, width: node.width, height: node.height },
        handle,
        { x: current.x - start.x, y: current.y - start.y },
      );
      if (flipped.flipX || flipped.flipY) {
        const parentWorld = node.parentId ? worldTransformForNode(nodes, node.parentId) : undefined;
        if (node.parentId && !parentWorld) return undefined;
        const projected = nodePropsForWorldTransform(multiplyAffine(world, flipped.localTransform), parentWorld, flipped.width, flipped.height);
        return projected ? { ...projected, width: flipped.width, height: flipped.height } : undefined;
      }
    }
  }
  if (!node.relativeTransform) {
    return { ...resizeRotatedLegacyGeometry(node, handle, startWorld, currentWorld, undefined, preserveAspectRatio, fromCenter), rotation: node.rotation, relativeTransform: undefined };
  }
  const relativeTransform = node.relativeTransform;
  const world = worldTransformForNode(nodes, node.id);
  const resized = world && resizeRelativeTransformFromWorldGesture({ width: node.width, height: node.height, relativeTransform }, world, handle, startWorld, currentWorld, preserveAspectRatio, fromCenter);
  if (!resized) return undefined;
  const parentWorld = node.parentId ? worldTransformForNode(nodes, node.parentId) : undefined;
  if (node.parentId && !parentWorld) return undefined;
  const nextWorld = parentWorld ? multiplyAffine(parentWorld, resized.relativeTransform) : resized.relativeTransform;
  const projected = nodePropsForWorldTransform(nextWorld, parentWorld, resized.width, resized.height);
  if (!projected) return undefined;
  return { ...projected, width: resized.width, height: resized.height };
}
function resizeLineForCanvasNode(
  node: CanvasNode,
  endpoint: LineEndpoint,
  currentWorld: { x: number; y: number },
): Pick<CanvasNode, "x" | "y" | "width" | "rotation" | "relativeTransform"> | undefined {
  if (!node.relativeTransform) return { ...resizeLegacyLineEndpoint(node, endpoint, currentWorld), relativeTransform: undefined };
  const relativeTransform = node.relativeTransform;
  const world = worldTransformForNode(nodes, node.id);
  const resized = world && resizeRelativeLineEndpointFromWorldGesture({ width: node.width, relativeTransform }, world, endpoint, currentWorld);
  if (!resized) return undefined;
  const parentWorld = node.parentId ? worldTransformForNode(nodes, node.parentId) : undefined;
  if (node.parentId && !parentWorld) return undefined;
  const nextWorld = parentWorld ? multiplyAffine(parentWorld, resized.relativeTransform) : resized.relativeTransform;
  const projected = nodePropsForWorldTransform(nextWorld, parentWorld, resized.width, node.height);
  return projected ? { ...projected, width: resized.width } : undefined;
}
function renderSelection(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode) {
  if (!selectedIds.includes(node.id)) return;
  // The spatial/index projection can flatten a Relative-v1 node for paint
  // performance. Selection must instead retain its canonical local rectangle
  // and apply the resolved world matrix exactly once.
  const canonical = nodes.find((candidate) => candidate.id === node.id) ?? node;
  if (canonical.kind === "line") {
    renderLineOutline(ctx, canonical, canvasDesignTokens.stroke.selection.width);
    renderLineEndpointHandles(ctx, canonical);
    return;
  }
  const point = toScreen(canonical.x, canonical.y);
  const w = canonical.width * viewport.zoom;
  const h = canonical.height * viewport.zoom;
  const visualBounds = closedShapeStrokeLocalBounds(canonical);
  const outlineX = (visualBounds?.x ?? 0) * viewport.zoom;
  const outlineY = (visualBounds?.y ?? 0) * viewport.zoom;
  const outlineWidth = (visualBounds?.width ?? canonical.width) * viewport.zoom;
  const outlineHeight = (visualBounds?.height ?? canonical.height) * viewport.zoom;
  ctx.save();
  if (!applyNativeAffine(ctx, canonical)) {
    ctx.translate(point.x + w / 2, point.y + h / 2);
    ctx.rotate(canonical.rotation * Math.PI / 180);
    ctx.translate(-w / 2, -h / 2);
  }
  ctx.strokeStyle = canvasDesignTokens.color.selection; ctx.lineWidth = canvasDesignTokens.stroke.selection.width; ctx.setLineDash([...canvasDesignTokens.stroke.selection.dash]); ctx.strokeRect(outlineX + canvasDesignTokens.stroke.selection.pixelInset, outlineY + canvasDesignTokens.stroke.selection.pixelInset, Math.max(0, outlineWidth - 1), Math.max(0, outlineHeight - 1)); ctx.setLineDash([]);
  ctx.restore();
  renderResizeHandles(ctx, canonical);
}

/** Figma keeps a Line's selection rectangle centred on its path. A generic
 * zero-height rectangle is offset by its pixel inset and appears to float
 * above or below the segment, especially after rotation. */
function renderLineOutline(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, lineWidth: number) {
  const point = toScreen(node.x, node.y);
  const local = lineSelectionBounds(node);
  ctx.save();
  if (!applyNativeAffine(ctx, node)) {
    ctx.translate(point.x, point.y);
    ctx.rotate(node.rotation * Math.PI / 180);
  }
  ctx.strokeStyle = canvasDesignTokens.color.selection;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash([...canvasDesignTokens.stroke.selection.dash]);
  ctx.strokeRect(local.x * viewport.zoom, local.y * viewport.zoom, local.width * viewport.zoom, local.height * viewport.zoom);
  ctx.setLineDash([]);
  ctx.restore();
}

/** Text stays outside the document until pointer-up, so its ordinary selected
 * state is unavailable while the user is defining the editable box. Render the
 * same bounds directly over that transient node to make an empty text drag
 * feel continuous with the selected text layer that follows. */
function renderTextCreationHighlight(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode) {
  if (node.kind !== "text") return;
  const point = toScreen(node.x, node.y);
  const w = node.width * viewport.zoom;
  const h = node.height * viewport.zoom;
  ctx.save();
  if (!applyNativeAffine(ctx, node)) {
    ctx.translate(point.x + w / 2, point.y + h / 2);
    ctx.rotate(node.rotation * Math.PI / 180);
    ctx.translate(-w / 2, -h / 2);
  }
  ctx.strokeStyle = canvasDesignTokens.color.selection;
  ctx.lineWidth = canvasDesignTokens.stroke.selection.width;
  ctx.setLineDash([...canvasDesignTokens.stroke.selection.dash]);
  ctx.strokeRect(canvasDesignTokens.stroke.selection.pixelInset, canvasDesignTokens.stroke.selection.pixelInset, Math.max(0, w - 1), Math.max(0, h - 1));
  ctx.setLineDash([]);
  ctx.restore();
}
function renderHover(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode) {
  if (hoveredId !== node.id || selectedIds.includes(node.id) || node.visible === false) return;
  const canonical = nodes.find((candidate) => candidate.id === node.id) ?? node;
  if (canonical.kind === "group") {
    // Group scalar geometry is a compatibility projection and can legitimately
    // lag a child-derived resize until the next Core snapshot. Selection already
    // expands a Group to its editable descendants, so hover must use that same
    // live world-space envelope rather than the potentially stale Group record.
    const selection = resolveMultiResizeSelection(nodes, [canonical.id]);
    if (!selection) return;
    const point = toScreen(selection.bounds.x, selection.bounds.y);
    const hoverWidth = selection.bounds.width * viewport.zoom;
    const hoverHeight = selection.bounds.height * viewport.zoom;
    ctx.save();
    ctx.strokeStyle = canvasDesignTokens.color.selection;
    ctx.lineWidth = canvasDesignTokens.stroke.hover.width;
    ctx.setLineDash([]);
    ctx.strokeRect(
      point.x + canvasDesignTokens.stroke.hover.pixelInset,
      point.y + canvasDesignTokens.stroke.hover.pixelInset,
      Math.max(0, hoverWidth - 1),
      Math.max(0, hoverHeight - 1),
    );
    ctx.restore();
    return;
  }
  if (canonical.kind === "line") {
    renderLineOutline(ctx, canonical, canvasDesignTokens.stroke.hover.width);
    return;
  }
  const point = toScreen(canonical.x, canonical.y);
  const w = canonical.width * viewport.zoom;
  const h = canonical.height * viewport.zoom;
  const visualBounds = closedShapeStrokeLocalBounds(canonical);
  const outlineX = (visualBounds?.x ?? 0) * viewport.zoom;
  const outlineY = (visualBounds?.y ?? 0) * viewport.zoom;
  const outlineWidth = (visualBounds?.width ?? canonical.width) * viewport.zoom;
  const outlineHeight = (visualBounds?.height ?? canonical.height) * viewport.zoom;
  if (w <= 0 || h <= 0) return;
  ctx.save();
  if (!applyNativeAffine(ctx, canonical)) {
    ctx.translate(point.x + w / 2, point.y + h / 2);
    ctx.rotate(canonical.rotation * Math.PI / 180);
    ctx.translate(-w / 2, -h / 2);
  }
  ctx.strokeStyle = canvasDesignTokens.color.selection;
  ctx.lineWidth = canvasDesignTokens.stroke.hover.width;
  if (canonical.kind === "ellipse") {
    ctx.beginPath();
    ctx.ellipse(outlineX + outlineWidth / 2, outlineY + outlineHeight / 2, Math.max(0, outlineWidth / 2 - canvasDesignTokens.stroke.hover.pixelInset), Math.max(0, outlineHeight / 2 - canvasDesignTokens.stroke.hover.pixelInset), 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (canonical.kind === "text" || canonical.kind === "frame" || canonical.kind === "section") {
    // Frame/Section hover bounds stay rectilinear even when their paint has rounded corners.
    ctx.strokeRect(outlineX + canvasDesignTokens.stroke.hover.pixelInset, outlineY + canvasDesignTokens.stroke.hover.pixelInset, Math.max(0, outlineWidth - 1), Math.max(0, outlineHeight - 1));
  } else {
    const geometry = resolveInsideRoundedRect(w, h, canonical.radius * viewport.zoom, 0);
    roundedRectPath(ctx, outlineX + canvasDesignTokens.stroke.hover.pixelInset, outlineY + canvasDesignTokens.stroke.hover.pixelInset, Math.max(0, outlineWidth - 1), Math.max(0, outlineHeight - 1), Math.max(0, geometry.outerRadius - canvasDesignTokens.stroke.hover.pixelInset));
    ctx.stroke();
  }
  ctx.restore();
}
function renderLayerName(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, selected = false) {
  const point = toScreen(node.x, node.y);
  const width = node.width * viewport.zoom;
  const height = node.height * viewport.zoom;
  ctx.save();
  if (!applyNativeAffine(ctx, node)) {
    ctx.translate(point.x + width / 2, point.y + height / 2);
    ctx.rotate(node.rotation * Math.PI / 180);
    ctx.translate(-width / 2, -height / 2);
  }
  ctx.font = canvasFont(canvasDesignTokens.typography.layerName);
  ctx.fillStyle = selected ? canvasDesignTokens.color.selection : canvasDesignTokens.color.layerName;
  ctx.textBaseline = "bottom";
  ctx.fillText(node.name, 0, -canvasDesignTokens.overlay.frameName.offsetY);
  ctx.restore();
}
function renderFrameName(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode) {
  if ((node.kind !== "frame" && node.kind !== "section") || node.visible === false || selectedIds.includes(node.id)) return;
  renderLayerName(ctx, node);
}
function renderSelectionDimensions(ctx: OffscreenCanvasRenderingContext2D, dimensions: string, labelX: number, labelY: number, labelWidth: number, labelHeight: number, horizontalInset: number, cornerRadius: number) {
  ctx.beginPath();
  ctx.roundRect(labelX, labelY, labelWidth, labelHeight, cornerRadius);
  ctx.fillStyle = canvasDesignTokens.color.selection;
  ctx.fill();
  ctx.fillStyle = canvasDesignTokens.color.selectionLabelText;
  ctx.textBaseline = "middle";
  ctx.fillText(dimensions, labelX + horizontalInset, labelY + labelHeight / 2);
}
function renderSelectionLabel(ctx: OffscreenCanvasRenderingContext2D, multiSelection?: MultiResizeSelection) {
  const selectedNodes = selectedIds.map((id) => nodeById.get(id)).filter((node): node is CanvasNode => Boolean(node && node.visible !== false));
  if (selectedNodes.length === 0) return;
  const screenBounds = multiSelection
    ? (() => {
        const point = toScreen(multiSelection.bounds.x, multiSelection.bounds.y);
        return [{ left: point.x, top: point.y, right: point.x + multiSelection.bounds.width * viewport.zoom, bottom: point.y + multiSelection.bounds.height * viewport.zoom }];
      })()
    : selectedNodes.map((node) => {
    const canonical = nodes.find((candidate) => candidate.id === node.id) ?? node;
    const world = worldTransformForNode(nodes, canonical.id);
    const corners = world
      ? [
          transformPoint(world, { x: 0, y: 0 }),
          transformPoint(world, { x: canonical.width, y: 0 }),
          transformPoint(world, { x: canonical.width, y: canonical.height }),
          transformPoint(world, { x: 0, y: canonical.height }),
        ].map((point) => toScreen(point.x, point.y))
      : (() => {
          const bounds = boundsForNode(node);
          const point = toScreen(bounds.x, bounds.y);
          return [point, { x: point.x + bounds.width * viewport.zoom, y: point.y + bounds.height * viewport.zoom }];
        })();
    return {
      left: Math.min(...corners.map((point) => point.x)),
      top: Math.min(...corners.map((point) => point.y)),
      right: Math.max(...corners.map((point) => point.x)),
      bottom: Math.max(...corners.map((point) => point.y)),
    };
    });
  const leftEdge = Math.min(...screenBounds.map((bounds) => bounds.left));
  const topEdge = Math.min(...screenBounds.map((bounds) => bounds.top));
  const rightEdge = Math.max(...screenBounds.map((bounds) => bounds.right));
  const bottomEdge = Math.max(...screenBounds.map((bounds) => bounds.bottom));
  const dimensions = multiSelection
    ? selectionDimensions(multiSelection.bounds.width, multiSelection.bounds.height)
    : selectedNodes.length === 1
    ? selectionDimensions(selectedNodes[0].width, selectedNodes[0].height)
    : selectionDimensions((rightEdge - leftEdge) / viewport.zoom, (bottomEdge - topEdge) / viewport.zoom);
  const { height: labelHeight, horizontalInset, cornerRadius, offsetY } = canvasDesignTokens.overlay.selectionLabel;
  ctx.save();
  // Overlay labels are viewport UI. Rendering a clipped Frame or a native
  // affine shape earlier in the frame may legitimately leave a non-identity
  // transform active in the shared Canvas context; never inherit it here.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const selectedNode = selectedNodes.length === 1 ? selectedNodes[0] : undefined;
  if (selectedNode?.kind === "frame" || selectedNode?.kind === "section") {
    renderLayerName(ctx, selectedNode, true);
  }
  ctx.font = canvasFont(canvasDesignTokens.typography.selectionLabel);
  const labelWidth = Math.ceil(ctx.measureText(dimensions).width) + horizontalInset * 2;
  // The label is screen-space UI. Its anchor shares the same world-derived
  // selection rectangle as the outline and handles, then sits just below that
  // rectangle instead of inheriting an unprojected x/y or object rotation.
  const labelX = Math.max(0, Math.min((leftEdge + rightEdge - labelWidth) / 2, width - labelWidth));
  const labelY = Math.max(0, Math.min(bottomEdge + offsetY, height - labelHeight));
  renderSelectionDimensions(ctx, dimensions, labelX, labelY, labelWidth, labelHeight, horizontalInset, cornerRadius);
  ctx.restore();
}
function updateMarqueeSelection(activeDrag: Extract<Drag, { mode: "select" }>, endX: number, endY: number) {
  activeDrag.currentX = endX;
  activeDrag.currentY = endY;
  const selection = marqueeRect({ x: activeDrag.startX, y: activeDrag.startY }, { x: endX, y: endY });
  const marqueeIds = selection.width === 0 && selection.height === 0
    ? []
    : activeNodes().filter((node) => node.visible !== false && boundsIntersect(boundsForNode(node), selection)).map((node) => node.id);
  selectedIds = resolveMarqueeSelection(activeDrag.initialSelection, marqueeIds, activeDrag.additive);
}
function renderMarquee(ctx: OffscreenCanvasRenderingContext2D) {
  if (drag?.mode !== "select") return;
  const start = toScreen(drag.startX, drag.startY);
  const end = toScreen(drag.currentX, drag.currentY);
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const marqueeWidth = Math.abs(end.x - start.x);
  const marqueeHeight = Math.abs(end.y - start.y);
  ctx.save();
  ctx.fillStyle = canvasDesignTokens.color.selectionFill;
  ctx.strokeStyle = canvasDesignTokens.color.selection;
  ctx.lineWidth = canvasDesignTokens.stroke.marquee.width;
  ctx.setLineDash([...canvasDesignTokens.stroke.marquee.dash]);
  ctx.fillRect(x, y, marqueeWidth, marqueeHeight);
  ctx.strokeRect(x + .5, y + .5, marqueeWidth, marqueeHeight);
  ctx.restore();
}
function render(rendersPerInputFrame?: number) {
  if (!context || !canvas) return;
  // Cache eviction is presentation-only. Re-request each visible missing asset
  // so a page converges on the shared per-image proxy budget instead of
  // leaving an evicted layer on its striped placeholder indefinitely.
  new Set(activeNodes()
    .filter((node) => node.visible !== false && node.kind !== "text" && Boolean(node.assetId) && !imageBitmaps.has(node.assetId!))
    .map((node) => node.assetId!))
    .forEach((assetId) => void ensureImageBitmap(assetId));
  const startedAt = performance.now();
  const cullingStartedAt = startedAt;
  const viewportBounds = viewportWorldBounds(viewport, width, height);
  const candidateNodes = spatialGrid.query(viewportBounds);
  // The spatial index intentionally contains every canonical node. Intersect
  // it with hierarchy visibility here so a hidden Section's descendants cannot
  // reappear merely because this render path bypasses `activeNodes()`.
  const hierarchyVisibleIds = new Set(visibleNodesOnPage(nodes, activePageId, defaultPageId).map((node) => node.id));
  const visibleNodes = candidateNodes.filter((node) => hierarchyVisibleIds.has(node.id) && node.id !== editingTextNodeId && boundsIntersect(nodeBoundsById.get(node.id) ?? rotatedNodeBounds(node), viewportBounds));
  // `nodeById` and the spatial grid intentionally build their own projected
  // copies. Object identity therefore cannot decide whether an overlay node is
  // visible; compare the durable NodeId so Line selection/hover is not skipped
  // after a Relative-v1 projection.
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  // Rust supplies the committed command order. Canvas keeps interleaved layer
  // order for nodes that cannot safely enter the GPU pass prefix.
  const rustRenderGraph = rustRenderGraphForVisibleNodes(viewportBounds, visibleNodes);
  const renderOrderedNodes = orderNodesByRustRenderCommands(sortNodesByLayerOrder(visibleNodes), rustRenderGraph);
  const cullingMs = performance.now() - cullingStartedAt;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = canvasDesignTokens.color.backdrop;
  context.fillRect(0, 0, width, height);
  let gpuRenderedNodeIds: ReadonlySet<string> | undefined;
  let gpuUploadBytes = 0;
  let imageBitmapMs = 0;
  let compositeMs = 0;
  const gpuStartedAt = performance.now();
  const pageHasFrameChildren = visibleNodesOnPage(nodes, activePageId, defaultPageId)
    .some((node) => node.parentId && nodes.some((parent) => parent.id === node.parentId && parent.kind === "frame" && parent.clipsContent !== false));
  if (gpuRenderer) {
    try {
      // GPU stores the whole world-space document once; the camera uniform performs
      // viewport changes. Canvas-only overlays continue to use the culled list.
      const pageNodes = activeNodes().filter((node) => node.id !== editingTextNodeId);
      const pageHasRelativeTransform = visibleNodesOnPage(nodes, activePageId, defaultPageId)
        .some((node) => Boolean(node.relativeTransform));
      const decodedImageAssetIds = new Set(pageNodes
        .filter((node) => node.kind === "image" && Boolean(node.assetId) && Boolean(imageBitmaps.get(node.assetId!)))
        .map((node) => node.assetId!));
      refreshRustGpuTextGlyphs();
      const gpuTextNodeIds = new Set([...rustGpuTextGlyphs]
        .filter(([, cached]) => cached.revision === revision && cached.glyphs.length > 0)
        .map(([nodeId]) => nodeId));
      const gpuNodes = pageHasFrameChildren ? [] : gpuLayerPrefix(pageNodes, decodedImageAssetIds, gpuTextNodeIds, (node) => !nativeAffineForNode(node));
      const currentRustGpuScene = gpuNodes.length === pageNodes.length && rustGpuScene
        && rustGpuScene.revision === revision
        && rustGpuScene.pageId === activePageId
        && rustGpuScene.transientSceneVersion === transientSceneVersion
        && !pageHasRelativeTransform
        ? { instances: rustGpuScene.instances, renderedNodeIds: rustGpuScene.renderedNodeIds }
        : undefined;
      const gpuImageBitmaps = new Map<string, ImageBitmap>();
      gpuNodes.forEach((node) => {
        if (node.kind !== "image" || !node.assetId) return;
        const bitmap = imageBitmaps.get(node.assetId);
        if (bitmap) gpuImageBitmaps.set(node.assetId, bitmap);
      });
      const textGlyphs = gpuNodes.filter((node) => node.kind === "text").flatMap((node) => rustGpuTextGlyphs.get(node.id)?.glyphs ?? []);
      const result = gpuRenderer.render({ nodes: gpuNodes, viewport, width, height, dpr, sceneKey: `${revision}:${activePageId}:${transientSceneVersion}:${gpuNodes.map((node) => node.id).join(",")}`, precomputedInstances: currentRustGpuScene, imageBitmaps: gpuImageBitmaps, textGlyphs });
      const compositeStartedAt = performance.now();
      context.drawImage(result.bitmap, 0, 0, width, height);
      compositeMs = performance.now() - compositeStartedAt;
      result.bitmap.close();
      gpuRenderedNodeIds = result.renderedNodeIds;
      gpuUploadBytes = result.gpuUploadBytes;
      imageBitmapMs = result.imageBitmapMs;
      gpuSceneBytes = result.resourceBytes;
      const imageTextureSignature = `${result.imageTextures.textures}:${result.imageTextures.bytes}`;
      if (imageTextureSignature !== imageTextureStatsSignature) {
        imageTextureStatsSignature = imageTextureSignature;
        diagnostics.record({ category: "renderer", code: "IMAGE_TEXTURE_STATS", documentRevision: revision, details: { textures: result.imageTextures.textures, bytes: result.imageTextures.bytes, cacheHits: result.imageTextures.cacheHits, uploads: result.imageTextures.uploads, releases: result.imageTextures.releases } });
      }
      if (result.imageTextures.releases) diagnostics.record({ category: "renderer", code: "IMAGE_TEXTURE_RELEASED", documentRevision: revision, details: { textures: result.imageTextures.textures, releases: result.imageTextures.releases, bytes: result.imageTextures.bytes } });
      const textAtlasSignature = `${result.textAtlas.pages}:${result.textAtlas.entries}:${result.textAtlas.bytes}`;
      if (textAtlasSignature !== textAtlasStatsSignature) {
        textAtlasStatsSignature = textAtlasSignature;
        diagnostics.record({ category: "renderer", code: "TEXT_ATLAS_STATS", documentRevision: revision, details: { pages: result.textAtlas.pages, entries: result.textAtlas.entries, bytes: result.textAtlas.bytes, cacheHits: result.textAtlas.cacheHits, uploads: result.textAtlas.uploads, evictions: result.textAtlas.evictions, rejectedNodes: result.textAtlas.rejectedNodes } });
      }
      if (result.textAtlas.evictions) diagnostics.record({ category: "renderer", code: "TEXT_ATLAS_EVICTED", documentRevision: revision, details: { pages: result.textAtlas.pages, evictions: result.textAtlas.evictions, entries: result.textAtlas.entries } });
      if (result.textAtlas.rejectedNodes) diagnostics.record({ category: "renderer", code: "TEXT_ATLAS_NODE_FALLBACK", documentRevision: revision, details: { pages: result.textAtlas.pages, rejectedNodes: result.textAtlas.rejectedNodes } });
      gpuSceneWithinBudget = true;
      gpuSceneLimitReported = false;
    } catch (error) {
      if (error instanceof GpuSceneResourceLimitError) {
        gpuSceneBytes = error.admission.resourceBytes;
        gpuSceneWithinBudget = false;
        if (!gpuSceneLimitReported) diagnostics.record({ category: "renderer", code: "GPU_SCENE_RESOURCE_LIMIT" });
        gpuSceneLimitReported = true;
      } else {
        const code = classifyWebGpuRendererFailure(error);
        gpuSceneBytes = 0;
        gpuSceneWithinBudget = true;
        gpuRenderer.destroy();
        gpuRenderer = undefined;
        gpuStatus = "unavailable";
        diagnostics.record({ category: "renderer", code, documentRevision: revision, details: { errorKind: code } });
      }
    }
  }
  const gpuPrepareMs = performance.now() - gpuStartedAt;
  const overlayStartedAt = performance.now();
  if (pageHasFrameChildren) renderFrameClippedTree(context!, renderOrderedNodes);
  else renderOrderedNodes.forEach((node) => { if (!gpuRenderedNodeIds?.has(node.id)) renderNode(context!, node); });
  visibleNodes.forEach((node) => renderFrameName(context!, node));
  const hovered = hoveredId ? nodeById.get(hoveredId) : undefined;
  if (hovered && visibleNodeIds.has(hovered.id)) renderHover(context!, hovered);
  // The editing DOM layer intentionally replaces only glyph painting. Keep the
  // Canvas selection geometry visible beneath it, so the edit outline remains
  // identical to the hover/selected document bounds rather than using a browser
  // textarea focus ring with its own outside offset.
  const visibleSelected = selectedIds.map((id) => nodeById.get(id)).filter((node): node is CanvasNode => Boolean(
    node
    && node.visible !== false
    && boundsIntersect(nodeBoundsById.get(node.id) ?? rotatedNodeBounds(node), viewportBounds)
    && (visibleNodeIds.has(node.id) || node.id === editingTextNodeId),
  ));
  const multiSelection = multiResizeSelection();
  const renderedMultiSelection = renderMultiResizeSelection(context!, multiSelection);
  if (!renderedMultiSelection) visibleSelected.forEach((node) => renderSelection(context!, node));
  if (visibleSelected.length) renderSelectionLabel(context, multiSelection);
  renderMarquee(context);
  renderGrid(context);
  renderPerformance.record({ totalMs: performance.now() - startedAt, cullingMs, gpuPrepareMs, overlayMs: performance.now() - overlayStartedAt, imageBitmapMs, compositeMs, candidateNodes: candidateNodes.length, visibleNodes: visibleNodes.length, gpuUploadBytes, rendersPerInputFrame });
  maybeSimulateGpuLoss();
}
function dispatch(command: EditorCommand) {
  command = withResolvedTextAutoSize(command);
  command = withResolvedLayerPosition(command);
  if (command.type === "group" || command.type === "ungroup" || command.type === "reparent" || (command.type === "delete" && wasmDocument)) {
    if (!wasmDocument) { emitError(undefined, "TRANSIENT"); return; }
    const resolved = resolveCoreBatch(nodes, [command]);
    if (!resolved) { emitError(undefined, "INVALID_COMMAND"); return; }
    const structuralBaseRevision = Number(wasmDocument.revision);
    const structuralTransactionId = crypto.randomUUID();
    try {
      wasmDocument.apply_transaction_json(structuralTransactionId, wasmDocument.revision, JSON.stringify(resolved.batch));
      recordHistory("core");
      syncProjectionFromWasm(false);
      selectedIds = resolved.selectionIds.length
        ? resolved.selectionIds
        : command.type === "reparent" ? [...command.ids] : [];
      rebuildNodeIndex();
      render();
      emitSnapshot(journalEntry(command, structuralBaseRevision, structuralTransactionId));
      queueRemoteOperation(structuralTransactionId, structuralBaseRevision, resolved.batch, wasmDocument.canonical_hash());
    } catch (error) { emitError(error); }
    return;
  }
  const baseRevision = wasmDocument ? Number(wasmDocument.revision) : undefined;
  if (!admitToWasm(command)) return;
  const appliedByWasm = isWasmDocumentCommand(command);
  switch (command.type) {
    case "select-page": {
      if (!pages.some((page) => page.id === command.id)) { emitError(undefined, "INVALID_COMMAND"); break; }
      activePageId = command.id;
      refreshRustGpuScene();
      selectedIds = [];
      hoveredId = undefined;
      rebuildNodeIndex();
      render();
      emitSnapshot(undefined, false);
      break;
    }
    case "create-page": {
      if (!wasmDocument) { emitError(undefined, "INVALID_COMMAND"); break; }
      try {
        const pageBaseRevision = Number(wasmDocument.revision);
        const pageTransactionId = crypto.randomUUID();
        wasmDocument.create_page(pageTransactionId, wasmDocument.revision, command.id, command.name.trim());
        recordHistory("core");
        syncProjectionFromWasm(false);
        activePageId = command.id;
        refreshRustGpuScene();
        selectedIds = [];
        rebuildNodeIndex();
        render();
        emitSnapshot(journalEntry({ type: "restore-core", coreSnapshot: wasmDocument.snapshot_json() }, pageBaseRevision, pageTransactionId));
        const page = pages.find((candidate) => candidate.id === command.id);
        if (page) queueRemotePayload(pageTransactionId, pageBaseRevision, encodeCreatePagePayload(page), wasmDocument.canonical_hash(), { kind: "create-page", page: structuredClone(page) });
        else emitError(undefined, "TRANSIENT");
      } catch (error) { emitError(error); }
      break;
    }
    case "create": {
      commit(() => { nodes.push(command.node); selectedIds = [command.node.id]; }, appliedByWasm, appliedByWasm ? { type: "create", node: command.node } : undefined, baseRevision, true, command);
      const nextTool = toolAfterLayerCreated(tool);
      if (nextTool !== tool) { tool = nextTool; emit({ type: "tool", tool }); }
      break;
    }
    case "update": commit(() => { nodes = nodes.map((node) => node.id === command.id ? { ...node, ...command.patch } : node); }, appliedByWasm, appliedByWasm ? { type: "update", id: command.id, patch: command.patch } : undefined, baseRevision, true, command); break;
    case "reposition": commit(() => {
      const positions = new Map(command.positionIds.map(({ id, positionId }) => [id, positionId]));
      nodes = nodes.map((node) => positions.has(node.id) ? { ...node, positionId: positions.get(node.id)! } : node);
    }, appliedByWasm, appliedByWasm ? { type: "reposition", positionIds: command.positionIds } : undefined, baseRevision, true, command); break;
    case "select": selectedIds = command.ids; render(); emitViewState(); break;
    case "delete": commit(() => { nodes = nodes.filter((node) => !command.ids.includes(node.id)); selectedIds = []; }, appliedByWasm, appliedByWasm ? { type: "delete", ids: command.ids } : undefined, baseRevision, true, command); break;
    case "duplicate": {
      if (!wasmDocument) {
        const resolved = resolveCoreBatch(nodes, [command]);
        if (!resolved) { emitError(undefined, "INVALID_COMMAND"); break; }
        commit(() => { nodes = resolved.nextNodes; selectedIds = resolved.createdIds; });
        break;
      }
      const resolved = resolveCoreBatch(nodes, [command]);
      if (!resolved) { emitError(undefined, "INVALID_COMMAND"); break; }
      const duplicateBaseRevision = Number(wasmDocument.revision);
      const duplicateTransactionId = crypto.randomUUID();
      try {
        wasmDocument.apply_transaction_json(duplicateTransactionId, wasmDocument.revision, JSON.stringify(resolved.batch));
        recordHistory("core");
        syncProjectionFromWasm(false);
        selectedIds = resolved.createdIds;
        render();
        emitSnapshot(journalEntry({ type: "restore-core", coreSnapshot: wasmDocument.snapshot_json() }, duplicateBaseRevision, duplicateTransactionId));
        queueRemoteOperation(duplicateTransactionId, duplicateBaseRevision, resolved.batch, wasmDocument.canonical_hash());
      } catch (error) { emitError(error); }
      break;
    }
    case "copy": {
      // Copy is non-mutating: it only fills the Worker-owned clipboard. It never
      // produces a Core batch, history entry or remote operation.
      const captured = captureClipboard(nodes, command.ids, documentSchemaVersion);
      if (!captured) { emitError(undefined, "INVALID_COMMAND"); break; }
      clipboard = captured;
      break;
    }
    case "cut": {
      const captured = captureClipboard(nodes, command.ids, documentSchemaVersion);
      if (!captured) { emitError(undefined, "INVALID_COMMAND"); break; }
      // Cut = copy then delete the same roots in one atomic Core transaction.
      const cutResolved = resolveCoreBatch(nodes, [{ type: "delete", ids: captured.rootIds }]);
      if (!cutResolved) { emitError(undefined, "INVALID_COMMAND"); break; }
      if (!wasmDocument) {
        commit(() => { nodes = cutResolved.nextNodes; selectedIds = []; });
        clipboard = captured;
        break;
      }
      const cutBaseRevision = Number(wasmDocument.revision);
      const cutTransactionId = crypto.randomUUID();
      try {
        wasmDocument.apply_transaction_json(cutTransactionId, wasmDocument.revision, JSON.stringify(cutResolved.batch));
        recordHistory("core");
        syncProjectionFromWasm(false);
        selectedIds = [];
        rebuildNodeIndex();
        render();
        // Only commit the clipboard once the delete has succeeded, so a rejected
        // cut leaves the previous clipboard intact.
        clipboard = captured;
        emitSnapshot(journalEntry({ type: "restore-core", coreSnapshot: wasmDocument.snapshot_json() }, cutBaseRevision, cutTransactionId));
        queueRemoteOperation(cutTransactionId, cutBaseRevision, cutResolved.batch, wasmDocument.canonical_hash());
      } catch (error) { emitError(error); }
      break;
    }
    case "paste": {
      if (!clipboard) break;
      const target = pasteTarget();
      const availableAssetIds = new Set(assets.map((asset) => asset.assetId));
      const resolved = resolvePasteBatch(nodes, clipboard, target, availableAssetIds);
      if (!resolved) { emitError(undefined, "INVALID_COMMAND"); break; }
      if (!wasmDocument) {
        commit(() => { nodes = resolved.nextNodes; selectedIds = resolved.createdIds; });
        break;
      }
      const pasteBaseRevision = Number(wasmDocument.revision);
      const pasteTransactionId = crypto.randomUUID();
      try {
        wasmDocument.apply_transaction_json(pasteTransactionId, wasmDocument.revision, JSON.stringify(resolved.batch));
        recordHistory("core");
        syncProjectionFromWasm(false);
        selectedIds = resolved.createdIds;
        rebuildNodeIndex();
        render();
        emitSnapshot(journalEntry({ type: "restore-core", coreSnapshot: wasmDocument.snapshot_json() }, pasteBaseRevision, pasteTransactionId));
        queueRemoteOperation(pasteTransactionId, pasteBaseRevision, resolved.batch, wasmDocument.canonical_hash());
      } catch (error) { emitError(error); }
      break;
    }
    case "undo": {
      const kind = undoOrder.pop();
      if (!kind) break;
      if (kind === "local") {
        const before = history.pop();
        if (!before) { undoOrder.push(kind); break; }
        future.push({ nodes: cloneDocument(), advancesRevision: before.advancesRevision });
        redoOrder.push(kind);
        nodes = before.nodes;
        selectedIds = [];
        if (before.advancesRevision) revision += 1;
        render(); emitSnapshot(); break;
      }
      if (!wasmDocument?.can_undo) { undoOrder.push(kind); break; }
      const undoBaseRevision = Number(wasmDocument.revision);
      const undoBeforeHash = wasmDocument.canonical_hash();
      const before = cloneDocument();
      wasmDocument.undo(); redoOrder.push(kind); syncProjectionFromWasm(); selectedIds = []; render();
      let batch = historyReplayBatch(before, nodes);
      if (!batch.length && undoBeforeHash !== wasmDocument.canonical_hash()) {
        diagnostics.record({ category: "recovery", code: "HISTORY_REPLAY_DIFF_FALLBACK", documentRevision: revision, details: { direction: "undo", nodeCount: nodes.length } });
        batch = fullStateReplayBatch(nodes);
      }
      if (!batch.length) { emitSnapshot(); break; }
      const undoTransactionId = crypto.randomUUID();
      emitSnapshot(journalEntry({ type: "restore-core", coreSnapshot: wasmDocument.snapshot_json() }, undoBaseRevision, undoTransactionId));
      queueRemoteOperation(undoTransactionId, undoBaseRevision, batch, wasmDocument.canonical_hash());
      break;
    }
    case "redo": {
      const kind = redoOrder.pop();
      if (!kind) break;
      if (kind === "local") {
        const after = future.pop();
        if (!after) { redoOrder.push(kind); break; }
        history.push({ nodes: cloneDocument(), advancesRevision: after.advancesRevision });
        undoOrder.push(kind);
        nodes = after.nodes;
        selectedIds = [];
        if (after.advancesRevision) revision += 1;
        render(); emitSnapshot(); break;
      }
      if (!wasmDocument?.can_redo) { redoOrder.push(kind); break; }
      const redoBaseRevision = Number(wasmDocument.revision);
      const redoBeforeHash = wasmDocument.canonical_hash();
      const before = cloneDocument();
      wasmDocument.redo(); undoOrder.push(kind); syncProjectionFromWasm(); selectedIds = []; render();
      let batch = historyReplayBatch(before, nodes);
      if (!batch.length && redoBeforeHash !== wasmDocument.canonical_hash()) {
        diagnostics.record({ category: "recovery", code: "HISTORY_REPLAY_DIFF_FALLBACK", documentRevision: revision, details: { direction: "redo", nodeCount: nodes.length } });
        batch = fullStateReplayBatch(nodes);
      }
      if (!batch.length) { emitSnapshot(); break; }
      const redoTransactionId = crypto.randomUUID();
      emitSnapshot(journalEntry({ type: "restore-core", coreSnapshot: wasmDocument.snapshot_json() }, redoBaseRevision, redoTransactionId));
      queueRemoteOperation(redoTransactionId, redoBaseRevision, batch, wasmDocument.canonical_hash());
      break;
    }
    case "reset": resetDocumentToStarterNodes(); break;
    case "hydrate": {
      if (command.snapshot.format === "rust-core-v1") {
        ephemeralBenchmarkProjection = false;
        viewport = { ...command.snapshot.viewport };
        void loadDocumentBridge(command.snapshot);
      } else {
        ephemeralBenchmarkProjection = command.snapshot.format === "benchmark-projection-v1";
        nodes = normalizeIds(command.snapshot.nodes);
        rebuildNodeIndex();
        viewport = command.snapshot.viewport;
        render();
        emitSnapshot();
        void loadDocumentBridge(undefined, ephemeralBenchmarkProjection);
      }
      break;
    }
  }
}
function dispatchTransaction(transaction: Extract<MainToWorker, { type: "transaction" }> ["transaction"]) {
  // The Core document is the concurrency authority. `revision` is its rendered
  // projection and may be emitted by unrelated renderer/status updates, so it
  // must not independently reject a transaction that Core would accept.
  const coreRevision = Number(wasmDocument?.revision ?? revision);
  if (transaction.baseRevision !== coreRevision) {
    emitError(undefined, "REVISION_CONFLICT", transaction.id);
    emit({ type: "ack", transactionId: transaction.id, errorCode: "REVISION_CONFLICT" });
    return;
  }
  const controlCommand = transaction.commands.length === 1 && ["select", "select-page", "create-page", "undo", "redo", "reset", "hydrate"].includes(transaction.commands[0].type);
  if (controlCommand) {
    dispatch(transaction.commands[0]);
    emit({ type: "ack", transactionId: transaction.id, acceptedRevision: revision });
    return;
  }
  if (!wasmDocument) {
    emitError(undefined, "INVALID_COMMAND", transaction.id);
    emit({ type: "ack", transactionId: transaction.id, errorCode: "INVALID_TRANSACTION" });
    return;
  }
  const pageScopedCommands = transaction.commands.map((command) => command.type === "create" ? { ...command, node: { ...command.node, pageId: command.node.pageId ?? activePageId } } : command);
  const resolved = resolveCoreBatch(nodes, pageScopedCommands);
  if (!resolved) {
    emitError(undefined, "INVALID_COMMAND", transaction.id);
    emit({ type: "ack", transactionId: transaction.id, errorCode: "INVALID_TRANSACTION" });
    return;
  }
  try {
    const baseRevision = Number(wasmDocument.revision);
    wasmDocument.apply_transaction_json(transaction.id, BigInt(transaction.baseRevision), JSON.stringify(resolved.batch));
    recordHistory("core");
    syncProjectionFromWasm(false);
    selectedIds = resolved.createdIds.length ? resolved.createdIds : selectedIds.filter((id) => nodes.some((node) => node.id === id));
    render();
    diagnostics.record({ category: "transaction", code: "TRANSACTION_ACCEPTED", documentRevision: revision, transactionId: transaction.id, details: { commandCount: transaction.commands.length } });
    emitSnapshot(journalEntry({ type: "restore-core", coreSnapshot: wasmDocument.snapshot_json() }, baseRevision, transaction.id));
    queueRemoteOperation(transaction.id, baseRevision, resolved.batch, wasmDocument.canonical_hash());
    emit({ type: "ack", transactionId: transaction.id, acceptedRevision: revision });
  } catch (error) {
    const errorCode = error instanceof Error && error.message.includes("ResourceLimit") ? "RESOURCE_LIMIT" : "INVALID_TRANSACTION";
    diagnostics.record({ category: "transaction", code: "TRANSACTION_REJECTED", documentRevision: revision, transactionId: transaction.id, details: { errorCode } });
    emitError(error, errorCode === "RESOURCE_LIMIT" ? "RESOURCE_LIMIT" : "INVALID_COMMAND", transaction.id);
    emit({ type: "ack", transactionId: transaction.id, errorCode });
  }
}
function pointer(event: Extract<MainToWorker, { type: "pointer" }>) {
  const world = toWorld(event.x, event.y);
  if (event.event === "leave") {
    if (!drag && hoveredId !== undefined) {
      hoveredId = undefined;
      render();
    }
    return;
  }
  if (event.event === "down") {
    if (tool === "hand" || event.button === 1) { drag = { mode: "pan", startX: event.x, startY: event.y }; return; }
    if (tool !== "select") {
      if (event.readOnly) { render(); emitViewState(); return; }
      const snapped = snapCanvasPoint(world);
      const node = createNode(tool === "arrow" ? "line" : tool, snapped.x, snapped.y);
      if (tool === "arrow") {
        node.name = "Arrow";
        node.strokeCapEnd = "arrowLines";
      }
      node.width = 4;
      node.height = node.kind === "line" ? 0 : 4;
      drag = { mode: "draw", startX: snapped.x, startY: snapped.y, node };
      return;
    }
    const resize = !event.readOnly && resizeHandleAtScreen(event.x, event.y);
    if (resize) {
      drag = { mode: "resize", id: resize.node.id, handle: resize.handle, start: world, node: structuredClone(resize.node), before: cloneDocument() };
      return;
    }
    const lineResize = !event.readOnly && lineEndpointHandleAtScreen(event.x, event.y);
    if (lineResize) {
      drag = { mode: "line-resize", id: lineResize.node.id, endpoint: lineResize.endpoint, node: structuredClone(lineResize.node), before: cloneDocument() };
      return;
    }
    const multiResize = !event.readOnly && multiResizeHandleAtScreen(event.x, event.y);
    if (multiResize) {
      drag = { mode: "multi-resize", handle: multiResize.handle, start: world, bounds: multiResize.bounds, before: cloneDocument(), ids: multiResize.ids, requiresAffine: multiResize.requiresAffine };
      return;
    }
    const target = hit(world.x, world.y, Boolean(event.drillDown));
    if (!target) {
      drag = { mode: "select", startX: world.x, startY: world.y, currentX: world.x, currentY: world.y, startScreenX: event.x, startScreenY: event.y, marqueeStarted: false, initialSelection: event.shiftKey ? [...selectedIds] : [], additive: event.shiftKey };
      if (!event.shiftKey) selectedIds = [];
      render();
      emitViewState();
      return;
    }
    selectedIds = resolveCanvasObjectSelection(selectedIds, target.id, event.shiftKey);
    if (target && !event.readOnly) {
      const movable = movableSelectionIds(nodes, selectedIds);
      drag = { mode: "move", startX: world.x, startY: world.y, before: cloneDocument(), initial: new Set(nodes.filter((node) => movable.has(node.id)).map((node) => node.id)) };
    }
    render(); emitViewState(); return;
  }
  if (!drag) {
    if (event.event === "move") {
      const nextHoveredId = hit(world.x, world.y)?.id;
      if (nextHoveredId !== hoveredId) {
        hoveredId = nextHoveredId;
        render();
      }
    }
    return;
  }
  const activeDrag = drag;
  if (event.readOnly && activeDrag.mode !== "pan" && activeDrag.mode !== "select") {
    // A lease can expire mid-drag. Restore the pre-drag projection instead of
    // leaving an uncommitted visual move in a follower tab.
    if ((activeDrag.mode === "move" || activeDrag.mode === "resize" || activeDrag.mode === "line-resize" || activeDrag.mode === "multi-resize") && activeDrag.before) {
      nodes = activeDrag.before;
      transientSceneVersion += 1;
      rebuildNodeIndex();
      render();
      emitSnapshot(undefined, false);
    }
    if (event.event === "up") drag = undefined;
    return;
  }
  if (event.event === "move") {
    if (activeDrag.mode === "pan") { viewport.x += (event.x - activeDrag.startX) / viewport.zoom; viewport.y += (event.y - activeDrag.startY) / viewport.zoom; activeDrag.startX = event.x; activeDrag.startY = event.y; activateInteractiveRenderQuality(); render(); emitViewState(true); }
    if (activeDrag.mode === "select") {
      if (!activeDrag.marqueeStarted) {
        activeDrag.marqueeStarted = exceedsMarqueeDragThreshold(
          { x: activeDrag.startScreenX, y: activeDrag.startScreenY },
          { x: event.x, y: event.y },
        );
      }
      if (!activeDrag.marqueeStarted) return;
      updateMarqueeSelection(activeDrag, world.x, world.y);
      render();
      emitViewState();
    }
    if (activeDrag.mode === "draw" && activeDrag.node) {
      const end = snapCanvasPoint(world);
      if (activeDrag.node.kind === "line") {
        const dx = end.x - activeDrag.startX;
        const dy = end.y - activeDrag.startY;
        activeDrag.node.x = activeDrag.startX;
        activeDrag.node.y = activeDrag.startY;
        activeDrag.node.width = Math.max(4, Math.hypot(dx, dy));
        activeDrag.node.height = 0;
        activeDrag.node.rotation = Math.atan2(dy, dx) * 180 / Math.PI;
      } else {
        activeDrag.node.x = Math.min(activeDrag.startX, end.x);
        activeDrag.node.y = Math.min(activeDrag.startY, end.y);
        activeDrag.node.width = Math.max(4, Math.abs(end.x - activeDrag.startX));
        activeDrag.node.height = Math.max(4, Math.abs(end.y - activeDrag.startY));
      }
      render();
      renderNode(context!, activeDrag.node);
      renderTextCreationHighlight(context!, activeDrag.node);
    }
    if (activeDrag.mode === "move" && activeDrag.initial) {
      const dx = world.x - activeDrag.startX;
      const dy = world.y - activeDrag.startY;
      // A moved node's patch is resolved against the immutable pre-drag document
      // so the total delta is applied once per frame instead of compounding, and
      // so a Relative-v1 node's parent world transform stays stable. Legacy nodes
      // translate their world x/y; a Relative-v1 node (every grouped child and
      // every ungrouped former child) instead gets a fresh relativeTransform, the
      // only edit worldSpaceProjectionNode honours.
      const patches = new Map(activeDrag.before
        .filter((node) => activeDrag.initial?.has(node.id))
        .map((node) => [node.id, translateNodeWorldPatch(activeDrag.before, node.id, dx, dy, snapCanvasPoint)] as const)
        .filter((entry): entry is readonly [string, NonNullable<(typeof entry)[1]>] => Boolean(entry[1])));
      // Rebuild from pointer-down for every frame. `refreshTransientGroupBounds`
      // rebases the Group and its siblings, so layering this frame's child patch
      // onto the previous normalized scene mixes two local coordinate systems
      // and makes a deeply selected child lag or drift away from the cursor.
      nodes = activeDrag.before.map((node) => patches.has(node.id) ? { ...node, ...patches.get(node.id)! } : node);
      const directlyMovedGroups = new Set(activeDrag.before.filter((node) => node.kind === "group" && activeDrag.initial?.has(node.id)).map((node) => node.id));
      refreshTransientGroupBounds(directlyMovedGroups);
      transientSceneVersion += 1;
      rebuildNodeIndex();
      render();
    }
    if (activeDrag.mode === "resize") {
      const geometry = resizeGeometryForCanvasNode(activeDrag.node, activeDrag.handle, activeDrag.start, world, event.shiftKey, event.altKey);
      if (geometry) {
        nodes = nodes.map((node) => node.id === activeDrag.id ? { ...node, ...geometry } : node);
        transientSceneVersion += 1;
        rebuildNodeIndex();
        render();
      }
    }
    if (activeDrag.mode === "line-resize") {
      const geometry = resizeLineForCanvasNode(activeDrag.node, activeDrag.endpoint, world);
      if (geometry) {
        nodes = nodes.map((node) => node.id === activeDrag.id ? { ...node, ...geometry } : node);
        transientSceneVersion += 1;
        rebuildNodeIndex();
        render();
      }
    }
    if (activeDrag.mode === "multi-resize") {
      const delta = { x: world.x - activeDrag.start.x, y: world.y - activeDrag.start.y };
      const bounds = !event.shiftKey && !event.altKey
        ? resizeGeometryFromCornerWithFlip(activeDrag.bounds, activeDrag.handle, delta)
        : (event.altKey ? resizeGeometryFromCenter : resizeGeometryFromCorner)(activeDrag.bounds, activeDrag.handle, delta, undefined, event.shiftKey);
      const sourceNodes = activeDrag.before.filter((node) => activeDrag.ids.includes(node.id));
      const patches = activeDrag.requiresAffine
        ? scaleSelectionTransforms(activeDrag.before, activeDrag.ids, activeDrag.bounds, bounds)
        : scaleLegacySelectionGeometry(sourceNodes, activeDrag.bounds, bounds);
      if (patches) {
        nodes = activeDrag.before.map((node) => patches.has(node.id) ? { ...node, ...patches.get(node.id)! } : node);
        // Scaling a selected Group changes child world transforms; immediately
        // derive its local Bounds so the Group record, selection box and Badge
        // all describe the same transient geometry.
        refreshTransientGroupBounds();
        transientSceneVersion += 1;
        rebuildNodeIndex();
        render();
      }
    }
  }
  if (event.event === "up") {
    if (activeDrag.mode === "select") {
      const marqueeStarted = activeDrag.marqueeStarted || exceedsMarqueeDragThreshold(
        { x: activeDrag.startScreenX, y: activeDrag.startScreenY },
        { x: event.x, y: event.y },
      );
      if (marqueeStarted) updateMarqueeSelection(activeDrag, world.x, world.y);
      drag = undefined;
      render();
      emitViewState();
      return;
    }
    if (activeDrag.mode === "draw" && activeDrag.node) { dispatch({ type: "create", node: activeDrag.node }); }
    if (activeDrag.mode === "move" && activeDrag.before) {
      // Resolve every moved node against the immutable pre-drag document. Legacy
      // nodes yield an x/y patch; a Relative-v1 node (grouped child, ungrouped
      // former child) yields a fresh relativeTransform, so the gesture commits as
      // one atomic update batch that emits UpdateGeometry + SetAppearance exactly
      // like resize. move_nodes only ever wrote x/y and silently dropped a
      // relativeTransform, which is why grouped/ungrouped nodes appeared frozen.
      // `nodes` is the normalized transient scene: when a child moved inside a
      // Group it includes the Group + sibling matrix rebases required to keep
      // every untouched child visually fixed. Persist that complete derived
      // result in the same transaction as the drag, rather than committing only
      // the pointer target and letting the next Core projection snap it back.
      const moveCommands = nodes.flatMap((after) => {
        const before = activeDrag.before.find((node) => node.id === after.id);
        if (!before || (
          before.x === after.x && before.y === after.y && before.width === after.width && before.height === after.height
          && before.rotation === after.rotation && JSON.stringify(before.relativeTransform) === JSON.stringify(after.relativeTransform)
        )) return [];
        return [{
          type: "update" as const,
          id: after.id,
          patch: { x: after.x, y: after.y, width: after.width, height: after.height, rotation: after.rotation, relativeTransform: after.relativeTransform },
        }];
      });
      const moved = activeDrag.before.some((node) => activeDrag.initial?.has(node.id) && (
        node.x !== nodes.find((candidate) => candidate.id === node.id)?.x
        || node.y !== nodes.find((candidate) => candidate.id === node.id)?.y
        || JSON.stringify(node.relativeTransform) !== JSON.stringify(nodes.find((candidate) => candidate.id === node.id)?.relativeTransform)
      ));
      // A normal click selects an object and creates a move drag boundary, but
      // it must not mint a no-op transaction or remote Operation on pointer-up.
      if (!moved) { drag = undefined; render(); emitViewState(); return; }
      if (wasmDocument) {
        try {
          const baseRevision = Number(wasmDocument.revision);
          const moveTransactionId = crypto.randomUUID();
          const resolved = resolveCoreBatch(activeDrag.before, moveCommands);
          if (!resolved) { emitError(undefined, "TRANSIENT"); drag = undefined; nodes = activeDrag.before; transientSceneVersion += 1; rebuildNodeIndex(); render(); emitSnapshot(); return; }
          wasmDocument.apply_transaction_json(moveTransactionId, wasmDocument.revision, JSON.stringify(resolved.batch));
          recordHistory("core");
          syncProjectionFromWasm();
          render();
          emitSnapshot(journalEntry({ type: "restore-core", coreSnapshot: wasmDocument.snapshot_json() }, baseRevision, moveTransactionId));
          queueRemoteOperation(moveTransactionId, baseRevision, resolved.batch, wasmDocument.canonical_hash());
        } catch (error) {
          nodes = activeDrag.before;
          transientSceneVersion += 1;
          rebuildNodeIndex();
          emitError(error);
          render();
          emitSnapshot();
        }
      } else { history.push({ nodes: activeDrag.before, advancesRevision: true }); recordHistory("local"); revision += 1; render(); emitSnapshot(); }
    }
    if (activeDrag.mode === "resize") {
      const resized = nodes.find((node) => node.id === activeDrag.id);
      const geometry = resized && { x: resized.x, y: resized.y, width: resized.width, height: resized.height, rotation: resized.rotation, relativeTransform: resized.relativeTransform };
      const before = { x: activeDrag.node.x, y: activeDrag.node.y, width: activeDrag.node.width, height: activeDrag.node.height };
      // While dragging we only project temporary geometry. Restore the exact
      // pre-gesture state before dispatching so Rust receives one UpdateGeometry
      // transaction and can atomically propagate Frame constraints.
      nodes = activeDrag.before;
      transientSceneVersion += 1;
      rebuildNodeIndex();
      if (geometry && (hasCommittedResize(before, geometry) || activeDrag.node.rotation !== geometry.rotation || JSON.stringify(activeDrag.node.relativeTransform) !== JSON.stringify(geometry.relativeTransform))) dispatch({ type: "update", id: activeDrag.id, patch: geometry });
      else { render(); emitViewState(); }
    }
    if (activeDrag.mode === "line-resize") {
      const resized = nodes.find((node) => node.id === activeDrag.id);
      const geometry = resized && { x: resized.x, y: resized.y, width: resized.width, rotation: resized.rotation, relativeTransform: resized.relativeTransform };
      nodes = activeDrag.before;
      transientSceneVersion += 1;
      rebuildNodeIndex();
      if (geometry && (hasCommittedLineEndpointResize(activeDrag.node, geometry) || JSON.stringify(activeDrag.node.relativeTransform) !== JSON.stringify(geometry.relativeTransform))) dispatch({ type: "update", id: activeDrag.id, patch: geometry });
      else { render(); emitViewState(); }
    }
    if (activeDrag.mode === "multi-resize") {
      const nextNodes = nodes;
      const beforeById = new Map(activeDrag.before.filter((node) => activeDrag.ids.includes(node.id)).map((node) => [node.id, { x: node.x, y: node.y, width: node.width, height: node.height }]));
      const afterById = new Map(nextNodes.filter((node) => activeDrag.ids.includes(node.id)).map((node) => [node.id, { x: node.x, y: node.y, width: node.width, height: node.height }]));
      const affinePatches = new Map(nextNodes.filter((node) => activeDrag.ids.includes(node.id)).map((node) => [node.id, ({ x: node.x, y: node.y, width: node.width, height: node.height, rotation: node.rotation, relativeTransform: node.relativeTransform }) satisfies SelectionTransformPatch]));
      const derivedCommands = nextNodes.flatMap((after) => {
        const before = activeDrag.before.find((node) => node.id === after.id);
        if (!before || (
          before.x === after.x && before.y === after.y && before.width === after.width && before.height === after.height
          && before.rotation === after.rotation && JSON.stringify(before.relativeTransform) === JSON.stringify(after.relativeTransform)
        )) return [];
        return [{ type: "update" as const, id: after.id, patch: { x: after.x, y: after.y, width: after.width, height: after.height, rotation: after.rotation, relativeTransform: after.relativeTransform } }];
      });
      nodes = activeDrag.before;
      transientSceneVersion += 1;
      rebuildNodeIndex();
      if (!(activeDrag.requiresAffine ? hasCommittedSelectionTransform(activeDrag.before, affinePatches) : hasCommittedSelectionResize(beforeById, afterById))) { render(); emitViewState(); }
      else if (wasmDocument) {
        dispatchTransaction({
          id: crypto.randomUUID(),
          baseRevision: Number(wasmDocument.revision),
          commands: activeDrag.requiresAffine ? derivedCommands : activeDrag.ids.map((id) => ({ type: "update" as const, id, patch: afterById.get(id)! })),
        });
      } else {
        nodes = nextNodes;
        refreshTransientGroupBounds();
        history.push({ nodes: activeDrag.before, advancesRevision: true });
        recordHistory("local");
        revision += 1;
        rebuildNodeIndex();
        render();
        emitSnapshot();
      }
    }
    drag = undefined;
  }
}
function applyWheel(event: Extract<MainToWorker, { type: "wheel" }>) {
  if (event.ctrlKey) { const before = toWorld(event.x, event.y); viewport.zoom = clampCanvasZoom(viewport.zoom * (event.deltaY > 0 ? .9 : 1.1)); const after = toWorld(event.x, event.y); viewport.x += after.x - before.x; viewport.y += after.y - before.y; }
  else { viewport.x -= event.deltaX / viewport.zoom; viewport.y -= event.deltaY / viewport.zoom; }
}
function wheel(event: Extract<MainToWorker, { type: "wheel" }>) {
  applyWheel(event);
  activateInteractiveRenderQuality();
  render(); emitViewState(true);
}
function dispatchInputBatch(events: readonly Extract<MainToWorker, { type: "pointer" | "wheel" }>[]) {
  const occurredAt = events.reduce<number | undefined>((latest, event) => Number.isFinite(event.occurredAt) && event.occurredAt! >= 0 && (latest === undefined || event.occurredAt! > latest) ? event.occurredAt : latest, undefined);
  if (events.length && events.every((event) => event.type === "wheel")) {
    events.forEach(applyWheel);
    activateInteractiveRenderQuality();
    render(1);
    emitViewState(true);
    recordInputToRenderLatency(occurredAt);
    return;
  }
  events.forEach((event) => { if (event.type === "pointer") pointer(event); else wheel(event); });
  recordInputToRenderLatency(occurredAt);
}

/** Epoch milliseconds work across Window/Worker performance time origins.
 * Reject impossible values so malformed transfer data cannot poison evidence. */
function recordInputToRenderLatency(occurredAt: number | undefined) {
  if (occurredAt === undefined) return;
  const elapsed = Date.now() - occurredAt;
  if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 10_000) renderPerformance.recordInputToRender(elapsed);
}
self.onmessage = ({ data }: MessageEvent<MainToWorker>) => {
  try {
    if (data.type === "init") { documentId = data.documentId ?? documentId; canvas = data.canvas; rendererPreference = data.rendererPreference; simulatedGpuLossesRequested = Math.min(2, Math.max(0, data.simulateGpuLosses)); simulateGpuLossAfterImage = data.simulateGpuLossAfterImage; simulatedGpuFault = data.simulateGpuFault; simulatedGpuFaultReported = false; context = canvas.getContext("2d"); setRenderSurface(data.width, data.height, data.dpr); diagnostics.record({ category: "lifecycle", code: "ENGINE_WORKER_READY" }); render(); emit({ type: "ready" }); emitSnapshot(); void loadDocumentBridge(); void probeGpuDevice(); }
    else if (data.type === "resize") { if (setRenderSurface(data.width, data.height, data.dpr)) render(); }
    else if (data.type === "tool") { tool = data.tool; }
    else if (data.type === "checkpoint") emitViewportCheckpoint();
    else if (data.type === "remote-bootstrap") {
      remoteBootstrapPending = true;
      if (documentCore === "Rust/WASM bridge ready") emitRemoteBootstrap();
    }
    else if (data.type === "remote-hydrate") hydrateRemoteSnapshot(data.snapshot);
    else if (data.type === "remote-reconcile") void reconcileRemoteSnapshot(data.snapshot, data.operations);
    else if (data.type === "register-asset") registerAsset(data.transactionId, data.asset);
    else if (data.type === "asset-bytes") seedAssetBytes(data.assetId, data.mediaType, data.bytes, data.decodedBitmap);
    else if (data.type === "editing-text") { editingTextNodeId = data.nodeId; render(); }
    else if (data.type === "text-caret-layout") void emitRustTextCaretLayout(data);
    else if (data.type === "simulate-crash") {
      setTimeout(() => { throw new Error("Development-only Engine Worker crash simulation"); }, 0);
    }
    else if (data.type === "command") dispatch(data.command);
    else if (data.type === "transaction") dispatchTransaction(data.transaction);
    else if (data.type === "input") {
      const events = decodeInputBatch(data.buffer);
      if (!events) {
        diagnostics.record({ category: "lifecycle", code: "INPUT_TRANSFER_REJECTED" });
        emitError(undefined, "INVALID_COMMAND");
      } else dispatchInputBatch(events);
    }
    else if (data.type === "pointer") pointer(data);
    else if (data.type === "wheel") wheel(data);
    else if (data.type === "key") {
      if (data.key === "Enter" && !data.metaKey && !data.shiftKey) {
        const node = createKeyboardToolNode({ tool, viewport, surface: { width, height } });
        if (node) {
          dispatch({ type: "create", node });
          return;
        }
      }
      const command = editorKeyCommand({ ...data, selectedIds, selectedKinds: selectedIds.map((id) => nodes.find((node) => node.id === id)?.kind) });
      if (command) dispatch(command);
    }
  } catch (error) { emitError(error); }
};
