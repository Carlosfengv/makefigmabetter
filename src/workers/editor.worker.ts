/// <reference lib="webworker" />

import type { CanvasNode, CanvasPage, CoreJournalOperation, CoreLocalSnapshot, DocumentAsset, DocumentFontReference, EditorClipboard, EditorCommand, EditorSnapshot, LocalJournalEntry, MainToWorker, PendingOperationReplay, PendingRemoteOperation, PresentationNode, RendererPreference, SimulatedGpuFault, ToolKind, Viewport, WorkerToMain } from "@/lib/editor-protocol";
import { createDiagnosticRecorder } from "@/lib/diagnostics";
import { createCooperativeYield } from "@/lib/cooperative-yield";
import { findTopmostCanvasSelectionCandidate, findTopmostHit } from "@/lib/hit-test";
import { createRenderPerformanceSampler } from "@/lib/performance-sampling";
import { admitRenderSurface, MAX_RENDER_SURFACE_BYTES } from "@/lib/render-surface-budget";
import { admitAlphaMaskSurface } from "@/lib/alpha-mask-budget";
import { admitEffectSurfacePool } from "@/lib/effect-surface-budget";
import { morphAlphaChannel } from "@/lib/alpha-morphology";
import { compositeEffectSurface } from "@/lib/canvas-effect-composite";
import { assessWasmHeap, MAX_WASM_HEAP_BYTES } from "@/lib/wasm-heap-budget";
import { createId, createNode, DEFAULT_TEXT_LINE_HEIGHT, documentColorFromCssHex } from "@/lib/editor-protocol";
import { colorToSrgbCss, sampleLinearGradientForCanvas } from "@/lib/color-rendering";
import { layoutTextRanges, resolveTextRenderMetrics } from "@/lib/text-layout";
import { styledTextSpans, styledTextVisualSpans, type RenderTextStyle } from "@/lib/text-style-runs";
import { classifyWebGpuRendererFailure, GpuSceneResourceLimitError, MAX_GPU_EFFECT_TEXTURE_BYTES, MAX_GPU_SCENE_RESOURCE_BYTES, WebGpuSceneRenderer, type WebGpuTextGlyph } from "@/lib/webgpu-scene";
import { decodeInputBatch } from "@/lib/input-transfer";
import { autoLayoutProjectionNormalizationPatches, captureClipboard, normalizeAutoLayoutProjection, resolveCoreBatch, resolveFlattenBooleanBatch, resolveLineOutlineStrokeBatch, resolveOutlineStrokeBatch, resolveParametricShapeToVectorBatch, resolvePasteBatch, type CoreBatchCommand, type CoreProjectionNode } from "@/lib/transaction-batch";
import { validateClipboardCapture } from "@/lib/editor-clipboard";
import { resolveFigmaRestAssetBindings, resolveFigmaRestImportBatch } from "@/lib/figma-rest-import";
import { encodeCoreBatchPayload, encodeCreatePagePayload, encodeOperationPayloadEnvelope, encodeRegisterResourcePayload } from "@/lib/protocol-operation-codec";
import { sha256Bytes } from "../lib/sha256";
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
import { gpuLayerPrefix, requiresCanvasEffectOrBlend } from "@/lib/gpu-layer-prefix";
import { exceedsMarqueeDragThreshold, lineSelectionBounds, marqueeRect, resolveMarqueeSelection, rotatedNodeBounds } from "@/lib/marquee-selection";
import { resolveMultiResizeSelection, type MultiResizeSelection } from "@/lib/multi-selection";
import { worldLineVisualBounds } from "@/lib/line-world-bounds";
import { selectionDimensions } from "@/lib/selection-label";
import { resolveCanvasObjectSelection, resolveNestedKeyboardTarget, resolveNestedSelectionTarget } from "@/lib/canvas-selection";
import { normalizePageSelection } from "@/lib/page-selection";
import { withManualAutoLayoutSizing } from "@/lib/auto-layout-sizing";
import { movableSelectionIds } from "@/lib/selection-move-roots";
import { resolveSelectionNudge } from "@/lib/selection-nudge";
import { resolveArrangeCommand } from "@/lib/arrange";
import { boundsIntersect, viewportWorldBounds } from "@/lib/scene-visibility";
import { createSpatialGridIndex } from "@/lib/spatial-grid";
import { renderDpr, resolveRenderQuality, vectorPresentationTolerance, type RenderQualityState } from "@/lib/render-quality";
import { canvasDesignTokens, canvasFont } from "@/lib/canvas-design-tokens";
import { showsPersistentCanvasLayerName } from "@/lib/canvas-layer-name";
import { cacheAsset, readCachedAsset } from "@/lib/asset-byte-cache";
import { ImageBitmapCache } from "@/lib/image-bitmap-cache";
import { decodeRasterInWorker } from "@/lib/asset-decode-client";
import { MAX_RASTER_DECODED_BYTES } from "@/lib/untrusted-asset";
import { FontFaceRegistry } from "@/lib/font-face-registry";
import { fontVariationCss } from "@/lib/font-variation-axes";
import { documentFontFamilyChain } from "@/lib/document-font-family-chain";
import { cssLineBoxBaseline as resolveCssLineBoxBaseline } from "@/lib/text-baseline";
import { parseRustGpuSceneBatch } from "@/lib/rust-gpu-batch";
import { hasMissingRustTextGlyph, parseRustTextLayout, type RustTextLayout, type RustTextVisualRun } from "@/lib/rust-text-layout";
import { textFrozenLayoutFace } from "@/lib/text-svg-layout-input";
import { parseRustTextCaretLayout } from "@/lib/rust-text-caret";
import { parseRustGlyphRaster } from "@/lib/rust-glyph-raster";
import { parseRustRenderGraphPlan, type RustRenderGraphPlan } from "@/lib/rust-render-graph";
import { projectGpuTextGlyphs } from "@/lib/gpu-text-projection";
import { hasCommittedResize, isCornerResizeHandle, resizeGeometryFromCenter, resizeGeometryFromCorner, resizeGeometryFromCornerWithFlip, resizeRotatedLegacyGeometry, type CanvasResizeHandle, type ResizeGeometry } from "@/lib/canvas-resize";
import { resizeRelativeTransformFromWorldGesture } from "@/lib/relative-transform-resize";
import { hasCommittedLineEndpointResize, lineEndpoints, resizeLegacyLineEndpoint, type LineEndpoint } from "@/lib/line-endpoint-resize";
import { resizeRelativeLineEndpointFromWorldGesture } from "@/lib/relative-line-endpoint-resize";
import { editorKeyCommand, keyboardNudgeDelta, shouldClearCanvasSelection } from "@/lib/editor-key-command";
import { isEffectivelyLocked } from "@/lib/hierarchy-lock";
import { createKeyboardToolNode } from "@/lib/keyboard-node-create";
import { solidLineStrokeOutline } from "@/lib/line-stroke-outline";
import { decorativeCapMesh, isDecorativeCap } from "@/lib/decorative-cap-mesh";
import { hasCommittedSelectionResize, scaleLegacySelectionGeometry } from "@/lib/selection-resize";
import { hasCommittedSelectionTransform, scaleSelectionTransforms, type SelectionTransformPatch } from "@/lib/selection-transform-resize";
import { parametricShapePoints as fallbackParametricShapePoints } from "@/lib/parametric-shape";
import { traceShapeWithTextDecorations, traceShapeWithTextPath } from "@/lib/shape-with-text-path";
import { layoutTextPath } from "@/lib/text-path-layout";
import { connectorDecorationTriangles, connectorEndpointDecorations, connectorLabelLayout } from "@/lib/connector-presentation";
import { affineScreenMatrix, transformGroupRepeatMatrices } from "@/lib/transform-group-repeat";
import { traceVectorPath } from "@/lib/vector-path";
import { rotateSelectionAroundWorldPoint, type SelectionRotationPatch } from "@/lib/selection-rotation";
import { wasmHydrationBatches } from "@/lib/wasm-hydration-batches";
import { orderNewLayerAtFront, sortNodesByLayerOrder } from "@/lib/layer-order";
import { planPendingOperationReconciliation } from "@/lib/pending-operation-reconciliation";
import { rebaseCoreBatchForSnapshot } from "@/lib/rebase-core-batch";
import { fullStateReplayBatch, historyReplayBatch } from "@/lib/history-replay-batch";
import { canvasNodeFromWasmProjection } from "@/lib/wasm-projection-node";
import { visibleNodesOnPage } from "@/lib/hierarchy-visibility";
import { fitViewportToBounds, isSameRenderedViewport, pageContentBounds, selectCoveringViewportFrame } from "@/lib/page-viewport";
import { isFullyClippedForSelection } from "@/lib/selection-clip";
import { invertAffine, multiplyAffine, nodePropsForWorldTransform, normalizeGroupBounds, transformPoint, translateNodeWorldPatch, worldBoundsForTransform, worldSpaceProjectionNodes, worldTransformForNode, worldTransformsForNodes, type AffineMatrix } from "@/lib/scene-transform";
import { worldVisualBoundsForNode } from "@/lib/world-visual-bounds";
import { closedShapeStrokeLocalBounds } from "@/lib/closed-shape-stroke-bounds";
import { ellipseStrokeRing } from "@/lib/ellipse-stroke-ring";
import { frameDropTargetAtPoint, frameExitTargetAtPoint } from "@/lib/frame-drop-target";
import { autoLayoutArrowReorder, autoLayoutDropReorder } from "@/lib/auto-layout-reorder";
import { joinCrossVectorEndpoints } from "@/lib/vector-cross-connect";
import { compileScene, findTopmostSceneHit, sceneNodesInPaintOrder } from "@/runtime/scene-compiler";
import { specialNodeFallback } from "@/lib/special-node-fallback";
import { connectorPathForNode, traceConnectorPath } from "@/lib/connector-path";
import { DEFAULT_PAGE_ID, migrateLegacyFigmaBootstrapPage } from "@/lib/document-bootstrap";

declare const self: DedicatedWorkerGlobalScope;

type Drag =
  | { mode: "draw"; startX: number; startY: number; node: CanvasNode }
  | { mode: "move"; startX: number; startY: number; currentX: number; currentY: number; before: CanvasNode[]; initial: Set<string>; dropTargetId?: string }
  | { mode: "resize"; id: string; handle: CanvasResizeHandle; start: { x: number; y: number }; node: CanvasNode; before: CanvasNode[] }
  | { mode: "multi-resize"; handle: CanvasResizeHandle; start: { x: number; y: number }; bounds: ResizeGeometry; before: CanvasNode[]; ids: string[]; requiresAffine: boolean }
  | { mode: "rotate"; start: { x: number; y: number }; pivot: { x: number; y: number }; before: CanvasNode[]; ids: string[] }
  | { mode: "line-resize"; id: string; endpoint: LineEndpoint; node: CanvasNode; before: CanvasNode[] }
  | { mode: "vector-point"; id: string; pointId: string; before: CanvasNode[] }
  | { mode: "vector-handle"; id: string; pointId: string; handle: "handleIn" | "handleOut"; before: CanvasNode[] }
  | { mode: "pen-point"; id: string; pointId: string; start: { x: number; y: number } }
  | { mode: "pan"; startX: number; startY: number }
  | { mode: "select"; startX: number; startY: number; currentX: number; currentY: number; startScreenX: number; startScreenY: number; marqueeStarted: boolean; initialSelection: string[]; additive: boolean };
type VectorPoint = NonNullable<CanvasNode["vectorPath"]>["subpaths"][number]["points"][number];
type PenCommitCommand = Extract<EditorCommand, { type: "insertVectorPoint" | "setVectorSubpathClosed" | "connectVectorEndpoints" }>;
type PenConnectTarget =
  | { kind: "same-vector"; subpathIndex: number; pointId: string }
  | { kind: "cross-vector"; nodeId: string; subpathIndex: number; pointId: string };
type PenDraft = {
  kind: "create" | "extend";
  node: CanvasNode;
  lastPointId: string;
  previousSelection: string[];
  originalVectorPath?: NonNullable<CanvasNode["vectorPath"]>;
  subpathIndex?: number;
  endpoint?: "start" | "end";
  insertedPoints: VectorPoint[];
  closeOnFinish?: boolean;
  connectTarget?: PenConnectTarget;
  // Cursor-only geometry for the next Pen segment. It deliberately lives
  // outside the canonical VectorPath: moving the pointer must not create a
  // transaction, alter undo history, or leak an unfinished point to peers.
  previewWorld?: { x: number; y: number };
};
type WasmProjectionNode = CoreProjectionNode;
type WasmProjectionSnapshot = { schemaVersion: number; documentId?: string; revision: number; canUndo: boolean; canRedo: boolean; canonicalHash?: string; pages?: CanvasPage[]; resourceIndex?: DocumentAsset[]; nodes: WasmProjectionNode[]; retiredIds?: string[] };
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
  create_page_at_position(transactionId: string, baseRevision: bigint, pageId: string, name: string, positionId: string): bigint;
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
  seed_assets_json(value: string): void;
};
type WasmRuntime = typeof import("@/wasm/generated/editor_wasm");

let canvas: OffscreenCanvas | undefined;
const defaultPageId = DEFAULT_PAGE_ID;
let pages: CanvasPage[] = [{ id: defaultPageId, name: "Page 1", positionId: "00000000000000000000000000000001:00000000000000000000000000000000" }];
let activePageId = defaultPageId;
let context: OffscreenCanvasRenderingContext2D | null = null;
let width = 0;
let height = 0;
let dpr = 1;
let deviceDpr = 1;
let renderQuality: RenderQualityState = { tier: "settled", zoomBucket: "normal" };
let renderQualityTimer: ReturnType<typeof setTimeout> | undefined;
let renderVisible = true;
let progressivePaintGeneration = 0;
let progressivePaintKey: string | undefined;
let completedProgressivePaintKey: string | undefined;
let progressivePaintCompletion: Promise<void> | undefined;
let resolveProgressivePaintCompletion: (() => void) | undefined;
function finishProgressivePaint() {
  progressivePaintKey = undefined;
  progressivePaintCompletion = undefined;
  resolveProgressivePaintCompletion?.();
  resolveProgressivePaintCompletion = undefined;
}
let presentedPageId: string | undefined;
let presentedSurfaceWidth = 0;
let presentedSurfaceHeight = 0;
let cachedPresentedFrame: OffscreenCanvas | undefined;
let cachedPresentedFramePageId: string | undefined;
let cachedPresentedFrameSceneKey: string | undefined;
let cachedPresentedFrameViewport: Viewport | undefined;
let cachedPresentedFrameSurfaceWidth = 0;
let cachedPresentedFrameSurfaceHeight = 0;
let cachedOverviewFrame: {
  canvas: OffscreenCanvas;
  sceneKey: string;
  viewport: Viewport;
  width: number;
  height: number;
} | undefined;
// The offscreen Canvas is presented by `render()` itself. Publishing every
// wheel sample back to React makes the UI message queue part of the input path
// and can starve subsequent wheel events despite an already completed render.
// Keep inspector/caption state fresh during a gesture, then publish the exact
// settled viewport once the quality timer fires.
const INTERACTIVE_VIEW_STATE_INTERVAL_MS = 50;
let lastInteractiveViewStateAt = Number.NEGATIVE_INFINITY;
let tool: ToolKind = "select";
let nodes: CanvasNode[] = [];
/** A Pen gesture remains projection-only until Enter or closing the subpath,
 * so each completed path becomes one canonical Create history item. */
let penDraft: PenDraft | undefined;
let assets: DocumentAsset[] = [];
/** The Worker-owned copy/cut clipboard. It carries subtree projections by value
 * and image references by AssetId only (never raw bytes), so paste re-validates
 * against the target document's Resource Index (P0-1). */
/** The durable projection version last emitted by the Core. It stamps the
 * clipboard so a stale cross-tab payload can be rejected on paste (P0-1). */
let documentSchemaVersion = 19;
let clipboard: EditorClipboard | undefined;
let clipboardSourceDocumentId: string | undefined;
let pasteInFlight = false;
const imageBitmaps = new ImageBitmapCache<ImageBitmap>(MAX_RASTER_DECODED_BYTES);
const imageLoads = new Set<string>();
const fontFaces = new FontFaceRegistry();
let nodeById = new Map(nodes.map((node) => [node.id, node]));
let nodeBoundsById = new Map(nodes.map((node) => [node.id, boundsForNode(node)]));
let worldTransformById = worldTransformsForNodes(nodes);
let spatialGrid = createSpatialGridIndex(nodes, (node) => nodeBoundsById.get(node.id) ?? boundsForNode(node));
let selectedIds: string[] = nodes[0] ? [nodes[0].id] : [];
/** Page owns the transient selection. It is deliberately not Canonical state,
 * history, or a collaboration operation. */
const selectionByPage = new Map<string, string[]>();
/** Vector anchor selection is transient editing state, never Canonical data. */
let selectedVectorPoints: Array<{ id: string; pointId: string }> = [];
let viewport = { x: 0, y: 0, zoom: 1 };
/** View position belongs to a page, not the document. A newly visited page is
 * fitted once; subsequent visits restore the user's last pan and zoom. */
const viewportByPage = new Map<string, Viewport>();
type LocalHistoryEntry = { nodes: CanvasNode[]; advancesRevision: boolean };
const history: LocalHistoryEntry[] = [];
let future: LocalHistoryEntry[] = [];
type HistoryKind = "core" | "local";
const undoOrder: HistoryKind[] = [];
let redoOrder: HistoryKind[] = [];
const preservedProjectionNodes = new Map<string, PresentationNode>();
let revision = 0;
/** M4A's shared derived scene. It is rebuilt with the node/spatial indexes and
 * never enters a Snapshot, transaction, Canonical hash or collaboration wire. */
let compiledScene: ReturnType<typeof compileScene> | undefined;
let compiledSceneFallbackSignature = "";
let documentId = "00000000-0000-0000-0000-000000000000";
let drag: Drag | undefined;
let hoveredId: string | undefined;
let editingTextNodeId: string | undefined;
let documentCore: EditorSnapshot["documentCore"] = "Starting Rust/WASM bridge";
let wasmDocument: WasmDocumentEngine | undefined;
let bridgeLoadSequence = 0;
let hydrationCompletionRequestId: string | undefined;
let ephemeralBenchmarkProjection = false;
let remoteBootstrapPending = false;
let remoteResetPending = false;
const localDevActorId = "00000000-0000-0000-0000-000000000007";
const assetApiUrl = new URL("/asset-api", self.location.origin).toString().replace(/\/$/, "");
const remoteSessionId = createId();
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
let gpuEffectTextureBytes = 0;
let gpuSceneWithinBudget = true;
let gpuSceneLimitReported = false;
let textAtlasStatsSignature = "";
let imageTextureStatsSignature = "";
let effectTextureStatsSignature = "";
let rustRenderGraphFailureSignature = "";
type RustGpuScene = { revision: number; pageId: string; transientSceneVersion: number; instances: Float32Array; renderedNodeIds: ReadonlySet<string> };
let rustGpuScene: RustGpuScene | undefined;
const MAX_RUST_GPU_INSTANCE_NODES = 20_000;
type RustTextLayoutProjection = { revision: number; key: string; layout: RustTextLayout };
const rustTextLayouts = new Map<string, RustTextLayoutProjection>();
const rustTextLayoutLoads = new Set<string>();
/** Explicit-font shaping cannot safely decide line breaks once browser font
 * fallback participates. Remember that expected fallback per revision so an
 * ordinary render does not repeatedly request the same unusable layout. */
const rustTextLayoutFallbacks = new Map<string, Omit<RustTextLayoutProjection, "layout">>();
type RustGpuTextProjection = { revision: number; key: string; glyphs: readonly WebGpuTextGlyph[] };
const rustGpuTextGlyphs = new Map<string, RustGpuTextProjection>();
const rustGpuTextLoads = new Set<string>();
const MAX_RUST_GPU_TEXT_GLYPHS_PER_NODE = 4_096;
const COMPLEX_DOCUMENT_NODE_THRESHOLD = 1_000;
const PROGRESSIVE_PAINT_BUDGET_MS = 6;
const PROGRESSIVE_PAINT_MAX_NODES = 24;
const progressivePaintTasks: Array<() => void> = [];
const progressivePaintTaskChannel = new MessageChannel();
progressivePaintTaskChannel.port1.onmessage = () => {
  progressivePaintTasks.shift()?.();
};
progressivePaintTaskChannel.port1.start();
function scheduleProgressivePaint(task: () => void) {
  progressivePaintTasks.push(task);
  progressivePaintTaskChannel.port2.postMessage(undefined);
}
let renderSurfaceBytes = 0;
let alphaMaskLimitReported = false;
let effectSurfaceLimitReported = false;
type EffectSurfaces = { source: OffscreenCanvas; sourceContext: OffscreenCanvasRenderingContext2D; shadow: OffscreenCanvas; shadowContext: OffscreenCanvasRenderingContext2D; scratch: OffscreenCanvas; scratchContext: OffscreenCanvasRenderingContext2D };
let effectSurfaces: EffectSurfaces | undefined;
type AlphaMaskSurface = { surface: OffscreenCanvas; context: OffscreenCanvasRenderingContext2D };
// A mask run only needs one surface at each live nesting depth. Reusing the
// pair avoids allocating a full-canvas bitmap for every masked sibling run on
// every frame, while retaining G4's two-level composition limit.
let alphaMaskSurfaces: Array<AlphaMaskSurface | undefined> = [];
let wasmMemory: WebAssembly.Memory | undefined;
let wasmRuntimePromise: Promise<typeof import("@/wasm/generated/editor_wasm")> | undefined;
let wasmRuntime: WasmRuntime | undefined;
let wasmHeapOverBudget = false;
type StrokeMeshPoint = Readonly<{ x: number; y: number }>;
type StrokeMeshTriangle = readonly [StrokeMeshPoint, StrokeMeshPoint, StrokeMeshPoint];
type StrokeMesh = readonly StrokeMeshTriangle[];
const canonicalStrokeMeshes = new Map<string, StrokeMesh | null>();
const canonicalPerSideStrokeMeshes = new Map<string, readonly StrokeMesh[] | null>();
const canonicalParametricOutlines = new Map<string, readonly StrokeMeshPoint[] | null>();
const canonicalParametricStrokeBounds = new Map<string, { min: StrokeMeshPoint; max: StrokeMeshPoint } | null>();
type FlattenedVectorPath = Readonly<{ subpaths: readonly { closed: boolean; points: readonly StrokeMeshPoint[] }[]; bounds?: { min: StrokeMeshPoint; max: StrokeMeshPoint } }>;
const canonicalVectorPaths = new Map<string, FlattenedVectorPath | null>();
const canonicalBooleanPaths = new Map<string, FlattenedVectorPath | null>();
// Drag positions are intentionally not committed to the document revision until
// pointer-up, but the GPU scene must still redraw them on every pointer move.
let transientSceneVersion = 0;
const diagnostics = createDiagnosticRecorder();
const renderPerformance = createRenderPerformanceSampler();

function cloneDocument() { return structuredClone(nodes); }
function storeActivePageSelection() {
  selectedIds = normalizePageSelection(nodes, activePageId, selectedIds, defaultPageId);
  selectionByPage.set(activePageId, [...selectedIds]);
}
/** Viewport-only updates can arrive once per input frame. Remembering the
 * already-normalized transient selection here avoids rebuilding a node index
 * during every pan, zoom, or hover repaint. Structural snapshots still call
 * `storeActivePageSelection` above. */
function rememberActivePageSelection() {
  selectionByPage.set(activePageId, [...selectedIds]);
}
function restorePageSelection(pageId: string) {
  selectedIds = normalizePageSelection(nodes, pageId, selectionByPage.get(pageId) ?? [], defaultPageId);
}
/** Undo/Redo replaces the Canonical projection, but it should not make a
 * surviving layer disappear from the editor's keyboard selection. Structural
 * changes still naturally drop IDs that no longer exist on the active page. */
function retainExistingSelection() {
  const currentIds = new Set(nodes
    .filter((node) => (node.pageId ?? defaultPageId) === activePageId)
    .map((node) => node.id));
  selectedIds = selectedIds.filter((id) => currentIds.has(id));
}
function scaleVectorPath(path: NonNullable<CanvasNode["vectorPath"]>, scaleX: number, scaleY: number): NonNullable<CanvasNode["vectorPath"]> {
  return {
    ...path,
    subpaths: path.subpaths.map((subpath) => ({
      ...subpath,
      points: subpath.points.map((point) => ({
        ...point,
        x: point.x * scaleX,
        y: point.y * scaleY,
        handleIn: point.handleIn && { x: point.handleIn.x * scaleX, y: point.handleIn.y * scaleY },
        handleOut: point.handleOut && { x: point.handleOut.x * scaleX, y: point.handleOut.y * scaleY },
      })),
    })),
  };
}
function activeNodes() {
  const visible = visibleNodesOnPage(nodes, activePageId, defaultPageId);
  const projected = sortNodesByLayerOrder(visible.map((node) => nodeById.get(node.id) ?? node));
  // Every backend starts with the Scene Compiler's display list. The local
  // sort is retained solely as the cold-start/stale-IR fallback inside
  // sceneNodesInPaintOrder; it may not define a different render order.
  return sceneNodesInPaintOrder(compiledScene?.scene, projected);
}
function rememberActivePageViewport() {
  viewportByPage.set(activePageId, { ...viewport });
}
function restoreOrFitPageViewport(pageId: string) {
  const remembered = viewportByPage.get(pageId);
  viewport = remembered
    ? { ...remembered }
    : fitViewportToBounds(pageContentBounds(nodes, pageId, defaultPageId), { width, height });
  viewportByPage.set(pageId, { ...viewport });
}
/** A projected legacy node can continue through the fast Canvas/GPU paths.
 * Skew and reflection intentionally retain their local geometry, so this pass
 * applies the exact world affine directly to Canvas instead of decomposing it.
 */
function nativeAffineForNode(node: CanvasNode): AffineMatrix | undefined {
  return node.relativeTransform ? worldTransformById.get(node.id) : undefined;
}
function isFrameLike(node: CanvasNode | undefined) {
  return node?.kind === "frame" || node?.kind === "component" || node?.kind === "instance" || node?.kind === "slot" || node?.kind === "componentSet";
}
function boundsForNode(node: CanvasNode) {
  if (node.kind === "line" || node.kind === "connector") {
    const visual = worldLineVisualBounds(nodes, node);
    if (visual) return { x: visual.left, y: visual.top, width: visual.right - visual.left, height: visual.bottom - visual.top };
  }
  const alignedClosedShape = (node.kind === "ellipse" && !node.arcData) || isFrameLike(node) || node.kind === "rectangle";
  if (alignedClosedShape && (node.strokeAlign ?? "inside") !== "inside" && node.strokeWidth > 0) {
    const visual = worldVisualBoundsForNode(nodes, node);
    if (visual) return { x: visual.left, y: visual.top, width: visual.right - visual.left, height: visual.bottom - visual.top };
  }
  if (node.kind === "vector") {
    const vectorBounds = canonicalVectorPath(node)?.bounds;
    if (vectorBounds) return worldVectorBounds(node, vectorBounds);
  }
  if ((node.kind === "polygon" || node.kind === "star") && node.parametricShape) {
    const bounds = canonicalParametricVisualBounds(node);
    if (bounds) return worldVectorBounds(node, bounds);
  }
  const affine = nativeAffineForNode(node);
  const bounds = affine ? worldBoundsForTransform(node, affine) : undefined;
  return bounds ? { x: bounds.left, y: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top } : rotatedNodeBounds(node);
}
function worldVectorBounds(node: CanvasNode, bounds: NonNullable<FlattenedVectorPath["bounds"]>) {
  const corners = [
    { x: bounds.min.x, y: bounds.min.y }, { x: bounds.max.x, y: bounds.min.y },
    { x: bounds.max.x, y: bounds.max.y }, { x: bounds.min.x, y: bounds.max.y },
  ];
  const affine = nativeAffineForNode(node);
  const world = affine
    ? corners.map((point) => transformPoint(affine, point))
    : corners.map((point) => {
      const radians = node.rotation * Math.PI / 180;
      const cos = Math.cos(radians); const sin = Math.sin(radians);
      const dx = point.x - node.width / 2; const dy = point.y - node.height / 2;
      return { x: node.x + node.width / 2 + cos * dx - sin * dy, y: node.y + node.height / 2 + sin * dx + cos * dy };
    });
  const xs = world.map((point) => point.x); const ys = world.map((point) => point.y);
  const left = Math.min(...xs); const top = Math.min(...ys);
  return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
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
function canonicalVectorContainsWorldPoint(node: CanvasNode, point: { x: number; y: number }): boolean | undefined {
  if (!wasmRuntime || node.kind !== "vector" || !node.vectorPath) return undefined;
  const affine = nativeAffineForNode(node);
  let local: { x: number; y: number };
  if (affine) {
    const inverse = invertAffine(affine);
    if (!inverse) return false;
    local = transformPoint(inverse, point);
  } else {
    const radians = node.rotation * Math.PI / 180;
    const cos = Math.cos(radians); const sin = Math.sin(radians);
    const dx = point.x - (node.x + node.width / 2);
    const dy = point.y - (node.y + node.height / 2);
    local = { x: cos * dx + sin * dy + node.width / 2, y: -sin * dx + cos * dy + node.height / 2 };
  }
  try {
    const pathJson = JSON.stringify(node.vectorPath);
    if (wasmRuntime.vector_path_contains_json(pathJson, local.x, local.y, .25)) return true;
    const cap = canvasStrokeCap(node.strokeCapStart);
    if (hasVisibleStroke(node) && cap && node.strokeCapEnd === node.strokeCapStart) {
      return wasmRuntime.vector_path_stroke_contains_json(pathJson, local.x, local.y, .25, node.strokeWidth, cap, node.strokeJoin ?? "miter", node.strokeMiterLimit ?? 10);
    }
    return false;
  } catch {
    return undefined;
  }
}
function canonicalParametricContainsWorldPoint(node: CanvasNode, point: { x: number; y: number }): boolean | undefined {
  if (!wasmRuntime || (node.kind !== "polygon" && node.kind !== "star") || !node.parametricShape) return undefined;
  const affine = nativeAffineForNode(node);
  let local: { x: number; y: number };
  if (affine) {
    const inverse = invertAffine(affine);
    if (!inverse) return false;
    local = transformPoint(inverse, point);
  } else {
    const radians = node.rotation * Math.PI / 180;
    const cos = Math.cos(radians); const sin = Math.sin(radians);
    const dx = point.x - (node.x + node.width / 2);
    const dy = point.y - (node.y + node.height / 2);
    local = { x: cos * dx + sin * dy + node.width / 2, y: -sin * dx + cos * dy + node.height / 2 };
  }
  try {
    return wasmRuntime.parametric_shape_contains_point_json(node.width, node.height, JSON.stringify(node.parametricShape), local.x, local.y);
  } catch {
    return undefined;
  }
}
function canonicalBooleanContainsWorldPoint(node: CanvasNode, point: { x: number; y: number }): boolean | undefined {
  const path = canonicalBooleanPath(node);
  const world = node.kind === "booleanOperation" ? worldTransformForNode(nodes, node.id) : undefined;
  const inverse = world && invertAffine(world);
  if (!path || !inverse || !wasmRuntime) return undefined;
  const local = transformPoint(inverse, point);
  let pointIndex = 0;
  const projection = {
    fillRule: "nonZero",
    subpaths: path.subpaths.map((subpath) => ({
      closed: subpath.closed,
      points: subpath.points.map((candidate) => ({
        id: `00000000-0000-4000-8000-${(pointIndex++).toString(16).padStart(12, "0")}`,
        x: candidate.x,
        y: candidate.y,
        pointType: "corner",
      })),
    })),
  };
  try {
    return wasmRuntime.vector_path_contains_json(JSON.stringify(projection), local.x, local.y, .25);
  } catch {
    return undefined;
  }
}
function isRenderedBooleanOperand(node: CanvasNode) {
  const parent = node.parentId ? nodes.find((candidate) => candidate.id === node.parentId) : undefined;
  return Boolean(parent && parent.kind === "booleanOperation" && canonicalBooleanPath(parent));
}
function containsWorldPoint(node: CanvasNode, point: { x: number; y: number }) {
  const booleanContains = canonicalBooleanContainsWorldPoint(node, point);
  if (booleanContains !== undefined) return booleanContains;
  const vectorContains = canonicalVectorContainsWorldPoint(node, point);
  if (vectorContains !== undefined) return vectorContains;
  const parametricContains = canonicalParametricContainsWorldPoint(node, point);
  if (parametricContains !== undefined) return parametricContains;
  const affine = nativeAffineForNode(node);
  if (!affine) return findTopmostHit([node], point) === node;
  const inverse = invertAffine(affine);
  if (!inverse) return false;
  const local = transformPoint(inverse, point);
  return findTopmostHit([{ ...node, x: 0, y: 0, rotation: 0, relativeTransform: undefined }], local) !== undefined;
}
/** Frame clipping and G4 alpha masks are structural visibility gates. Keep
 * this test beside hit testing so targets outside either source are never
 * selected even if their own geometry contains the pointer. */
function isInsideClippingFrames(node: CanvasNode, point: { x: number; y: number }) {
  const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]));
  const visited = new Set<string>();
  let current: CanvasNode | undefined = node;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const pageId = current.pageId ?? defaultPageId;
    const siblings = sortNodesByLayerOrder(nodes.filter((candidate) => (candidate.pageId ?? defaultPageId) === pageId && candidate.parentId === current!.parentId));
    const index = siblings.findIndex((candidate) => candidate.id === current!.id);
    if (index < 0) return false;
    const maskIndex = siblings.slice(0, index).map((candidate, offset) => candidate.isMask ? offset : -1).reduce((latest, candidate) => Math.max(latest, candidate), -1);
    if (!current.isMask && maskIndex >= 0) {
      const mask = siblings[maskIndex];
      if (mask.visible === false || !containsWorldPoint(mask, point)) return false;
    }
    const parentId = current.parentId;
    if (!parentId) return true;
    const parent = byId.get(parentId);
    if (!parent) return false;
    if (isFrameLike(parent) && parent.clipsContent !== false && !containsWorldPoint(parent, point)) return false;
    current = parent;
  }
  return true;
}
function refreshTransientGroupBounds(preservedGroupIds: ReadonlySet<string> = new Set()) {
  const normalized = normalizeGroupBounds(nodes, { excludeGroupIds: preservedGroupIds });
  if (normalized) nodes = normalized;
}
function rebuildNodeIndex() {
  // Relative-v1 imports can ask for the same ancestor transform thousands of
  // times while painting nested Frame clips. Resolve the document once per
  // projection rebuild instead of recreating the full id/ancestry map for
  // every node and every clipping ancestor.
  worldTransformById = worldTransformsForNodes(nodes);
  const projected = worldSpaceProjectionNodes(nodes);
  nodeById = new Map(projected.map((node) => [node.id, node]));
  nodeBoundsById = new Map(projected.map((node) => [node.id, boundsForNode(node)]));
  spatialGrid = createSpatialGridIndex(activeNodes(), (node) => nodeBoundsById.get(node.id) ?? boundsForNode(node));
  rebuildCompiledScene();
}
function rebuildCompiledScene() {
  compiledScene = compileScene({ revision, nodes, pageId: activePageId, defaultPageId, previousScene: compiledScene?.scene });
  const specialFallbacks = compiledScene.diagnostics.filter((diagnostic) => diagnostic.capability === "special-node");
  const signature = specialFallbacks.map((diagnostic) => `${diagnostic.nodeId}:${diagnostic.reason}`).join("|");
  if (signature && signature !== compiledSceneFallbackSignature) {
    diagnostics.record({ category: "renderer", code: "SPECIAL_NODE_FALLBACK", documentRevision: revision, details: { rejectedNodes: specialFallbacks.length } });
  }
  compiledSceneFallbackSignature = signature;
}
function emit(message: WorkerToMain) {
  if (message.type === "snapshot" && hydrationCompletionRequestId) {
    message.snapshot.hydrationRequestId = hydrationCompletionRequestId;
    hydrationCompletionRequestId = undefined;
  }
  self.postMessage(message);
}
function emitError(error: unknown, code?: EditorErrorCode, transactionId?: string) {
  const classified = code ? editorError(code) : classifyEditorError(error);
  const diagnostic = diagnostics.record({ category: "lifecycle", code: `ENGINE_${classified.code}`, documentRevision: revision, details: { errorCode: classified.code } });
  emit({ type: "error", ...classified, documentRevision: revision, diagnosticId: diagnostic.sequence, transactionId });
}
function emitSnapshot(localJournalEntry?: LocalJournalEntry, persistable = true) {
  storeActivePageSelection();
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
  emit({ type: "snapshot", snapshot: { documentId, revision, documentHash, memory, resources: { documentNodes: memory?.nodeCount ?? nodes.length, maxDocumentNodes: 100_000, documentBytes: memory?.nodeBytes ?? 0, maxDocumentBytes: memory?.maxDocumentBytes ?? 256 * 1024 * 1024, wasmHeapBytes: wasmHeap.bytes, maxWasmHeapBytes: MAX_WASM_HEAP_BYTES, renderSurfaceBytes, maxRenderSurfaceBytes: MAX_RENDER_SURFACE_BYTES, gpuSceneBytes, maxGpuSceneBytes: MAX_GPU_SCENE_RESOURCE_BYTES, gpuEffectTextureBytes, maxGpuEffectTextureBytes: MAX_GPU_EFFECT_TEXTURE_BYTES, gpuSceneWithinBudget }, diagnostics: diagnostics.summary(), performance: renderPerformance.summary(), nodes, assets, fontAvailability, pages, activePageId, selectedIds, viewport, canUndo: undoOrder.length > 0, canRedo: redoOrder.length > 0, renderer: gpuRenderer && gpuSceneWithinBudget ? "WebGPU + Canvas 2D overlay" : "Canvas 2D", gpu: { webgpu: gpuStatus, webgl2Available, recoveryAttempts: gpuRecoveryAttempts, ...(simulatedGpuLossesRequested ? { developmentSimulation: { requestedLosses: simulatedGpuLossesRequested, completedLosses: simulatedGpuLosses } } : {}) }, documentCore, localSnapshot, localJournalEntry } });
}
function emitRemoteBootstrap() {
  if (!wasmDocument || documentCore !== "Rust/WASM bridge ready") return;
  remoteBootstrapPending = false;
  const snapshot = wasmDocument.snapshot_protobuf();
  self.postMessage({ type: "remote-bootstrap", documentId, revision, snapshot } satisfies WorkerToMain, [snapshot.buffer]);
}
function migrateLoadedFigmaBootstrapPage(engine: WasmDocumentEngine) {
  try {
    const migration = migrateLegacyFigmaBootstrapPage(
      JSON.parse(engine.snapshot_json()) as WasmProjectionSnapshot,
    );
    if (!migration) return undefined;
    engine.load_snapshot_json(JSON.stringify(migration.snapshot));
    if (activePageId === migration.replacedPageId) activePageId = defaultPageId;
    const rememberedViewport = viewportByPage.get(migration.replacedPageId);
    if (rememberedViewport) viewportByPage.set(defaultPageId, rememberedViewport);
    viewportByPage.delete(migration.replacedPageId);
    selectionByPage.delete(migration.replacedPageId);
    diagnostics.record({
      category: "recovery",
      code: "LEGACY_FIGMA_BOOTSTRAP_PAGE_MIGRATED",
      documentRevision: Number(engine.revision),
      details: {
        replacedPageId: migration.replacedPageId,
        removedStarterNodeCount: migration.removedStarterNodeIds.length,
      },
    });
    return migration;
  } catch {
    // Migration is opportunistic and must never make an otherwise valid remote
    // document unreadable. Keep the source snapshot and surface bounded evidence.
    diagnostics.record({
      category: "recovery",
      code: "LEGACY_FIGMA_BOOTSTRAP_PAGE_MIGRATION_REJECTED",
      documentRevision: Number(engine.revision),
    });
    return undefined;
  }
}
function applyRemoteSnapshot(snapshot: Uint8Array, publish = true) {
  if (!wasmDocument) {
    emitError(undefined, "TRANSIENT");
    return false;
  }
  try {
    const shouldFitRemoteContent = !pageContentBounds(
      nodes,
      activePageId,
      defaultPageId,
    );
    emit({ type: "remote-load-progress", stage: "decode" });
    wasmDocument.load_snapshot_protobuf(snapshot);
    const bootstrapMigration = migrateLoadedFigmaBootstrapPage(wasmDocument);
    history.length = 0;
    future = [];
    undoOrder.length = 0;
    redoOrder = [];
    // A remote Snapshot can arrive just after a user has made a local
    // selection (especially during a newly-created document's first sync).
    // Selection is presentation state, not Canonical document state: retain
    // IDs that still exist after hydration, while naturally dropping deleted
    // layers through `syncProjectionFromWasm` below.
    emit({ type: "remote-load-progress", stage: "project" });
    syncProjectionFromWasm(false);
    if (!pages.some((page) => page.id === activePageId)) activePageId = pages[0]?.id ?? defaultPageId;
    // Server snapshots intentionally contain document state, not a browser's
    // presentation viewport. When this tab only had the empty bootstrap page,
    // fit the first real remote page so imported content cannot hydrate fully
    // while remaining off-screen.
    if (shouldFitRemoteContent && nodes.length) restoreOrFitPageViewport(activePageId);
    emit({ type: "remote-load-progress", stage: "render" });
    render(
      undefined,
      (stage) => emit({ type: "remote-load-progress", stage }),
      nodes.length >= 1_000,
    );
    if (publish) {
      diagnostics.record({ category: "recovery", code: "REMOTE_SNAPSHOT_APPLIED", documentRevision: revision });
      emitSnapshot();
    }
    if (bootstrapMigration) {
      const replacement = wasmDocument.snapshot_protobuf();
      self.postMessage(
        { type: "remote-reset", documentId, revision, snapshot: replacement } satisfies WorkerToMain,
        [replacement.buffer],
      );
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
function hydrateRemoteSnapshot(snapshot: Uint8Array, requestId?: string) {
  if (requestId) hydrationCompletionRequestId = requestId;
  applyRemoteSnapshot(snapshot);
}

/** Serializing envelope derivation preserves the same client sequence and order
 * as the locally committed Core revision stream, even when WebCrypto resolves
 * hashes asynchronously. */
function queueRemoteOperation(transactionId: string, baseRevision: number, batch: readonly CoreBatchCommand[], localDocumentHash: string) {
  queueRemotePayload(transactionId, baseRevision, encodeCoreBatchPayload(batch), localDocumentHash, { kind: "core-batch", batch: structuredClone([...batch]) });
}

async function buildPendingRemoteOperation(transactionId: string, baseRevision: number, payload: Uint8Array, localDocumentHash: string, replay?: PendingOperationReplay): Promise<PendingRemoteOperation> {
  const documentForOperation = documentId;
  const clientSequence = ++remoteClientSequence;
  const digest = await sha256Bytes(payload);
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
    const currentIds = new Set(nodes.map((node) => node.id));
    // A create/restore whose durable identity already exists in the remote
    // snapshot cannot be replayed atomically. Let reconciliation discard the
    // stale operation immediately instead of cloning/reordering a large Figma
    // batch only for Rust to reject the duplicate ID at commit time.
    if (
      replay.batch.some(
        (command) =>
          (command.type === "create" || command.type === "restore") &&
          currentIds.has(command.node.id),
      )
    )
      throw new Error("REMOTE_REPLAY_NODE_ALREADY_EXISTS");
    const batch = rebaseCoreBatchForSnapshot(nodes, replay.batch);
    wasmDocument.apply_transaction_json(transactionId, wasmDocument.revision, JSON.stringify(batch));
    payload = encodeCoreBatchPayload(batch);
    replay = { kind: "core-batch", batch };
  } else if (replay.kind === "create-page") {
    wasmDocument.create_page_at_position(transactionId, wasmDocument.revision, replay.page.id, replay.page.name, replay.page.positionId);
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
  // Publish the validated service snapshot before potentially expensive local
  // intent replay. The main thread exposes it read-only until the final
  // `remote-reconciled` boundary, so users can see and navigate large files
  // without waiting behind reconciliation bookkeeping.
  emitSnapshot();
  // Finish the first frame before replaying a potentially large local queue.
  // A cancellation resolves its completion too; follow any replacement paint.
  while (progressivePaintCompletion) await progressivePaintCompletion;
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
  const yieldToTasks = createCooperativeYield();
  let completed = 0;
  let lastProgressAt = 0;
  for (const operation of plan.replayable) {
    // This must also run after a rejected intent. A series of synchronous
    // rejects or immediately resolved crypto promises otherwise starves paint
    // and input messages for the entire recovery loop.
    await yieldToTasks();
    // Camera input can start another paint after initial hydration. Give that
    // visible work priority over the next historical operation as well.
    while (progressivePaintCompletion) await progressivePaintCompletion;
    if (completed === 0 || performance.now() - lastProgressAt >= 200) {
      emit({ type: "remote-reconciliation-progress", completed, total: plan.replayable.length });
      lastProgressAt = performance.now();
    }
    completed += 1;
    const replay = operation.replay;
    // `planPendingOperationReconciliation` only returns records with replay
    // data. Keep this guard at the Worker boundary in case an old IndexedDB
    // record is malformed after structured-clone deserialization.
    if (!replay) {
      blockedOperationIds.push(operation.operationId);
      break;
    }
    const replacementId = createId();
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
  try { syncProjectionFromWasm(false); render(); }
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
  rememberActivePageViewport();
  const pageIds = new Set(pages.map((page) => page.id));
  const pageViewports = Object.fromEntries(
    [...viewportByPage].filter(([pageId]) => pageIds.has(pageId)).map(([pageId, value]) => [pageId, { ...value }]),
  );
  emit({ type: "viewport-checkpoint", viewport: { ...viewport }, activePageId, pageViewports, documentHash: wasmDocument.canonical_hash(), coreRevision: Number(wasmDocument.revision) });
}
function emitViewState(viewportChanged = false) {
  rememberActivePageSelection();
  emit({ type: "view-state", viewport: { ...viewport }, selectedIds: [...selectedIds], activePageId, performance: renderPerformance.summary(), viewportChanged });
}
function emitInteractiveViewState() {
  const now = performance.now();
  if (now - lastInteractiveViewStateAt < INTERACTIVE_VIEW_STATE_INTERVAL_MS) return;
  lastInteractiveViewStateAt = now;
  emitViewState(true);
}
function setRenderSurface(nextWidth: number, nextHeight: number, nextDeviceDpr: number) {
  const qualityDpr = renderDpr(nextDeviceDpr, renderQuality);
  // A dense full-page overview is fill-rate bound: hundreds of overlapping
  // Frame backgrounds at full Retina resolution can otherwise dominate the
  // Canvas fallback. A fixed 1.5x backing store is noticeably sharper than
  // CSS-pixel rendering on Retina and avoids DPR resizing between interaction
  // and settled frames.
  const complexDocumentDprCap =
    nodes.length >= COMPLEX_DOCUMENT_NODE_THRESHOLD
      ? 1.5
      : Number.POSITIVE_INFINITY;
  const nextDpr = nodes.length >= COMPLEX_DOCUMENT_NODE_THRESHOLD
    ? Math.min(Math.max(1, nextDeviceDpr), complexDocumentDprCap)
    : Math.min(qualityDpr, complexDocumentDprCap);
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
    completedProgressivePaintKey = undefined;
    presentedPageId = undefined;
    presentedSurfaceWidth = 0;
    presentedSurfaceHeight = 0;
    effectSurfaces = undefined;
    alphaMaskSurfaces = [];
    alphaMaskLimitReported = false;
    effectSurfaceLimitReported = false;
  }
  return true;
}
function cachePresentedFrame(
  frame: OffscreenCanvas,
  frameViewport: Viewport,
  surfaceWidth: number,
  surfaceHeight: number,
) {
  cachedPresentedFrame = frame;
  cachedPresentedFramePageId = activePageId;
  cachedPresentedFrameViewport = { ...frameViewport };
  cachedPresentedFrameSurfaceWidth = surfaceWidth;
  cachedPresentedFrameSurfaceHeight = surfaceHeight;
  const sceneKey = `${revision}:${activePageId}:${transientSceneVersion}`;
  cachedPresentedFrameSceneKey = sceneKey;
  if (cachedOverviewFrame?.sceneKey !== sceneKey) cachedOverviewFrame = undefined;
  // Retain the widest completed view as an alternative to the detail raster.
  // Zooming out can reveal the rest of the page before the next scene paint.
  // This is a reference to an immutable published surface, bounded to 32 MiB.
  if (frame.width * frame.height * 4 <= 32 * 1024 * 1024 &&
      (!cachedOverviewFrame || frameViewport.zoom <= cachedOverviewFrame.viewport.zoom)) {
    cachedOverviewFrame = { canvas: frame, sceneKey, viewport: { ...frameViewport }, width: surfaceWidth, height: surfaceHeight };
  }
}
function reprojectCachedFrameDuringInteraction() {
  if (
    renderQuality.tier !== "interactive" ||
    nodes.length < COMPLEX_DOCUMENT_NODE_THRESHOLD ||
    !canvas ||
    !context ||
    !cachedPresentedFrame ||
    !cachedPresentedFrameViewport ||
    cachedPresentedFramePageId !== activePageId ||
    cachedPresentedFrameSceneKey !== `${revision}:${activePageId}:${transientSceneVersion}`
  ) return false;
  const frames = [{
    canvas: cachedPresentedFrame,
    viewport: cachedPresentedFrameViewport,
    width: cachedPresentedFrameSurfaceWidth,
    height: cachedPresentedFrameSurfaceHeight,
  }];
  if (cachedOverviewFrame?.sceneKey === cachedPresentedFrameSceneKey) frames.push(cachedOverviewFrame);
  const projection = selectCoveringViewportFrame(
    frames,
    viewport,
    { width, height },
  );
  if (!projection) return false;
  const { frame, rect } = projection;
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = canvasDesignTokens.color.backdrop;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    frame.canvas,
    rect.x * dpr,
    rect.y * dpr,
    rect.width * dpr,
    rect.height * dpr,
  );
  context.restore();
  presentedPageId = activePageId;
  presentedSurfaceWidth = canvas.width;
  presentedSurfaceHeight = canvas.height;
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
    gpuEffectTextureBytes = 0;
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
    gpuEffectTextureBytes = 0;
    gpuSceneWithinBudget = true;
    gpuSceneLimitReported = false;
    textAtlasStatsSignature = "";
    imageTextureStatsSignature = "";
    effectTextureStatsSignature = "";
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
    gpuEffectTextureBytes = 0;
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
  gpuEffectTextureBytes = 0;
  textAtlasStatsSignature = "";
  imageTextureStatsSignature = "";
  effectTextureStatsSignature = "";
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
function journalEntry(operation: CoreJournalOperation, baseRevision: number, id = createId()): LocalJournalEntry | undefined {
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
  return canvasNodeFromWasmProjection(node);
}
function syncProjectionFromWasm(rememberExisting = true) {
  if (!wasmDocument) return;
  if (rememberExisting) rememberProjection();
  const snapshot = JSON.parse(wasmDocument.snapshot_json()) as WasmProjectionSnapshot;
  const nextDocumentId = snapshot.documentId ?? documentId;
  if (nextDocumentId !== documentId) selectionByPage.clear();
  documentId = nextDocumentId;
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
  setRenderSurface(width, height, deviceDpr);
  selectedIds = normalizePageSelection(nodes, activePageId, selectedIds, defaultPageId);
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
  if (!wasmDocument || !wasmRuntime || nodes.length > MAX_RUST_GPU_INSTANCE_NODES) {
    rustGpuScene = undefined;
    return;
  }
  const visiblePageNodes = visibleNodesOnPage(nodes, activePageId, defaultPageId);
  const visibleById = new Map(visiblePageNodes.map((node) => [node.id, node]));
  // The renderer must use the structural Canvas tree for clipped Frame
  // descendants. Building a second full Rust/GPU batch here is pure cold-start
  // cost and is especially expensive for deeply nested Figma imports.
  if (
    visiblePageNodes.some(
      (node) =>
        Boolean(node.parentId) &&
        isFrameLike(visibleById.get(node.parentId!)) &&
        visibleById.get(node.parentId!)?.clipsContent !== false,
    )
  ) {
    rustGpuScene = undefined;
    return;
  }
  try {
    const payload = parseRustGpuSceneBatch(wasmRuntime.gpu_scene_instances_from_snapshot_json(
      wasmDocument.snapshot_json(),
      activePageId,
    ));
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

/** Derives line ranges only for one stable document face. Contiguous paint-only
 * Style Runs and a fallback-only default span may share it; metric-changing
 * runs remain on the documented Canvas transition path. */
function variationAxesKey(font: DocumentFontReference | undefined) {
  return JSON.stringify([...(font?.variationAxes ?? [])]
    // Do not discard malformed coordinates here: the Rust boundary must reject
    // them instead of silently rendering the default variable-font instance.
    .sort((left, right) => left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0)
    .map((axis) => ({ tag: axis.tag, value: axis.value })));
}

function rustTextLayoutRequest(node: CanvasNode) {
  const face = textFrozenLayoutFace(node);
  if (!face) return undefined;
  const axesKey = variationAxesKey(face.font);
  const key = JSON.stringify([revision, node.id, face.source, node.width, face.font.assetId, face.font.faceIndex, axesKey, face.fontSize]);
  return { key, source: face.source, font: face.font, axesKey, fontSize: face.fontSize, widthEm: node.width / face.fontSize };
}

function refreshRustTextLayouts() {
  const active = new Set<string>();
  nodes.filter((node) => node.kind === "text").forEach((node) => {
    const request = rustTextLayoutRequest(node);
    if (!request) return;
    active.add(node.id);
    if (rustTextLayouts.get(node.id)?.key === request.key || rustTextLayoutFallbacks.get(node.id)?.key === request.key || rustTextLayoutLoads.has(request.key)) return;
    if (fontFaces.statusFor(request.font.assetId) !== "ready") return;
    rustTextLayoutLoads.add(request.key);
    void loadRustTextLayout(node.id, request);
  });
  [...rustTextLayouts].forEach(([nodeId, cached]) => {
    if (!active.has(nodeId) || cached.revision !== revision) rustTextLayouts.delete(nodeId);
  });
  [...rustTextLayoutFallbacks].forEach(([nodeId, cached]) => {
    if (!active.has(nodeId) || cached.revision !== revision) rustTextLayoutFallbacks.delete(nodeId);
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
    if (hasMissingRustTextGlyph(layout)) {
      rustTextLayoutFallbacks.set(nodeId, { revision, key: request.key });
      return;
    }
    rustTextLayoutFallbacks.delete(nodeId);
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
  if (node.rotation !== 0 || properties?.paragraph.alignment !== "left" || (properties?.paragraph.paragraphSpacing ?? 0) !== 0 || properties?.runs.some((candidate) => candidate.color) || run?.italic || (run?.letterSpacing ?? 0) !== 0 || run?.fontWeight !== 400) return undefined;
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

/** Applies the pure REST planner result exactly like any other Core mutation.
 * Credentials, external URLs and byte downloads intentionally remain outside
 * this Worker; Asset requests must be admitted separately before binding. */
function importFigmaRestPlan(input: Extract<MainToWorker, { type: "import-figma-rest-plan" }>) {
  if (!wasmDocument) {
    emitError(undefined, "INVALID_COMMAND", input.transactionId);
    emit({ type: "ack", transactionId: input.transactionId, errorCode: "INVALID_TRANSACTION" });
    return;
  }
  if (input.baseRevision !== Number(wasmDocument.revision)) {
    emitError(undefined, "REVISION_CONFLICT", input.transactionId);
    emit({ type: "ack", transactionId: input.transactionId, errorCode: "REVISION_CONFLICT" });
    return;
  }
  const resolved = resolveFigmaRestImportBatch(input.plan);
  if (!resolved) {
    emitError(undefined, "INVALID_COMMAND", input.transactionId);
    emit({ type: "ack", transactionId: input.transactionId, errorCode: "INVALID_TRANSACTION" });
    return;
  }
  try {
    const baseRevision = Number(wasmDocument.revision);
    wasmDocument.apply_transaction_json(input.transactionId, wasmDocument.revision, JSON.stringify(resolved.batch));
    recordHistory("core");
    const bootstrapMigration = migrateLoadedFigmaBootstrapPage(wasmDocument);
    syncProjectionFromWasm(false);
    const firstImportedPageId = bootstrapMigration
      ? defaultPageId
      : input.plan.pages[0]?.id;
    const importedPageBecomesActive = input.plan.pages.some((page) => page.id === activePageId) === false;
    if (importedPageBecomesActive) {
      storeActivePageSelection();
      rememberActivePageViewport();
      activePageId = firstImportedPageId ?? activePageId;
      restoreOrFitPageViewport(activePageId);
      rustGpuScene = undefined;
      activateInteractiveRenderQuality();
    }
    selectedIds = [];
    rebuildNodeIndex();
    render();
    diagnostics.record({ category: "transaction", code: "FIGMA_REST_IMPORT_ACCEPTED", documentRevision: revision, transactionId: input.transactionId, details: { pageCount: input.plan.pages.length, nodeCount: input.plan.nodes.length, assetRequestCount: input.plan.assetRequests.length } });
    emitSnapshot(journalEntry({ type: "restore-core", coreSnapshot: wasmDocument.snapshot_json() }, baseRevision, input.transactionId));
    if (bootstrapMigration) {
      // Replacing the untouched bootstrap page changes page identity as well as
      // content, so persist one validated canonical root instead of publishing
      // an operation that would recreate the synthetic page remotely.
      const replacement = wasmDocument.snapshot_protobuf();
      self.postMessage(
        { type: "remote-reset", documentId, revision, snapshot: replacement } satisfies WorkerToMain,
        [replacement.buffer],
      );
    } else {
      queueRemoteOperation(input.transactionId, baseRevision, resolved.batch, wasmDocument.canonical_hash());
    }
    emit({ type: "ack", transactionId: input.transactionId, acceptedRevision: revision });
  } catch (error) {
    const errorCode = error instanceof Error && error.message.includes("ResourceLimit") ? "RESOURCE_LIMIT" : "INVALID_TRANSACTION";
    diagnostics.record({ category: "transaction", code: "FIGMA_REST_IMPORT_REJECTED", documentRevision: revision, transactionId: input.transactionId, details: { errorCode } });
    emitError(error, errorCode === "RESOURCE_LIMIT" ? "RESOURCE_LIMIT" : "INVALID_COMMAND", input.transactionId);
    emit({ type: "ack", transactionId: input.transactionId, errorCode });
  }
}

/** Commits only post-authorization Asset Service metadata and references. Raw
 * Figma URLs/credentials never cross this boundary; callers seed image bytes
 * independently through the transient asset-bytes message. */
function bindFigmaRestAssets(input: Extract<MainToWorker, { type: "bind-figma-rest-assets" }>) {
  if (!wasmDocument) {
    emitError(undefined, "INVALID_COMMAND", input.transactionId);
    emit({ type: "ack", transactionId: input.transactionId, errorCode: "INVALID_TRANSACTION" });
    return;
  }
  if (input.baseRevision !== Number(wasmDocument.revision)) {
    emitError(undefined, "REVISION_CONFLICT", input.transactionId);
    emit({ type: "ack", transactionId: input.transactionId, errorCode: "REVISION_CONFLICT" });
    return;
  }
  const resolved = resolveFigmaRestAssetBindings(nodes, assets, input.authorized);
  if (!resolved.batch.length) {
    diagnostics.record({ category: "transaction", code: "FIGMA_REST_ASSET_BINDING_REJECTED", documentRevision: revision, transactionId: input.transactionId, details: { issueCount: resolved.issues.length } });
    emitError(undefined, "INVALID_COMMAND", input.transactionId);
    emit({ type: "ack", transactionId: input.transactionId, errorCode: "INVALID_TRANSACTION" });
    return;
  }
  try {
    const baseRevision = Number(wasmDocument.revision);
    wasmDocument.apply_transaction_json(input.transactionId, wasmDocument.revision, JSON.stringify(resolved.batch));
    recordHistory("core");
    syncProjectionFromWasm(false);
    render();
    diagnostics.record({ category: "transaction", code: "FIGMA_REST_ASSET_BINDING_ACCEPTED", documentRevision: revision, transactionId: input.transactionId, details: { assetCount: input.authorized.length, boundNodeCount: resolved.boundNodeIds.length, issueCount: resolved.issues.length } });
    emitSnapshot(journalEntry({ type: "restore-core", coreSnapshot: wasmDocument.snapshot_json() }, baseRevision, input.transactionId));
    queueRemoteOperation(input.transactionId, baseRevision, resolved.batch, wasmDocument.canonical_hash());
    emit({ type: "ack", transactionId: input.transactionId, acceptedRevision: revision });
  } catch (error) {
    const errorCode = error instanceof Error && error.message.includes("ResourceLimit") ? "RESOURCE_LIMIT" : "INVALID_TRANSACTION";
    diagnostics.record({ category: "transaction", code: "FIGMA_REST_ASSET_BINDING_REJECTED", documentRevision: revision, transactionId: input.transactionId, details: { errorCode, issueCount: resolved.issues.length } });
    emitError(error, errorCode === "RESOURCE_LIMIT" ? "RESOURCE_LIMIT" : "INVALID_COMMAND", input.transactionId);
    emit({ type: "ack", transactionId: input.transactionId, errorCode });
  }
}
type JournalReplayEngine = Pick<WasmDocumentEngine, "revision" | "snapshot_json" | "apply_transaction_json" | "move_nodes" | "load_snapshot_json">;

function replayJournalEntry(engine: JournalReplayEngine, entry: LocalJournalEntry) {
  if (entry.acceptedRevision <= Number(engine.revision)) return;
  try {
    if (entry.baseRevision !== Number(engine.revision)) throw new Error("JOURNAL_REVISION_CONFLICT");
    const operation = entry.operation;
    if (operation.type === "create" || operation.type === "update" || operation.type === "reposition" || operation.type === "reparent" || operation.type === "group" || operation.type === "boolean" || operation.type === "ungroup" || operation.type === "transformGroup" || operation.type === "delete") {
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
async function loadDocumentBridge(localSnapshot?: CoreLocalSnapshot, benchmarkProjection = false, seedAssets: readonly DocumentAsset[] = [], hydrationRequestId?: string) {
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
      migrateLoadedFigmaBootstrapPage(engine);
    } else {
      if (seedAssets.length) engine.seed_assets_json(JSON.stringify(seedAssets));
      nodes = normalizeAutoLayoutProjection(nodes);
      for (const batchNodes of wasmHydrationBatches(nodes)) {
        const hydrated = resolveCoreBatch([], batchNodes.map((node) => ({ type: "create" as const, node })));
        if (!hydrated) throw new Error("INVALID_LEGACY_PROJECTION");
        engine.seed_batch_json(JSON.stringify(hydrated.batch));
      }
      // A workspace document gets its own Canonical identity before its first
      // local or remote snapshot is emitted. Production documents start with an
      // empty Page 1; demo content belongs exclusively to explicit fixtures.
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
      const restoredViewport = localSnapshot.activePageId
        ? localSnapshot.viewport
        : recovered?.viewport ?? localSnapshot.viewport;
      viewport = { ...restoredViewport };
      viewportByPage.clear();
      Object.entries(localSnapshot.pageViewports ?? {}).forEach(([pageId, value]) => {
        if (Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.zoom) && value.zoom > 0) {
          viewportByPage.set(pageId, { ...value });
        }
      });
      preservedProjectionNodes.clear();
      (recovered?.presentation ?? localSnapshot.presentation).forEach((node) => preservedProjectionNodes.set(node.id, structuredClone(node)));
      syncProjectionFromWasm(false);
      if (localSnapshot.activePageId && pages.some((page) => page.id === localSnapshot.activePageId)) {
        activePageId = localSnapshot.activePageId;
        viewport = { ...(viewportByPage.get(activePageId) ?? restoredViewport) };
        viewportByPage.set(activePageId, { ...viewport });
        rustGpuScene = undefined;
        rebuildNodeIndex();
      } else viewportByPage.set(activePageId, { ...viewport });
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
      void loadDocumentBridge(undefined, benchmarkProjection, [], hydrationRequestId);
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
  if (hydrationRequestId) hydrationCompletionRequestId = hydrationRequestId;
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
  // Errors thrown from a wasm-bindgen or Worker realm do not always satisfy
  // this realm's `instanceof Error`; retain their stable class without exposing
  // an arbitrary message in diagnostics or persisted state.
  if (error && typeof error === "object" && "name" in error && typeof error.name === "string") return error.name;
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
  return snapshotNodes.map((node) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(node.id) ? node : { ...node, id: createId() });
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
      wasmDocument.apply_transaction_json(createId(), wasmDocument.revision, JSON.stringify(resolved.batch));
    }
    if (command.type === "update") {
      const resolved = resolveCoreBatch(nodes, [command]);
      if (!resolved) throw new Error("INVALID_TRANSACTION");
      wasmDocument.apply_transaction_json(createId(), wasmDocument.revision, JSON.stringify(resolved.batch));
    }
    if (command.type === "delete") {
      wasmDocument.delete_nodes(createId(), wasmDocument.revision, command.ids.join(","));
    }
    if (command.type === "reposition") {
      wasmDocument.apply_transaction_json(createId(), wasmDocument.revision, JSON.stringify([{ type: "reposition", positionIds: command.positionIds }]));
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
function resetDocumentToBlankPage() {
  // Invalidate any in-flight hydration before publishing a new projection. The
  // transient snapshot deliberately carries no Core payload, so persistence can
  // retain the last confirmed document until the replacement Core is ready.
  bridgeLoadSequence += 1;
  remoteResetPending = true;
  wasmDocument = undefined;
  ephemeralBenchmarkProjection = false;
  rustGpuScene = undefined;
  rustTextLayouts.clear();
  rustTextLayoutFallbacks.clear();
  documentCore = "Starting Rust/WASM bridge";
  const reset = resetDocumentProjection([]);
  nodes = reset.nodes;
  rebuildNodeIndex();
  selectionByPage.clear();
  selectedIds = reset.selectedIds;
  viewport = reset.viewport;
  viewportByPage.clear();
  viewportByPage.set(activePageId, { ...viewport });
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
  const remoteOperationId = appliedByWasm && remoteCommand ? createId() : undefined;
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
    // Persistent canvas labels belong to page-level Frames/Sections. Nested
    // containers remain discoverable in Layers and show their name when
    // selected, but must not paint (or expose a hit target for) a label over
    // their parent's artwork.
    if (!showsPersistentCanvasLayerName(node) || node.locked) return false;
    return isFrameNameHit(context!, node, screenX, screenY);
  });
}
function paintedHit(worldX: number, worldY: number) {
  const point = { x: worldX, y: worldY };
  const active = activeNodes();
  const nodesById = new Map(active.map((node) => [node.id, node]));
  const semanticHit = compiledScene && findTopmostSceneHit(compiledScene.scene, point, (id) => {
    const candidate = nodesById.get(id);
    return Boolean(candidate && candidate.visible !== false && !isRenderedBooleanOperand(candidate) && !isEffectivelyLocked(nodesById, candidate.id) && isInsideClippingFrames(candidate, point) && containsWorldPoint(candidate, point));
  });
  if (semanticHit) return { active, node: nodesById.get(semanticHit.nodeId) };
  // Fallback remains available while an older/partial scene compiler cannot
  // map a node kind. It keeps an optimization failure from changing selection.
  const candidates = [...active].reverse().filter((candidate) => candidate.visible !== false && !isRenderedBooleanOperand(candidate) && !isEffectivelyLocked(nodesById, candidate.id) && isInsideClippingFrames(candidate, point) && containsWorldPoint(candidate, point));
  // Slices are export-only regions. The shared selector keeps them available
  // from Layers while direct canvas clicks reach painted content underneath.
  return { active, node: findTopmostCanvasSelectionCandidate(candidates) };
}
function hit(worldX: number, worldY: number, drillDown = false, deepSelect = false) {
  const { active, node: paintedNode } = paintedHit(worldX, worldY);
  // Frame and Group are selection boundaries; repeated clicks enter one level,
  // while Command/Ctrl-click selects the painted descendant directly.
  const node = paintedNode && resolveNestedSelectionTarget(active, paintedNode.id, drillDown, selectedIds, deepSelect);
  if (node) return node;
  const screen = toScreen(worldX, worldY);
  return hitFrameName(screen.x, screen.y);
}
function hoverHit(worldX: number, worldY: number) {
  // Figma previews the actual layer under the pointer, not the parent that a
  // normal click would select. Container fallback retains Frame-name hover.
  const paintedNode = paintedHit(worldX, worldY).node;
  if (paintedNode) return paintedNode;
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
function paintStackStyle(ctx: OffscreenCanvasRenderingContext2D, paint: NonNullable<CanvasNode["fills"]>[number], width: number, height: number) { return paintStyle(ctx, paint.css, paint.gradient, width, height); }
function activeFills(node: CanvasNode): NonNullable<CanvasNode["fills"]> { return node.fills?.length ? node.fills : [{ css: node.fill, color: node.fillColor, gradient: node.fillGradient }]; }
function activeStrokes(node: CanvasNode): NonNullable<CanvasNode["strokes"]> { return node.strokes?.length ? node.strokes : [{ css: node.stroke, color: node.strokeColor, gradient: node.strokeGradient }]; }
function hasVisibleFill(node: CanvasNode) {
  return activeFills(node).some(
    (paint) =>
      paint.gradient?.stops.some((stop) => stop.color.alpha > 0) ??
      (paint.color ?? documentColorFromCssHex(paint.css))?.alpha !== 0,
  );
}
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
function fillScaledCanonicalStrokeMesh(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, mesh: StrokeMesh, width: number, height: number, scale: number) {
  ctx.beginPath();
  mesh.forEach(([a, b, c]) => {
    ctx.moveTo(a.x * scale, a.y * scale);
    ctx.lineTo(b.x * scale, b.y * scale);
    ctx.lineTo(c.x * scale, c.y * scale);
    ctx.closePath();
  });
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
function canonicalParametricOutline(node: CanvasNode, shapeWidth: number, shapeHeight: number): readonly StrokeMeshPoint[] {
  if ((node.kind !== "polygon" && node.kind !== "star") || !node.parametricShape) return [];
  const shapeJson = JSON.stringify(node.parametricShape);
  const key = `${node.id}:${shapeWidth}:${shapeHeight}:${shapeJson}`;
  const cached = canonicalParametricOutlines.get(key);
  if (cached !== undefined) return cached ?? fallbackParametricShapePoints(shapeWidth, shapeHeight, node.parametricShape);
  let outline: readonly StrokeMeshPoint[] | undefined;
  if (wasmRuntime) {
    try {
      const result: unknown = JSON.parse(wasmRuntime.parametric_shape_outline_json(shapeWidth, shapeHeight, shapeJson));
      const points = typeof result === "object" && result !== null && "points" in result && Array.isArray((result as { points?: unknown }).points)
        ? (result as { points: unknown[] }).points.map(meshPoint)
        : undefined;
      if (points?.every((point): point is StrokeMeshPoint => Boolean(point))) outline = points;
    } catch { /* The deterministic TypeScript formula remains a boot fallback until WASM is ready. */ }
  }
  const resolved = outline ?? fallbackParametricShapePoints(shapeWidth, shapeHeight, node.parametricShape);
  if (canonicalParametricOutlines.size >= 2_048) canonicalParametricOutlines.clear();
  canonicalParametricOutlines.set(key, resolved);
  return resolved;
}
/** Uses the Rust-generated regular-shape outline as the sole input to Rust's
 * closed-polyline tessellator. The mesh stays presentation-only, bounded and
 * cached alongside the other Canonical stroke meshes. */
function canonicalParametricStrokeMesh(node: CanvasNode, width: number, height: number): StrokeMesh | undefined {
  if (!wasmRuntime || (node.kind !== "polygon" && node.kind !== "star") || !node.parametricShape || !hasVisibleStroke(node) || node.strokeWidth <= 0) return undefined;
  const points = canonicalParametricOutline(node, width, height);
  if (points.length < 3) return undefined;
  const strokeWidth = node.strokeWidth * viewport.zoom;
  const dash = node.strokeDashPattern?.map((segment) => segment * viewport.zoom) ?? [];
  const join = node.strokeJoin ?? "miter";
  const key = `${node.id}:parametric-stroke:${width}:${height}:${JSON.stringify(node.parametricShape)}:${strokeWidth}:${dash.join(",")}:${join}:${node.strokeMiterLimit ?? 10}`;
  const cached = canonicalStrokeMeshes.get(key);
  if (cached !== undefined) return cached ?? undefined;
  try {
    const result: unknown = JSON.parse(dash.length
      ? wasmRuntime.stroke_mesh_for_dashed_polyline_json(JSON.stringify(points.map((point) => [point.x, point.y])), strokeWidth, JSON.stringify(dash), "butt", join, node.strokeMiterLimit ?? 10, true)
      : wasmRuntime.stroke_mesh_for_polyline_json(JSON.stringify(points.map((point) => [point.x, point.y])), strokeWidth, "butt", join, node.strokeMiterLimit ?? 10, true));
    const triangles = typeof result === "object" && result !== null && "triangles" in result ? (result as { triangles?: unknown }).triangles : undefined;
    const mesh = Array.isArray(triangles) ? triangles.map((triangle) => {
      if (!Array.isArray(triangle) || triangle.length !== 3) return undefined;
      const trianglePoints = triangle.map(meshPoint);
      return trianglePoints.every((point): point is StrokeMeshPoint => Boolean(point)) ? [trianglePoints[0], trianglePoints[1], trianglePoints[2]] as StrokeMeshTriangle : undefined;
    }) : [];
    const resolved = mesh.length > 0 && mesh.every((triangle): triangle is StrokeMeshTriangle => Boolean(triangle)) ? mesh : null;
    if (canonicalStrokeMeshes.size >= 2_048) canonicalStrokeMeshes.clear();
    canonicalStrokeMeshes.set(key, resolved);
    return resolved ?? undefined;
  } catch {
    return undefined;
  }
}
/** Returns the Fill envelope emitted beside the Core-derived regular-shape
 * outline. This prevents spatial bounds from reimplementing Polygon/Star math
 * in the Worker. */
function canonicalParametricFillBounds(node: CanvasNode): { min: StrokeMeshPoint; max: StrokeMeshPoint } | undefined {
  if (!wasmRuntime || (node.kind !== "polygon" && node.kind !== "star") || !node.parametricShape) return undefined;
  const shapeJson = JSON.stringify(node.parametricShape);
  const key = `${node.id}:parametric-fill-bounds:${node.width}:${node.height}:${shapeJson}`;
  const cached = canonicalParametricStrokeBounds.get(key);
  if (cached !== undefined) return cached ?? undefined;
  try {
    const result: unknown = JSON.parse(wasmRuntime.parametric_shape_outline_json(node.width, node.height, shapeJson));
    const rawBounds = typeof result === "object" && result !== null && "bounds" in result ? (result as { bounds?: unknown }).bounds : undefined;
    const rawMin = typeof rawBounds === "object" && rawBounds !== null && "min" in rawBounds ? (rawBounds as { min?: unknown }).min : undefined;
    const rawMax = typeof rawBounds === "object" && rawBounds !== null && "max" in rawBounds ? (rawBounds as { max?: unknown }).max : undefined;
    const min = meshPoint(rawMin);
    const max = meshPoint(rawMax);
    const resolved = min && max && min.x <= max.x && min.y <= max.y ? { min, max } : null;
    if (canonicalParametricStrokeBounds.size >= 2_048) canonicalParametricStrokeBounds.clear();
    canonicalParametricStrokeBounds.set(key, resolved);
    return resolved ?? undefined;
  } catch {
    return undefined;
  }
}
/** Returns the Core tessellator's local mesh bounds at document scale. This is
 * deliberately separate from the viewport-scale render cache so spatial hit
 * broad phase and selection boxes cannot inherit a transient zoom value. */
function canonicalParametricVisualBounds(node: CanvasNode): { min: StrokeMeshPoint; max: StrokeMeshPoint } | undefined {
  if (!wasmRuntime || (node.kind !== "polygon" && node.kind !== "star") || !node.parametricShape) return undefined;
  if (!hasVisibleStroke(node) || node.strokeWidth <= 0) return canonicalParametricFillBounds(node);
  const points = canonicalParametricOutline(node, node.width, node.height);
  if (points.length < 3) return canonicalParametricFillBounds(node);
  const dash = node.strokeDashPattern ?? [];
  const join = node.strokeJoin ?? "miter";
  const key = `${node.id}:parametric-bounds:${node.width}:${node.height}:${JSON.stringify(node.parametricShape)}:${node.strokeWidth}:${dash.join(",")}:${join}:${node.strokeMiterLimit ?? 10}`;
  const cached = canonicalParametricStrokeBounds.get(key);
  if (cached !== undefined) return cached ?? undefined;
  try {
    const result: unknown = JSON.parse(dash.length
        ? wasmRuntime.stroke_mesh_for_dashed_polyline_json(JSON.stringify(points.map((point) => [point.x, point.y])), node.strokeWidth, JSON.stringify(dash), "butt", join, node.strokeMiterLimit ?? 10, true)
        : wasmRuntime.stroke_mesh_for_polyline_json(JSON.stringify(points.map((point) => [point.x, point.y])), node.strokeWidth, "butt", join, node.strokeMiterLimit ?? 10, true));
    const rawBounds = typeof result === "object" && result !== null && "bounds" in result ? (result as { bounds?: unknown }).bounds : undefined;
    const rawMin = typeof rawBounds === "object" && rawBounds !== null && "min" in rawBounds ? (rawBounds as { min?: unknown }).min : undefined;
    const rawMax = typeof rawBounds === "object" && rawBounds !== null && "max" in rawBounds ? (rawBounds as { max?: unknown }).max : undefined;
    const min = meshPoint(rawMin);
    const max = meshPoint(rawMax);
    const resolved = min && max && min.x <= max.x && min.y <= max.y ? { min, max } : null;
    if (canonicalParametricStrokeBounds.size >= 2_048) canonicalParametricStrokeBounds.clear();
    canonicalParametricStrokeBounds.set(key, resolved);
    return resolved ?? undefined;
  } catch {
    return undefined;
  }
}
function canonicalVectorPath(node: CanvasNode): FlattenedVectorPath | undefined {
  if (!wasmRuntime || node.kind !== "vector" || !node.vectorPath) return undefined;
  const pathJson = JSON.stringify(node.vectorPath);
  const key = `${node.id}:${pathJson}`;
  const cached = canonicalVectorPaths.get(key);
  if (cached !== undefined) return cached ?? undefined;
  try {
    const result: unknown = JSON.parse(wasmRuntime.vector_path_geometry_json(pathJson, .25));
    const subpaths = typeof result === "object" && result !== null && "subpaths" in result && Array.isArray((result as { subpaths?: unknown }).subpaths)
      ? (result as { subpaths: unknown[] }).subpaths.map((subpath) => {
        if (typeof subpath !== "object" || subpath === null || !("closed" in subpath) || !("points" in subpath) || typeof (subpath as { closed?: unknown }).closed !== "boolean" || !Array.isArray((subpath as { points?: unknown }).points)) return undefined;
        const points = (subpath as { points: unknown[] }).points.map(meshPoint);
        return points.every((point): point is StrokeMeshPoint => Boolean(point)) ? { closed: (subpath as { closed: boolean }).closed, points } : undefined;
    })
      : undefined;
    const bounds = typeof result === "object" && result !== null && "bounds" in result && typeof (result as { bounds?: unknown }).bounds === "object" && (result as { bounds?: unknown }).bounds !== null
      ? (result as { bounds: { min?: unknown; max?: unknown } }).bounds
      : undefined;
    const min = bounds ? meshPoint(bounds.min) : undefined;
    const max = bounds ? meshPoint(bounds.max) : undefined;
    const path = subpaths?.every((subpath): subpath is { closed: boolean; points: StrokeMeshPoint[] } => Boolean(subpath)) ? { subpaths, ...(min && max ? { bounds: { min, max } } : {}) } : undefined;
    if (canonicalVectorPaths.size >= 2_048) canonicalVectorPaths.clear();
    canonicalVectorPaths.set(key, path ?? null);
    return path;
  } catch {
    if (canonicalVectorPaths.size >= 2_048) canonicalVectorPaths.clear();
    canonicalVectorPaths.set(key, null);
    return undefined;
  }
}
function booleanOperandNodes(node: CanvasNode) {
  return sortNodesByLayerOrder(nodes.filter((candidate) => candidate.parentId === node.id));
}
function transformBooleanOperand(node: CanvasNode, transform: AffineMatrix) {
  if (!node.vectorPath) return undefined;
  return {
    fillRule: node.vectorPath.fillRule,
    subpaths: node.vectorPath.subpaths.map((subpath) => ({
      closed: subpath.closed,
      points: subpath.points.map((point) => {
        const anchor = transformPoint(transform, point);
        const transformHandle = (handle: typeof point.handleIn) => {
          if (!handle) return undefined;
          const control = transformPoint(transform, { x: point.x + handle.x, y: point.y + handle.y });
          return { x: control.x - anchor.x, y: control.y - anchor.y };
        };
        return { id: point.id, x: anchor.x, y: anchor.y, handleIn: transformHandle(point.handleIn), handleOut: transformHandle(point.handleOut), pointType: point.pointType };
      }),
    })),
  };
}
function canonicalBooleanPath(node: CanvasNode): FlattenedVectorPath | undefined {
  if (!wasmRuntime || node.kind !== "booleanOperation") return undefined;
  const operands = booleanOperandNodes(node);
  if (operands.length < 2 || operands.some((operand) => operand.kind !== "vector" || !operand.vectorPath)) return undefined;
  const booleanWorld = worldTransformForNode(nodes, node.id);
  const booleanInverse = booleanWorld && invertAffine(booleanWorld);
  if (!booleanInverse) return undefined;
  const localTransforms = operands.map((operand) => {
    const world = worldTransformForNode(nodes, operand.id);
    return world && multiplyAffine(booleanInverse, world);
  });
  if (localTransforms.some((transform) => !transform)) return undefined;
  const key = `${node.id}:${node.booleanOperation ?? "union"}:${operands.map((operand, index) => `${operand.id}:${JSON.stringify(operand.vectorPath)}:${JSON.stringify(localTransforms[index])}`).join("|")}`;
  const cached = canonicalBooleanPaths.get(key);
  if (cached !== undefined) return cached ?? undefined;
  try {
    const projected = operands.map((operand, index) => transformBooleanOperand(operand, localTransforms[index]!));
    if (projected.some((path) => !path)) return undefined;
    const result: unknown = JSON.parse(wasmRuntime.boolean_vector_paths_json(node.booleanOperation ?? "union", JSON.stringify(projected), .25));
    const subpaths = typeof result === "object" && result !== null && "subpaths" in result && Array.isArray((result as { subpaths?: unknown }).subpaths)
      ? (result as { subpaths: unknown[] }).subpaths.map((subpath) => {
        if (typeof subpath !== "object" || subpath === null || !("closed" in subpath) || !("points" in subpath) || typeof (subpath as { closed?: unknown }).closed !== "boolean" || !Array.isArray((subpath as { points?: unknown }).points)) return undefined;
        const points = (subpath as { points: unknown[] }).points.map(meshPoint);
        return points.every((point): point is StrokeMeshPoint => Boolean(point)) ? { closed: (subpath as { closed: boolean }).closed, points } : undefined;
      })
      : undefined;
    const bounds = typeof result === "object" && result !== null && "bounds" in result && typeof (result as { bounds?: unknown }).bounds === "object" && (result as { bounds?: unknown }).bounds !== null
      ? (result as { bounds: { min?: unknown; max?: unknown } }).bounds
      : undefined;
    const min = bounds ? meshPoint(bounds.min) : undefined;
    const max = bounds ? meshPoint(bounds.max) : undefined;
    const path = subpaths?.every((subpath): subpath is { closed: boolean; points: StrokeMeshPoint[] } => Boolean(subpath)) ? { subpaths, ...(min && max ? { bounds: { min, max } } : {}) } : undefined;
    if (canonicalBooleanPaths.size >= 2_048) canonicalBooleanPaths.clear();
    canonicalBooleanPaths.set(key, path ?? null);
    return path;
  } catch {
    if (canonicalBooleanPaths.size >= 2_048) canonicalBooleanPaths.clear();
    canonicalBooleanPaths.set(key, null);
    return undefined;
  }
}
function renderedBooleanOperandIds(orderedNodes: readonly CanvasNode[]) {
  const ids = new Set<string>();
  orderedNodes.forEach((node) => {
    if (canonicalBooleanPath(node)) booleanOperandNodes(node).forEach((operand) => ids.add(operand.id));
  });
  return ids;
}
function traceFlattenedVectorPath(ctx: Pick<OffscreenCanvasRenderingContext2D, "moveTo" | "lineTo" | "closePath">, path: FlattenedVectorPath, scale: number) {
  path.subpaths.forEach((subpath) => {
    const first = subpath.points[0];
    if (!first) return;
    ctx.moveTo(first.x * scale, first.y * scale);
    subpath.points.slice(1).forEach((point) => ctx.lineTo(point.x * scale, point.y * scale));
    if (subpath.closed) ctx.closePath();
  });
}
function canonicalVectorStrokeMesh(node: CanvasNode): StrokeMesh | undefined {
  const cap = canvasStrokeCap(node.strokeCapStart);
  if (!wasmRuntime || node.kind !== "vector" || !node.vectorPath || !cap || node.strokeCapEnd !== node.strokeCapStart || node.strokeWidth <= 0) return undefined;
  const pathJson = JSON.stringify(node.vectorPath);
  const tolerance = vectorPresentationTolerance(viewport.zoom, dpr);
  const key = `${node.id}:vector-stroke:${tolerance}:${pathJson}:${node.strokeWidth}:${cap}:${node.strokeJoin ?? "miter"}:${node.strokeMiterLimit ?? 10}`;
  const cached = canonicalStrokeMeshes.get(key);
  if (cached !== undefined) return cached ?? undefined;
  // A new zoom-quality bucket must not synchronously tessellate every visible
  // stroke in the middle of a gesture. The caller's native cubic stroke is a
  // smooth interactive preview; the exact aligned mesh is populated by the
  // settled render and reused on the next visit to this bucket.
  if (renderQuality.tier === "interactive") return undefined;
  try {
    const result: unknown = JSON.parse(wasmRuntime.vector_path_stroke_mesh_json(pathJson, tolerance, node.strokeWidth, cap, node.strokeJoin ?? "miter", node.strokeMiterLimit ?? 10));
    const triangles = typeof result === "object" && result !== null && "triangles" in result ? (result as { triangles?: unknown }).triangles : undefined;
    const mesh = Array.isArray(triangles) ? triangles.map((triangle) => {
      if (!Array.isArray(triangle) || triangle.length !== 3) return undefined;
      const points = triangle.map(meshPoint);
      return points.every((point): point is StrokeMeshPoint => Boolean(point)) ? [points[0], points[1], points[2]] as StrokeMeshTriangle : undefined;
    }) : [];
    const resolved = mesh.length > 0 && mesh.every((triangle): triangle is StrokeMeshTriangle => Boolean(triangle)) ? mesh : null;
    if (canonicalStrokeMeshes.size >= 2_048) canonicalStrokeMeshes.clear();
    canonicalStrokeMeshes.set(key, resolved);
    return resolved ?? undefined;
  } catch {
    return undefined;
  }
}
function canonicalVectorStrokeOutline(node: CanvasNode): FlattenedVectorPath | undefined {
  const cap = canvasStrokeCap(node.strokeCapStart);
  if (!wasmRuntime || node.kind !== "vector" || !node.vectorPath || !cap || node.strokeCapEnd !== node.strokeCapStart || node.strokeWidth <= 0) return undefined;
  try {
    const result: unknown = JSON.parse(node.strokeDashPattern?.length
      ? wasmRuntime.vector_path_dashed_outline_json(JSON.stringify(node.vectorPath), .25, node.strokeWidth, JSON.stringify(node.strokeDashPattern), cap, node.strokeJoin ?? "miter", node.strokeMiterLimit ?? 10)
      : wasmRuntime.vector_path_outline_json(JSON.stringify(node.vectorPath), .25, node.strokeWidth, cap, node.strokeJoin ?? "miter", node.strokeMiterLimit ?? 10));
    const subpaths = typeof result === "object" && result !== null && "subpaths" in result && Array.isArray((result as { subpaths?: unknown }).subpaths)
      ? (result as { subpaths: unknown[] }).subpaths.map((subpath) => {
        if (typeof subpath !== "object" || subpath === null || !("closed" in subpath) || !("points" in subpath) || (subpath as { closed?: unknown }).closed !== true || !Array.isArray((subpath as { points?: unknown }).points)) return undefined;
        const points = (subpath as { points: unknown[] }).points.map(meshPoint);
        return points.length >= 3 && points.every((point): point is StrokeMeshPoint => Boolean(point)) ? { closed: true, points } : undefined;
      })
      : undefined;
    return subpaths?.length && subpaths.every((subpath): subpath is { closed: boolean; points: StrokeMeshPoint[] } => Boolean(subpath)) ? { subpaths } : undefined;
  } catch {
    return undefined;
  }
}
function canonicalLineStrokeOutline(node: CanvasNode): FlattenedVectorPath | undefined {
  const startCap = canvasStrokeCap(node.strokeCapStart);
  const dashed = node.strokeDashPattern?.length;
  if (!wasmRuntime || node.kind !== "line" || node.strokeWidth <= 0 || node.width <= 0 || (dashed && (!startCap || startCap !== canvasStrokeCap(node.strokeCapEnd)))) return undefined;
  try {
    const result: unknown = JSON.parse(dashed
      ? wasmRuntime.dashed_line_outline_json(node.width, node.strokeWidth, JSON.stringify(node.strokeDashPattern), startCap!, node.strokeJoin ?? "miter", node.strokeMiterLimit ?? 10)
      : wasmRuntime.line_outline_json(node.width, node.strokeWidth, node.strokeCapStart ?? "none", node.strokeCapEnd ?? "none", node.strokeJoin ?? "miter", node.strokeMiterLimit ?? 10));
    const subpaths = typeof result === "object" && result !== null && "subpaths" in result && Array.isArray((result as { subpaths?: unknown }).subpaths)
      ? (result as { subpaths: unknown[] }).subpaths.map((subpath) => {
        if (typeof subpath !== "object" || subpath === null || !("closed" in subpath) || !("points" in subpath) || (subpath as { closed?: unknown }).closed !== true || !Array.isArray((subpath as { points?: unknown }).points)) return undefined;
        const points = (subpath as { points: unknown[] }).points.map(meshPoint);
        return points.length >= 3 && points.every((point): point is StrokeMeshPoint => Boolean(point)) ? { closed: true, points } : undefined;
      })
      : undefined;
    return subpaths?.length && subpaths.every((subpath): subpath is { closed: boolean; points: StrokeMeshPoint[] } => Boolean(subpath)) ? { subpaths } : undefined;
  } catch {
    return undefined;
  }
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
function orderedEffects(node: CanvasNode): readonly NonNullable<CanvasNode["effectStack"]>[number][] {
  return node.effectStack?.length ? node.effectStack : node.dropShadow ? [{ dropShadow: node.dropShadow }] : [];
}
function applyDropShadow(ctx: OffscreenCanvasRenderingContext2D, shadow: CanvasNode["dropShadow"]) {
  if (!shadow?.visible || shadow.color.alpha <= 0) return;
  ctx.shadowColor = colorToSrgbCss(shadow.color);
  ctx.shadowOffsetX = shadow.offsetX * viewport.zoom;
  ctx.shadowOffsetY = shadow.offsetY * viewport.zoom;
  // Canvas 2D has no native spread field. For the R3 single-shadow slice, a
  // positive spread deterministically widens the blur kernel; E1's offscreen
  // pass will replace this with an exact morphology step.
  ctx.shadowBlur = Math.max(0, shadow.blurRadius + Math.max(0, shadow.spread) * 2) * viewport.zoom;
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
function renderNode(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, compositeMode?: GlobalCompositeOperation) {
  if (
    (isFrameLike(node) || node.kind === "rectangle") &&
    !node.assetId &&
    !hasVisibleFill(node) &&
    !hasVisibleStroke(node)
  )
    return;
  const effects = orderedEffects(node);
  if (!effects.length) {
    ctx.save();
    ctx.globalCompositeOperation = compositeMode ?? canvasCompositeMode(node.blendMode);
    renderNodePaint(ctx, node);
    ctx.restore();
    return;
  }
  if (renderQuality.tier === "interactive") {
    // Ordered inner/multi-shadow stacks use full-surface composition. During a
    // page switch or viewport gesture, paint the source plus at most one native
    // drop shadow immediately; the scheduled settled pass restores exact effects.
    ctx.save();
    ctx.globalCompositeOperation = compositeMode ?? canvasCompositeMode(node.blendMode);
    renderNodePaint(ctx, node, effects.find((effect) => effect.dropShadow)?.dropShadow);
    ctx.restore();
    return;
  }
  // An alpha-mask source must consume target alpha, not reapply its ordinary
  // layer blend. Mask effects remain on the established surface renderer;
  // only the final source composition is overridden here.
  if (compositeMode) {
    ctx.save();
    ctx.globalCompositeOperation = compositeMode;
    renderNodeWithEffects(ctx, node, effects);
    ctx.restore();
    return;
  }
  renderNodeWithEffects(ctx, node, effects);
}

/** Source paint for both the low-resolution and sharp structural passes.
 * Only expensive effects are deferred; the caller must retain the same
 * ancestor clips and canonical layer order in every published frame. */
function renderNodePreview(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode) {
  if (
    (isFrameLike(node) || node.kind === "rectangle") &&
    !node.assetId &&
    !hasVisibleFill(node) &&
    !hasVisibleStroke(node)
  )
    return;
  ctx.save();
  ctx.globalCompositeOperation = canvasCompositeMode(node.blendMode);
  renderNodePaint(ctx, node);
  ctx.restore();
}

function canvasCompositeMode(mode: CanvasNode["blendMode"]): GlobalCompositeOperation {
  return mode === "multiply" || mode === "screen" || mode === "overlay" || mode === "darken" || mode === "lighten" ? mode : "source-over";
}

function acquireEffectSurfaces(): EffectSurfaces | undefined {
  if (!canvas) return undefined;
  if (effectSurfaces && effectSurfaces.source.width === canvas.width && effectSurfaces.source.height === canvas.height) return effectSurfaces;
  const admission = admitEffectSurfacePool(canvas.width, canvas.height, 3);
  if (!admission.accepted) {
    if (!effectSurfaceLimitReported) {
      diagnostics.record({ category: "renderer", code: `EFFECT_SURFACE_${admission.reason.toUpperCase()}`, documentRevision: revision });
      effectSurfaceLimitReported = true;
    }
    return undefined;
  }
  const source = new OffscreenCanvas(canvas.width, canvas.height);
  const shadow = new OffscreenCanvas(canvas.width, canvas.height);
  const scratch = new OffscreenCanvas(canvas.width, canvas.height);
  const sourceContext = source.getContext("2d");
  const shadowContext = shadow.getContext("2d");
  const scratchContext = scratch.getContext("2d");
  if (!sourceContext || !shadowContext || !scratchContext) return undefined;
  effectSurfaces = { source, sourceContext, shadow, shadowContext, scratch, scratchContext };
  return effectSurfaces;
}

/** Builds the spread-adjusted SourceAlpha mask used by the Canvas shadow pass.
 * This is deliberately separate from `ctx.filter`: Canvas exposes blur but no
 * morphology, while Figma spread must alter alpha before blur and offset. */
function renderSpreadAlphaMask(context: OffscreenCanvasRenderingContext2D, source: OffscreenCanvas, spread: number) {
  context.drawImage(source, 0, 0, width, height);
  if (!Number.isFinite(spread) || spread === 0) return;
  try {
    const pixels = context.getImageData(0, 0, source.width, source.height);
    const alpha = new Uint8ClampedArray(source.width * source.height);
    for (let index = 0; index < alpha.length; index += 1) alpha[index] = pixels.data[index * 4 + 3];
    const morphed = morphAlphaChannel(alpha, source.width, source.height, spread);
    for (let index = 0; index < morphed.length; index += 1) {
      const pixel = index * 4;
      pixels.data[pixel] = 255;
      pixels.data[pixel + 1] = 255;
      pixels.data[pixel + 2] = 255;
      pixels.data[pixel + 3] = morphed[index];
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.putImageData(pixels, 0, 0);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
  } catch {
    // Tainted or resource-constrained canvas input remains on the established
    // blur-only path; the editable document is never modified for rendering.
  }
}

/** A viewport-sized alpha buffer ends at the camera edge, which is not
 * necessarily the shape's edge. Keep simple inset shadows near their actual
 * contour so magnifying a large background cannot add a border to the view. */
function clipInnerShadowToShape(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, shadow: NonNullable<CanvasNode["dropShadow"]>) {
  if ((!isFrameLike(node) && node.kind !== "rectangle") || node.assetId || node.cornerSmoothing || node.opacity !== 1 ||
      (hasVisibleStroke(node) && (node.strokeAlign ?? "inside") !== "inside") ||
      orderedEffects(node).some((effect) => effect.layerBlur?.visible || effect.backgroundBlur?.visible)) return false;
  const hasOpaqueFill = activeFills(node).some((paint) => paint.gradient
    ? paint.gradient.stops.length > 0 && paint.gradient.stops.every((stop) => stop.color.alpha === 1)
    : (paint.color ?? documentColorFromCssHex(paint.css))?.alpha === 1);
  if (!hasOpaqueFill) return false;
  const w = node.width * viewport.zoom;
  const h = node.height * viewport.zoom;
  // Allow the whole offset/spread and a conservative blur tail, plus one
  // device pixel for antialiasing; only the unaffected interior is removed.
  const inset = (Math.max(Math.abs(shadow.offsetX), Math.abs(shadow.offsetY)) + Math.abs(shadow.spread) + Math.max(0, shadow.blurRadius) * 3) * viewport.zoom + 1 / dpr;
  if (inset * 2 >= Math.min(w, h)) return false;
  ctx.save();
  if (!applyNativeAffine(ctx, node)) {
    const point = toScreen(node.x, node.y);
    ctx.translate(point.x + w / 2, point.y + h / 2);
    ctx.rotate(node.rotation * Math.PI / 180);
    ctx.translate(-w / 2, -h / 2);
  }
  const radii = insetCornerRadii(w, h, node.radius * viewport.zoom, node.cornerRadii?.map((radius) => radius * viewport.zoom) as CanvasNode["cornerRadii"], inset);
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.roundRect(inset, inset, w - inset * 2, h - inset * 2, radii ?? Math.max(0, node.radius * viewport.zoom - inset));
  ctx.clip("evenodd");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return true;
}

/** Composites ordered Drop Shadows from a reusable source/shadow surface pair.
 * The source is painted once, every tinted/blurred shadow is composited behind
 * it, and the source is finally drawn exactly once to avoid alpha darkening. */
function renderNodeWithEffects(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, effects: readonly NonNullable<CanvasNode["effectStack"]>[number][]) {
  if (node.visible === false || node.kind === "group" || node.kind === "slice") return;
  const surfaces = acquireEffectSurfaces();
  if (!surfaces) {
    // A resource limit remains visible through diagnostics; preserve the R3
    // compatibility projection instead of allocating an unbounded surface.
    ctx.save();
    ctx.globalCompositeOperation = canvasCompositeMode(node.blendMode);
    renderNodePaint(ctx, node, effects.find((effect) => effect.dropShadow)?.dropShadow);
    ctx.restore();
    return;
  }
  let source = surfaces.source;
  let sourceContext = surfaces.sourceContext;
  let target = surfaces.shadow;
  let targetContext = surfaces.shadowContext;
  sourceContext.save(); sourceContext.setTransform(dpr, 0, 0, dpr, 0, 0); sourceContext.clearRect(0, 0, width, height); renderNodePaint(sourceContext, node); sourceContext.restore();
  for (const effect of effects) {
    targetContext.save();
    targetContext.setTransform(dpr, 0, 0, dpr, 0, 0);
    targetContext.clearRect(0, 0, width, height);
    if (effect.layerBlur) {
      if (!effect.layerBlur.visible || effect.layerBlur.radius <= 0) { targetContext.drawImage(source, 0, 0, width, height); }
      else { targetContext.filter = `blur(${effect.layerBlur.radius * viewport.zoom}px)`; targetContext.drawImage(source, 0, 0, width, height); }
    } else if (effect.dropShadow) {
      const shadow = effect.dropShadow;
      if (shadow.visible && shadow.color.alpha > 0) {
        renderSpreadAlphaMask(targetContext, source, shadow.spread * viewport.zoom);
        const scratch = surfaces.scratch;
        const scratchContext = surfaces.scratchContext;
        scratchContext.save();
        scratchContext.setTransform(dpr, 0, 0, dpr, 0, 0);
        scratchContext.clearRect(0, 0, width, height);
        scratchContext.filter = `blur(${Math.max(0, shadow.blurRadius) * viewport.zoom}px)`;
        scratchContext.drawImage(target, shadow.offsetX * viewport.zoom, shadow.offsetY * viewport.zoom, width, height);
        scratchContext.filter = "none";
        scratchContext.globalCompositeOperation = "source-in";
        scratchContext.fillStyle = colorToSrgbCss(shadow.color);
        scratchContext.fillRect(0, 0, width, height);
        scratchContext.restore();
        targetContext.clearRect(0, 0, width, height);
        targetContext.drawImage(scratch, 0, 0, width, height);
      }
      // The blurred, tinted alpha is already in `target`. Put the untouched
      // source *over* it: `destination-over` puts the source behind the
      // shadow and lets blur visible beneath the fill read as an inner shadow
      // whenever Frame clipping selects this Canvas renderer path.
      targetContext.globalCompositeOperation = "source-over";
      targetContext.drawImage(source, 0, 0, width, height);
    } else if (effect.innerShadow) {
      const shadow = effect.innerShadow;
      if (shadow.visible && shadow.color.alpha > 0) {
        // An inset shadow shades the gap around an offset alpha mask. Positive
        // spread shrinks that mask, widening the inner edge in device pixels.
        renderSpreadAlphaMask(targetContext, source, -shadow.spread * viewport.zoom * dpr);
        const scratch = surfaces.scratch;
        const scratchContext = surfaces.scratchContext;
        scratchContext.save();
        scratchContext.setTransform(dpr, 0, 0, dpr, 0, 0);
        scratchContext.clearRect(0, 0, width, height);
        scratchContext.filter = `blur(${Math.max(0, shadow.blurRadius) * viewport.zoom}px)`;
        scratchContext.drawImage(target, shadow.offsetX * viewport.zoom, shadow.offsetY * viewport.zoom, width, height);
        scratchContext.filter = "none";
        // Keep the colored complement of the shifted mask, then clip it to
        // the source. Intersecting both masks instead tints the entire opaque
        // interior (notably turning a white 1px inset into a white overlay).
        scratchContext.globalCompositeOperation = "source-out";
        scratchContext.fillStyle = colorToSrgbCss(shadow.color);
        scratchContext.fillRect(0, 0, width, height);
        scratchContext.globalCompositeOperation = "destination-in";
        scratchContext.drawImage(source, 0, 0, width, height);
        scratchContext.restore();
        // The source pool normally rests at the identity transform.
        sourceContext.save();
        sourceContext.setTransform(dpr, 0, 0, dpr, 0, 0);
        const clippedToShape = clipInnerShadowToShape(sourceContext, node, shadow);
        compositeEffectSurface(sourceContext, scratch, { width, height, dpr });
        if (clippedToShape) sourceContext.restore();
        sourceContext.restore();
        targetContext.clearRect(0, 0, width, height);
      } else targetContext.drawImage(source, 0, 0, width, height);
    }
    else if (effect.backgroundBlur) {
      const blur = effect.backgroundBlur;
      if (blur.visible && blur.radius > 0 && renderQuality.tier === "settled") {
        targetContext.filter = `blur(${blur.radius * viewport.zoom}px)`;
        targetContext.drawImage(ctx.canvas, 0, 0, width, height);
        targetContext.filter = "none";
        targetContext.globalCompositeOperation = "destination-in";
        targetContext.drawImage(source, 0, 0, width, height);
        targetContext.globalCompositeOperation = "source-over";
        targetContext.drawImage(source, 0, 0, width, height);
      } else {
        // Background blur samples the complete backing store. During a zoom or
        // pan gesture that full-surface filter is immediately obsolete and can
        // dominate the frame budget. Keep the source visible while interacting;
        // scheduleSettledRenderQuality restores the exact blur after 160 ms.
        targetContext.drawImage(source, 0, 0, width, height);
      }
    }
    targetContext.restore();
    if (!effect.innerShadow || !effect.innerShadow.visible || effect.innerShadow.color.alpha <= 0) {
      [source, target] = [target, source];
      [sourceContext, targetContext] = [targetContext, sourceContext];
    }
  }
  compositeEffectSurface(ctx, source, { width, height, dpr }, canvasCompositeMode(node.blendMode));
}

/** Renders one node's source paint, optionally through the legacy/single
 * shadow path. Multi-shadow composition is performed by the wrapper above. */
function renderNodePaint(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, shadow?: CanvasNode["dropShadow"]) {
  if (node.visible === false) return;
  if (node.kind === "group" || node.kind === "slice" || node.kind === "slideGrid" || node.kind === "slideRow" || node.kind === "transformGroup") return;
  if (node.kind === "booleanOperation") {
    renderBooleanOperation(ctx, node, shadow);
    return;
  }
  const point = toScreen(node.x, node.y);
  const w = node.width * viewport.zoom;
  const h = node.height * viewport.zoom;
  if (node.kind === "line" || node.kind === "connector") {
    ctx.save();
    ctx.globalAlpha = node.opacity;
    if (!applyNativeAffine(ctx, node)) {
      ctx.translate(point.x, point.y);
      ctx.rotate(node.rotation * Math.PI / 180);
    }
    applyDropShadow(ctx, shadow);
    applyStrokeStyle(ctx, node);
    const connectorPath = node.kind === "connector" ? connectorPathForNode(node) : undefined;
    if (connectorPath) {
      const strokeWidth = Math.max(1, node.strokeWidth * viewport.zoom);
      ctx.lineWidth = strokeWidth;
      ctx.lineCap = node.strokeCapStart === node.strokeCapEnd && (node.strokeCapStart === "round" || node.strokeCapStart === "square")
        ? node.strokeCapStart
        : "butt";
      ctx.beginPath();
      traceConnectorPath(ctx, connectorPath, viewport.zoom);
      activeStrokes(node).forEach((layer) => {
        ctx.strokeStyle = paintStackStyle(ctx, layer, Math.max(w, 1), Math.max(h, 1));
        ctx.stroke();
        ctx.fillStyle = ctx.strokeStyle;
        renderConnectorEndpointDecorations(ctx, node, connectorPath, node.strokeWidth * viewport.zoom, viewport.zoom);
      });
      renderConnectorLabel(ctx, node, connectorPath);
      ctx.restore();
      return;
    }
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
  applyDropShadow(ctx, shadow);
  applyStrokeStyle(ctx, node);
  const paint = fillStyle(ctx, node, w, h);
  if (node.assetId) {
    const geometry = resolveInsideRoundedRect(w, h, node.radius * viewport.zoom, 0);
    const alignedEllipse = node.kind === "ellipse" && !node.arcData;
    const align = node.strokeAlign ?? "inside";
    const strokeWidth = node.strokeWidth * viewport.zoom;
    const ring = alignedEllipse && hasVisibleStroke(node) ? ellipseStrokeRing(w, h, strokeWidth, align) : undefined;
    const imageRectangleStrokeMesh = !alignedEllipse
      && (isFrameLike(node) || node.kind === "rectangle")
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
  } else if ((node.kind === "polygon" || node.kind === "star") && node.parametricShape) {
    const points = canonicalParametricOutline(node, w, h);
    ctx.beginPath();
    points.forEach((point, index) => index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y));
    ctx.closePath();
    fillPaintStack(ctx, node, w, h);
    if (hasVisibleStroke(node)) {
      const mesh = canonicalParametricStrokeMesh(node, w, h);
      if (mesh) fillCanonicalStrokeMesh(ctx, node, mesh, w, h);
      else {
        ctx.lineWidth = Math.max(1, node.strokeWidth * viewport.zoom);
        strokePaintStack(ctx, node, w, h);
      }
    }
  } else if (node.kind === "vector" && node.vectorPath) {
    ctx.beginPath();
    // Canvas and SVG both understand cubic Beziers natively. Rendering the
    // Canonical handles directly avoids magnifying a document-space flattening
    // tolerance into visible facets at high zoom. Rust flattening remains the
    // bounded source for bounds, hit testing, Boolean and outline operations.
    traceVectorPath(ctx, node.vectorPath, viewport.zoom);
    const fillRule = node.vectorPath.fillRule === "evenOdd" ? "evenodd" : "nonzero";
    activeFills(node).forEach((layer) => { ctx.fillStyle = paintStackStyle(ctx, layer, w, h); ctx.fill(fillRule); });
    if (hasVisibleStroke(node)) {
      const mesh = canonicalVectorStrokeMesh(node);
      if (mesh) fillScaledCanonicalStrokeMesh(ctx, node, mesh, w, h, viewport.zoom);
      else {
        ctx.lineWidth = Math.max(1, node.strokeWidth * viewport.zoom);
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
  } else if (node.kind === "codeBlock") {
    const geometry = resolveInsideRoundedRect(w, h, node.radius * viewport.zoom, node.strokeWidth * viewport.zoom);
    roundedRectPath(ctx, 0, 0, w, h, geometry.outerRadius);
    fillPaintStack(ctx, node, w, h);
    if (hasVisibleStroke(node)) {
      ctx.lineWidth = Math.max(1, node.strokeWidth * viewport.zoom);
      strokePaintStack(ctx, node, w, h);
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(10 * viewport.zoom, 10 * viewport.zoom, Math.max(0, w - 20 * viewport.zoom), Math.max(0, h - 20 * viewport.zoom)); ctx.clip();
    ctx.fillStyle = "#e2e8f0";
    ctx.font = `${14 * viewport.zoom}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textBaseline = "top";
    (node.text ?? "").split(/\r?\n/u).forEach((line, index) => ctx.fillText(line, 10 * viewport.zoom, (10 + index * 20) * viewport.zoom));
    ctx.restore();
  } else if (node.kind === "text") {
    const primaryStyle = node.textProperties?.runs[0];
    const fallbackFonts = node.textProperties?.fallbackFonts;
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
      color: primaryStyle.color,
    } : { fontSize: 31, fontWeight: canvasDesignTokens.typography.canvasText.weight, italic: false, letterSpacing: 0 };
    ctx.fillStyle = paint;
    applyCanvasTextStyle(ctx, primaryRenderStyle, fallbackFonts);
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
        applyCanvasTextStyle(ctx, primaryRenderStyle, fallbackFonts);
        const lineBaseline = cssLineBoxBaseline(ctx, lineY, lineHeight);
        ctx.direction = line.direction;
        const alignment = node.textProperties?.paragraph.alignment ?? "left";
        if (spans.length <= 1) {
          const style = spans[0]?.style ?? primaryRenderStyle;
          applyCanvasTextStyle(ctx, style, fallbackFonts);
          ctx.fillStyle = style.color ? colorToSrgbCss(style.color) : paint;
          ctx.textAlign = alignment === "center" ? "center" : alignment === "right" || line.direction === "rtl" ? "right" : "left";
          const x = alignment === "center" ? textMetrics.width / 2 : alignment === "right" || line.direction === "rtl" ? textMetrics.width : 0;
          ctx.fillText(line.text, x, lineBaseline);
        } else {
          const shapedVisualRuns = "visualRuns" in line && Array.isArray(line.visualRuns)
            ? line.visualRuns as RustTextVisualRun[]
            : undefined;
          const visualSpans = shapedVisualRuns
            ? styledTextVisualSpans(source, line.start, line.end, node.textProperties, shapedVisualRuns)
            : (line.direction === "rtl"
              ? [...spans].reverse().map((span) => ({ ...span, direction: "rtl" as const }))
              : spans.map((span) => ({ ...span, direction: "ltr" as const })));
          // The parser guarantees complete visual runs for the shaped path;
          // keep the established logical drawing as a defensive boot fallback.
          const drawableSpans = visualSpans.length ? visualSpans : spans.map((span) => ({ ...span, direction: line.direction }));
          ctx.textAlign = "left";
          const measured = drawableSpans.map((span) => {
            applyCanvasTextStyle(ctx, span.style, fallbackFonts);
            return ctx.measureText(span.text).width;
          });
          const lineWidth = measured.reduce((sum, width) => sum + width, 0);
          let x = alignment === "center" ? (textMetrics.width - lineWidth) / 2 : alignment === "right" || line.direction === "rtl" ? textMetrics.width - lineWidth : 0;
          drawableSpans.forEach((span, index) => {
            applyCanvasTextStyle(ctx, span.style, fallbackFonts);
            ctx.direction = span.direction;
            ctx.fillStyle = span.style.color ? colorToSrgbCss(span.style.color) : paint;
            ctx.fillText(span.text, x, lineBaseline);
            x += measured[index];
          });
        }
      }
      lineY += lineHeight;
      previousEnd = line.end;
    });
    ctx.restore();
  } else if (node.kind === "textPath") {
    const fontSize = (node.textProperties?.runs[0]?.fontSize ?? 14) * viewport.zoom;
    const glyphs = layoutTextPath(node, Math.max(1, (node.textProperties?.runs[0]?.fontSize ?? 14) * .6));
    if (glyphs) {
      ctx.save();
      ctx.fillStyle = paint;
      ctx.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      glyphs.forEach((glyph) => {
        ctx.save();
        ctx.translate(glyph.x * viewport.zoom, glyph.y * viewport.zoom);
        ctx.rotate(glyph.angle);
        ctx.fillText(glyph.text, 0, 0);
        ctx.restore();
      });
      ctx.restore();
    }
  } else {
    const geometry = resolveInsideRoundedRect(w, h, node.radius * viewport.zoom, node.strokeWidth * viewport.zoom);
    if (
      (isFrameLike(node) || node.kind === "rectangle") &&
      !hasVisibleStroke(node) &&
      geometry.outerRadius === 0 &&
      !node.cornerRadii?.some((radius) => radius > 0) &&
      !node.cornerSmoothing
    ) {
      // Most imported DOM containers are square, solid rectangles. A retained
      // path plus fill forces expensive full-surface path rasterization for
      // every nested background; fillRect maps to the browser's optimized
      // rectangular paint and is pixel-identical for this geometry.
      activeFills(node).forEach((layer) => {
        ctx.fillStyle = paintStackStyle(ctx, layer, w, h);
        ctx.fillRect(0, 0, w, h);
      });
    } else if (node.kind === "shapeWithText" && traceShapeWithTextPath(ctx, node.shapeWithTextType, w, h)) {
      fillPaintStack(ctx, node, w, h);
      if (hasVisibleStroke(node)) {
        ctx.lineWidth = Math.max(1, node.strokeWidth * viewport.zoom);
        strokePaintStack(ctx, node, w, h);
        if (traceShapeWithTextDecorations(ctx, node.shapeWithTextType, w, h)) strokePaintStack(ctx, node, w, h);
      }
    } else if (hasVisibleStroke(node) && node.strokeWeights?.length === 4 && (isFrameLike(node) || node.kind === "rectangle")) {
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
    } else if (hasVisibleStroke(node) && (isFrameLike(node) || node.kind === "rectangle")) {
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
  renderSpecialNodeOverlay(ctx, node, w, h);
  ctx.restore();
}

/** M6's static Canvas representations deliberately make their local content
 * usable without dereferencing a remote provider.  The shared scene compiler
 * separately records a diagnostic whenever the live behavior is unavailable. */
function renderSpecialNodeOverlay(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, width: number, height: number) {
  const fallback = specialNodeFallback(node, "canvas");
  const label = node.kind === "media" ? "▶ Media"
    : node.kind === "embed" ? (node.embedMetadata?.title || node.embedMetadata?.provider || "Embed preview")
      : node.kind === "linkUnfurl" ? (node.linkUnfurlMetadata?.title || node.linkUnfurlMetadata?.provider || "Link preview")
        : node.kind === "interactiveSlideElement" ? `${node.interactiveSlideElementType ?? "Slide"} interaction`
          : node.kind === "textPath" && specialNodeFallback(node, "canvas") ? node.text
            : node.kind === "shapeWithText" || node.kind === "sticky" || node.kind === "tableCell" ? node.text
              : undefined;
  if (!label && node.kind !== "table") return;
  ctx.save();
  ctx.beginPath(); ctx.rect(8 * viewport.zoom, 8 * viewport.zoom, Math.max(0, width - 16 * viewport.zoom), Math.max(0, height - 16 * viewport.zoom)); ctx.clip();
  ctx.fillStyle = node.kind === "media" ? "#f8fafc" : "#1f2937";
  ctx.font = `${Math.max(11, Math.min(18, (node.textProperties?.runs[0]?.fontSize ?? 14) * viewport.zoom))}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textBaseline = "top";
  if (label) ctx.fillText(label, 10 * viewport.zoom, node.kind === "textPath" ? Math.max(0, height / 2 - 8 * viewport.zoom) : 10 * viewport.zoom);
  if (node.kind === "table" && node.tableMetadata) {
    ctx.strokeStyle = "rgba(71, 85, 105, .45)";
    ctx.lineWidth = Math.max(1, viewport.zoom);
    let cursor = 0;
    node.tableMetadata.columnWidths.slice(0, -1).forEach((track) => { cursor += track * viewport.zoom; ctx.beginPath(); ctx.moveTo(cursor, 0); ctx.lineTo(cursor, height); ctx.stroke(); });
    cursor = 0;
    node.tableMetadata.rowHeights.slice(0, -1).forEach((track) => { cursor += track * viewport.zoom; ctx.beginPath(); ctx.moveTo(0, cursor); ctx.lineTo(width, cursor); ctx.stroke(); });
  }
  if (fallback && (node.kind === "media" || node.kind === "embed" || node.kind === "linkUnfurl" || node.kind === "interactiveSlideElement")) {
    ctx.fillStyle = node.kind === "media" ? "rgba(248,250,252,.72)" : "rgba(71,85,105,.72)";
    ctx.font = `${11 * viewport.zoom}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText("Static preview", 10 * viewport.zoom, Math.max(28 * viewport.zoom, height - 24 * viewport.zoom));
  }
  ctx.restore();
}


function renderBooleanOperation(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, shadow?: CanvasNode["dropShadow"]) {
  const path = canonicalBooleanPath(node);
  const paintSource = booleanOperandNodes(node)[0];
  if (!path || !paintSource) return;
  const point = toScreen(node.x, node.y);
  const width = node.width * viewport.zoom;
  const height = node.height * viewport.zoom;
  ctx.save();
  ctx.globalAlpha = node.opacity * paintSource.opacity;
  if (!applyNativeAffine(ctx, node)) {
    ctx.translate(point.x + width / 2, point.y + height / 2);
    ctx.rotate(node.rotation * Math.PI / 180);
    ctx.translate(-width / 2, -height / 2);
  }
  applyDropShadow(ctx, shadow);
  applyStrokeStyle(ctx, paintSource);
  ctx.beginPath();
  traceFlattenedVectorPath(ctx, path, viewport.zoom);
  fillPaintStack(ctx, paintSource, width, height);
  if (hasVisibleStroke(paintSource)) {
    ctx.lineWidth = Math.max(1, paintSource.strokeWidth * viewport.zoom);
    strokePaintStack(ctx, paintSource, width, height);
  }
  ctx.restore();
}

/** Paint in structural order whenever a Frame owns visible descendants or a
 * G4 alpha mask. A single flat Canvas loop cannot retain either clip while
 * drawing later child layers. Alpha masks render their sibling run into one
 * bounded surface, then use Canvas' source alpha exactly once with
 * `destination-in`; masks never paint as ordinary visible layers. */
function renderFrameClippedTree(
  ctx: OffscreenCanvasRenderingContext2D,
  orderedNodes: readonly CanvasNode[],
  dragPreviewRootIds: ReadonlySet<string> = new Set(),
  reportProgress?: (completed: number, total: number) => void,
) {
  let paintedNodes = 0;
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
  type PaintBounds = { left: number; top: number; right: number; bottom: number };
  const subtreeBounds = new Map<string, PaintBounds | undefined>();
  const combinedBounds = (
    left: PaintBounds | undefined,
    right: PaintBounds | undefined,
  ): PaintBounds | undefined => {
    if (!left) return right;
    if (!right) return left;
    return {
      left: Math.min(left.left, right.left),
      top: Math.min(left.top, right.top),
      right: Math.max(left.right, right.right),
      bottom: Math.max(left.bottom, right.bottom),
    };
  };
  const boundsForSubtree = (node: CanvasNode): PaintBounds | undefined => {
    if (subtreeBounds.has(node.id)) return subtreeBounds.get(node.id);
    const own = nodeBoundsById.get(node.id);
    let combined = own
      ? {
          left: own.x,
          top: own.y,
          right: own.x + own.width,
          bottom: own.y + own.height,
        }
      : undefined;
    (children.get(node.id) ?? []).forEach((child) => {
      combined = combinedBounds(combined, boundsForSubtree(child));
    });
    subtreeBounds.set(node.id, combined);
    return combined;
  };
  const frameClipChangesPixels = (
    frame: CanvasNode,
    descendants: readonly CanvasNode[],
  ) => {
    if (
      frame.radius > 0 ||
      frame.cornerSmoothing ||
      frame.cornerRadii?.some((radius) => radius > 0)
    )
      return true;
    const frameBounds = nodeBoundsById.get(frame.id);
    const contentBounds = descendants.reduce<PaintBounds | undefined>(
      (combined, child) =>
        combinedBounds(combined, boundsForSubtree(child)),
      undefined,
    );
    if (!frameBounds || !contentBounds) return false;
    const epsilon = 0.01;
    return (
      contentBounds.left < frameBounds.x - epsilon ||
      contentBounds.top < frameBounds.y - epsilon ||
      contentBounds.right > frameBounds.x + frameBounds.width + epsilon ||
      contentBounds.bottom > frameBounds.y + frameBounds.height + epsilon
    );
  };
  const compositeMaskedSiblings = (destination: OffscreenCanvasRenderingContext2D, mask: CanvasNode, targets: readonly CanvasNode[], depth: number) => {
    if (!targets.length || !canvas) return;
    const admission = admitAlphaMaskSurface(canvas.width, canvas.height, depth);
    // A rejected mask must fail closed rather than accidentally paint its
    // targets unmasked. This keeps a resource-limit event from exposing a
    // layer the document says is clipped.
    if (!admission.accepted) {
      if (!alphaMaskLimitReported) {
        diagnostics.record({ category: "renderer", code: admission.reason === "nesting" ? "ALPHA_MASK_NESTING_LIMIT" : "ALPHA_MASK_SURFACE_LIMIT", documentRevision: revision });
        alphaMaskLimitReported = true;
      }
      return;
    }
    const acquired = acquireAlphaMaskSurface(depth);
    if (!acquired) return;
    const { surface, context: surfaceContext } = acquired;
    // The surface is reused for later sibling runs at this depth. Clear it in
    // device coordinates before restoring the document-space transform.
    surfaceContext.setTransform(1, 0, 0, 1, 0, 0);
    surfaceContext.clearRect(0, 0, surface.width, surface.height);
    surfaceContext.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderSiblings(targets, surfaceContext, depth + 1);
    surfaceContext.save();
    renderNode(surfaceContext, mask, "destination-in");
    surfaceContext.restore();
    destination.save();
    // The temporary surface is already in device pixels, unlike the logical
    // document drawing state maintained by the destination context.
    destination.setTransform(1, 0, 0, 1, 0, 0);
    destination.drawImage(surface, 0, 0);
    destination.restore();
  };
  const renderSiblings = (siblings: readonly CanvasNode[], destination = ctx, depth = 0) => {
    for (let index = 0; index < siblings.length; index += 1) {
      const node = siblings[index];
      if (node.isMask) {
        let end = index + 1;
        while (end < siblings.length && !siblings[end].isMask) end += 1;
        compositeMaskedSiblings(destination, node, siblings.slice(index + 1, end), depth);
        index = end - 1;
        continue;
      }
      renderBranchInto(destination, depth)(node);
    }
  };
  const isSafeRepeatSubtree = (siblings: readonly CanvasNode[]): boolean => siblings.every((node) => {
    const descendants = children.get(node.id) ?? [];
    return !node.isMask
      && !orderedEffects(node).length
      && node.kind !== "booleanOperation"
      && !isFrameLike(node)
      && node.kind !== "group"
      && node.kind !== "transformGroup"
      && !descendants.length;
  });
  const applyRepeatWorldAffine = (destination: OffscreenCanvasRenderingContext2D, matrix: AffineMatrix) => {
    const screen = affineScreenMatrix(matrix, toScreen(0, 0), viewport.zoom);
    destination.transform(
      screen.a,
      screen.b,
      screen.c,
      screen.d,
      screen.e,
      screen.f,
    );
  };
  function renderBranchInto(destination: OffscreenCanvasRenderingContext2D, depth: number, detachedPreview = false) {
    return (node: CanvasNode) => {
      paintedNodes += 1;
      if (paintedNodes === 1 || paintedNodes % 100 === 0)
        reportProgress?.(paintedNodes, orderedNodes.length);
      // A child that has been dragged completely beyond an ancestor Frame's
      // clip stays visible until pointer-up. Omit it from the clipped document
      // pass so it can be rendered once as the detached Figma-style preview.
      if (!detachedPreview && dragPreviewRootIds.has(node.id)) return;
      // A nested mask uses the same bounded offscreen composition path. The
      // destination may itself be an offscreen surface, so defer to the shared
      // sibling renderer rather than painting a mask as an ordinary node.
      if (node.isMask) return;
      if (node.kind === "transformGroup") {
        const descendants = children.get(node.id) ?? [];
        // A derived copy is only painted through this direct Canvas route when
        // each source leaf is free of masks, clipping containers and effects.
        // Those features use offscreen composition that resets its transform;
        // keeping their one-time source plus a diagnostic is safer than
        // silently changing blend or clip order.
        renderSiblings(descendants, destination, depth);
        const canonical = nodes.find((candidate) => candidate.id === node.id);
        const repeats = canonical && isSafeRepeatSubtree(descendants) ? transformGroupRepeatMatrices(nodes, canonical) : undefined;
        repeats?.forEach((matrix) => {
          destination.save();
          applyRepeatWorldAffine(destination, matrix);
          renderSiblings(descendants, destination, depth);
          destination.restore();
        });
        return;
      }
      renderNode(destination, node);
      if (node.kind === "booleanOperation" && canonicalBooleanPath(node)) return;
      const descendants = children.get(node.id) ?? [];
      if (!descendants.length) return;
      if (
        isFrameLike(node) &&
        node.clipsContent !== false &&
        frameClipChangesPixels(node, descendants)
      ) {
        clipFrameContents(destination, node);
        renderSiblings(descendants, destination, depth);
        destination.restore();
        return;
      }
      renderSiblings(descendants, destination, depth);
    };
  }
  renderSiblings(roots);
  // Draw detached preview roots last: this keeps them out of their former
  // Frame's clip and avoids a duplicate in-Frame paint. Their own descendant
  // structure (including clips they own) still uses the normal recursion.
  orderedNodes
    .filter((node) => dragPreviewRootIds.has(node.id))
    .forEach((node) => renderBranchInto(ctx, 0, true)(node));
}

/** This is a presentation-only escape hatch for an active move. The durable
 * document retains its Frame clipping; only a layer fully outside an ancestor
 * Frame gets the visible detached preview expected during a Figma drag. */
function escapedFrameDragPreviewRootIds() {
  if (drag?.mode !== "move") return new Set<string>();
  return new Set([...drag.initial].filter((id) => isFullyClippedForSelection(nodes, id, boundsForNode)));
}

function acquireAlphaMaskSurface(depth: number): AlphaMaskSurface | undefined {
  if (!canvas) return undefined;
  const existing = alphaMaskSurfaces[depth];
  if (existing && existing.surface.width === canvas.width && existing.surface.height === canvas.height) return existing;
  const surface = new OffscreenCanvas(canvas.width, canvas.height);
  const context = surface.getContext("2d");
  if (!context) return undefined;
  const acquired = { surface, context };
  alphaMaskSurfaces[depth] = acquired;
  return acquired;
}

function clipFrameContents(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode) {
  const screenTransform = ctx.getTransform();
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
  // Preserve the destination's basis: previews use a lower DPR than the
  // presentation surface. Restoring the global DPR would misplace both the
  // next ancestor clip and the child in the low-resolution frame.
  ctx.setTransform(screenTransform);
}

function renderEllipseArc(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, width: number, height: number) {
  const arc = node.arcData;
  if (!arc) return;
  const start = arc.startingAngle * Math.PI / 180;
  const end = arc.endingAngle * Math.PI / 180;
  const outerX = width / 2;
  const outerY = height / 2;
  // `1` is a valid Figma ArcData boundary. Keep it exact: the resulting
  // coincident inner/outer contours correctly produce a zero-area fill rather
  // than silently changing the persisted geometry to a very thin donut.
  const innerRadius = Math.max(0, Math.min(1, arc.innerRadius));
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

function renderConnectorEndpointDecorations(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, path: NonNullable<ReturnType<typeof connectorPathForNode>>, strokeWidth: number, scale: number) {
  connectorEndpointDecorations(node, path).forEach((decoration) => {
    ctx.beginPath();
    connectorDecorationTriangles(decoration, strokeWidth).forEach(([a, b, c]) => {
      const transform = (point: { x: number; y: number }) => ({
        x: decoration.point.x * scale + point.x * decoration.direction.x - point.y * decoration.direction.y,
        y: decoration.point.y * scale + point.x * decoration.direction.y + point.y * decoration.direction.x,
      });
      const first = transform(a); const second = transform(b); const third = transform(c);
      ctx.moveTo(first.x, first.y); ctx.lineTo(second.x, second.y); ctx.lineTo(third.x, third.y); ctx.closePath();
    });
    ctx.fill();
  });
}

function renderConnectorLabel(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, path: NonNullable<ReturnType<typeof connectorPathForNode>>) {
  const label = connectorLabelLayout(node, path);
  if (!label) return;
  const x = label.x * viewport.zoom; const y = label.y * viewport.zoom;
  const width = label.width * viewport.zoom; const height = label.height * viewport.zoom;
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,.94)";
  ctx.fillRect(x - width / 2, y - height / 2, width, height);
  ctx.fillStyle = "#0f172a";
  ctx.font = `${12 * viewport.zoom}px ${canvasDesignTokens.typography.canvasText.family}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lineHeight = 16 * viewport.zoom;
  const firstBaseline = y - (label.lines.length - 1) * lineHeight / 2;
  label.lines.forEach((line, index) => ctx.fillText(line, x, firstBaseline + index * lineHeight, Math.max(0, width - 8 * viewport.zoom)));
  ctx.restore();
}

function applyCanvasTextStyle(ctx: OffscreenCanvasRenderingContext2D, style: RenderTextStyle, fallbackFonts?: readonly DocumentFontReference[]) {
  const fontFamilies = documentFontFamilyChain(style.font, fallbackFonts, (assetId) => fontFaces.familyFor(assetId));
  ctx.font = `${style.italic ? "italic " : ""}${style.fontWeight} ${style.fontSize * viewport.zoom}px ${fontFamilies ? `${fontFamilies}, ` : ""}${canvasDesignTokens.typography.canvasText.family}`;
  const letterSpacingTarget = ctx as unknown as { letterSpacing?: string };
  if ("letterSpacing" in letterSpacingTarget) letterSpacingTarget.letterSpacing = `${style.letterSpacing * viewport.zoom}px`;
  // This Canvas property is not exposed in every lib.dom version. Reset it for
  // unvaried spans so a preceding Style Run cannot leak its axes into the next.
  const variationTarget = ctx as unknown as { fontVariationSettings?: string };
  if ("fontVariationSettings" in variationTarget) variationTarget.fontVariationSettings = fontVariationCss(style.font?.variationAxes);
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
      color: primary.color,
  } : { fontSize: 31, fontWeight: canvasDesignTokens.typography.canvasText.weight, italic: false, letterSpacing: 0 };
  const source = node.text ?? "";
  const sourceBytes = new TextEncoder().encode(source);
  applyCanvasTextStyle(ctx, primaryStyle, properties.fallbackFonts);
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
      applyCanvasTextStyle(ctx, spans[0]?.style ?? primaryStyle, properties.fallbackFonts);
      widest = Math.max(widest, ctx.measureText(line.text).width);
    } else {
      const measured = spans.reduce((total, span) => {
        applyCanvasTextStyle(ctx, span.style, properties.fallbackFonts);
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
    if (["frame", "component", "group", "section"].includes(node.kind)) return { pageId: node.pageId ?? activePageId, parentId: node.id };
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
function rotateHandleAtScreen(screenX: number, screenY: number): { pivot: { x: number; y: number }; ids: string[] } | undefined {
  // Corners deliberately take precedence over resize: unlike the edge-centre
  // handles, they are the visible rotation affordance and keep Group
  // selections rotatable through their existing multi-selection bounds.
  const multi = multiResizeHandleAtScreen(screenX, screenY);
  if (multi && isCornerResizeHandle(multi.handle)) {
    return {
      pivot: { x: multi.bounds.x + multi.bounds.width / 2, y: multi.bounds.y + multi.bounds.height / 2 },
      ids: [...selectedIds],
    };
  }
  const resize = resizeHandleAtScreen(screenX, screenY);
  if (!resize || !isCornerResizeHandle(resize.handle)) return undefined;
  return {
    pivot: resizeHandleWorldPoint(resize.node, resize.node.width / 2, resize.node.height / 2),
    ids: [resize.node.id],
  };
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
/** Vector anchors and tangent handles are presentation-only overlays. Their
 * coordinates remain local to the canonical node; the world transform is
 * applied only for paint. */
function renderVectorAnchorOverlay(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode) {
  const canonical = nodes.find((candidate) => candidate.id === node.id);
  if (!canonical || canonical.kind !== "vector" || !canonical.vectorPath || selectedIds.length !== 1) return;
  const transform = worldTransformForNode(nodes, canonical.id);
  if (!transform) return;
  const radius = Math.max(3, canvasDesignTokens.overlay.selectionHandle.side / 2 - 1);
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = canvasDesignTokens.color.selection;
  ctx.lineWidth = canvasDesignTokens.stroke.selection.width;
  canonical.vectorPath.subpaths.forEach((subpath) => subpath.points.forEach((anchor) => {
    const world = transformPoint(transform, { x: anchor.x, y: anchor.y });
    const screen = toScreen(world.x, world.y);
    [anchor.handleIn, anchor.handleOut].forEach((handle) => {
      if (!handle) return;
      const handleWorld = transformPoint(transform, { x: anchor.x + handle.x, y: anchor.y + handle.y });
      const handleScreen = toScreen(handleWorld.x, handleWorld.y);
      ctx.beginPath();
      ctx.moveTo(screen.x, screen.y);
      ctx.lineTo(handleScreen.x, handleScreen.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.rect(handleScreen.x - radius + 1, handleScreen.y - radius + 1, (radius - 1) * 2, (radius - 1) * 2);
      ctx.fill();
      ctx.stroke();
    });
    const isSelected = selectedVectorPoints.some((target) => target.id === canonical.id && target.pointId === anchor.id);
    if (isSelected) ctx.fillStyle = canvasDesignTokens.color.selection;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (isSelected) ctx.fillStyle = "#ffffff";
  }));
  ctx.restore();
}
/** Draw the pending Pen segment without adding it to the draft path. This
 * gives click-click drawing an immediate directional preview while preserving
 * the invariant that only a deliberate pointer-down produces a PointId. */
function renderPenDraftPreview(ctx: OffscreenCanvasRenderingContext2D) {
  const draft = penDraft;
  const preview = draft?.previewWorld;
  if (!draft || !preview || !Number.isFinite(preview.x) || !Number.isFinite(preview.y)) return;
  const subpathIndex = draft.kind === "extend" ? draft.subpathIndex : 0;
  const point = draft.node.vectorPath?.subpaths[subpathIndex ?? 0]?.points.find((candidate) => candidate.id === draft.lastPointId);
  const transform = point && worldTransformForNode(nodes, draft.node.id);
  if (!point || !transform) return;
  const startWorld = transformPoint(transform, { x: point.x, y: point.y });
  const start = toScreen(startWorld.x, startWorld.y);
  const end = toScreen(preview.x, preview.y);
  const handleOutWorld = point.handleOut
    ? transformPoint(transform, { x: point.x + point.handleOut.x, y: point.y + point.handleOut.y })
    : undefined;
  const handleOut = handleOutWorld && toScreen(handleOutWorld.x, handleOutWorld.y);
  ctx.save();
  ctx.strokeStyle = canvasDesignTokens.color.selection;
  ctx.fillStyle = "#ffffff";
  ctx.lineWidth = canvasDesignTokens.stroke.selection.width;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  // A dragged anchor already owns an outgoing tangent. Preview the next cubic
  // against that tangent, using the cursor as the unresolved arriving control
  // point, so the intent is visible before the next PointId exists.
  if (handleOut) ctx.bezierCurveTo(handleOut.x, handleOut.y, end.x, end.y, end.x, end.y);
  else ctx.lineTo(end.x, end.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(end.x, end.y, Math.max(3, canvasDesignTokens.overlay.selectionHandle.side / 2 - 1), 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
function vectorAnchorAtScreen(screenX: number, screenY: number): { id: string; pointId: string } | undefined {
  const selected = selectedIds.length === 1 ? nodes.find((node) => node.id === selectedIds[0]) : undefined;
  if (!selected || selected.kind !== "vector" || !selected.vectorPath || selected.locked || selected.visible === false) return undefined;
  const transform = worldTransformForNode(nodes, selected.id);
  if (!transform) return undefined;
  const hitRadius = canvasDesignTokens.overlay.selectionHandle.hitRadius;
  const hit = selected.vectorPath.subpaths
    .flatMap((subpath) => subpath.points)
    .map((anchor) => {
      const world = transformPoint(transform, { x: anchor.x, y: anchor.y });
      const screen = toScreen(world.x, world.y);
      return { pointId: anchor.id, distance: Math.hypot(screenX - screen.x, screenY - screen.y) };
    })
    .filter(({ distance }) => distance <= hitRadius)
    .sort((left, right) => left.distance - right.distance)[0];
  return hit ? { id: selected.id, pointId: hit.pointId } : undefined;
}
function vectorHandleAtScreen(screenX: number, screenY: number): { id: string; pointId: string; handle: "handleIn" | "handleOut" } | undefined {
  const selected = selectedIds.length === 1 ? nodes.find((node) => node.id === selectedIds[0]) : undefined;
  if (!selected || selected.kind !== "vector" || !selected.vectorPath || selected.locked || selected.visible === false) return undefined;
  const transform = worldTransformForNode(nodes, selected.id);
  if (!transform) return undefined;
  const hitRadius = canvasDesignTokens.overlay.selectionHandle.hitRadius;
  const hit = selected.vectorPath.subpaths
    .flatMap((subpath) => subpath.points)
    .flatMap((anchor) => (["handleIn", "handleOut"] as const).flatMap((handle) => {
      const offset = anchor[handle];
      if (!offset) return [];
      const world = transformPoint(transform, { x: anchor.x + offset.x, y: anchor.y + offset.y });
      const screen = toScreen(world.x, world.y);
      return [{ pointId: anchor.id, handle, distance: Math.hypot(screenX - screen.x, screenY - screen.y) }];
    }))
    .filter(({ distance }) => distance <= hitRadius)
    .sort((left, right) => left.distance - right.distance)[0];
  return hit ? { id: selected.id, pointId: hit.pointId, handle: hit.handle } : undefined;
}
function localVectorPointAtWorld(node: CanvasNode, world: { x: number; y: number }) {
  const transform = worldTransformForNode(nodes, node.id);
  const inverse = transform && invertAffine(transform);
  return inverse ? transformPoint(inverse, world) : undefined;
}
function vectorSegmentAtScreen(screenX: number, screenY: number): { id: string; subpathIndex: number; afterPointId: string; t: number } | undefined {
  const selected = selectedIds.length === 1 ? nodes.find((node) => node.id === selectedIds[0]) : undefined;
  if (!selected || selected.kind !== "vector" || !selected.vectorPath || selected.locked || selected.visible === false || !wasmRuntime) return undefined;
  const local = localVectorPointAtWorld(selected, toWorld(screenX, screenY));
  if (!local) return undefined;
  const maxDistance = canvasDesignTokens.overlay.selectionHandle.hitRadius / Math.max(viewport.zoom, .01);
  const tolerance = Math.max(.01, Math.min(.25, maxDistance / 4));
  try {
    const value: unknown = JSON.parse(wasmRuntime.vector_path_nearest_segment_json(JSON.stringify(selected.vectorPath), local.x, local.y, tolerance, maxDistance));
    if (typeof value !== "object" || value === null) return undefined;
    const hit = value as { subpathIndex?: unknown; afterPointIndex?: unknown; t?: unknown };
    const subpathIndex = typeof hit.subpathIndex === "number" && Number.isInteger(hit.subpathIndex) ? hit.subpathIndex : undefined;
    const afterPointIndex = typeof hit.afterPointIndex === "number" && Number.isInteger(hit.afterPointIndex) ? hit.afterPointIndex : undefined;
    const t = typeof hit.t === "number" && Number.isFinite(hit.t) && hit.t > 0 && hit.t < 1 ? hit.t : undefined;
    if (subpathIndex === undefined || afterPointIndex === undefined || t === undefined) return undefined;
    const subpath = selected.vectorPath.subpaths[subpathIndex];
    const afterPoint = subpath?.points[afterPointIndex];
    return afterPoint ? { id: selected.id, subpathIndex, afterPointId: afterPoint.id, t } : undefined;
  } catch {
    return undefined;
  }
}
function replacePenDraftNode(node: CanvasNode) {
  if (!penDraft) return;
  penDraft.node = node;
  nodes = nodes.map((candidate) => candidate.id === node.id ? node : candidate);
  transientSceneVersion += 1;
  rebuildNodeIndex();
  render();
}
function cancelPenDraft() {
  if (!penDraft) return false;
  const { kind, node, originalVectorPath, previousSelection } = penDraft;
  penDraft = undefined;
  nodes = kind === "create"
    ? nodes.filter((candidate) => candidate.id !== node.id)
    : nodes.map((candidate) => candidate.id === node.id ? { ...candidate, vectorPath: originalVectorPath } : candidate);
  selectedIds = previousSelection;
  transientSceneVersion += 1;
  rebuildNodeIndex();
  render();
  emitSnapshot(undefined, false);
  return true;
}
function finishPenDraft() {
  if (!penDraft) return false;
  const draft = penDraft;
  const { kind, node, previousSelection } = draft;
  const pointCount = node.vectorPath?.subpaths[0]?.points.length ?? 0;
  if (kind === "create" && pointCount < 2) return cancelPenDraft();
  penDraft = undefined;
  nodes = kind === "create"
    ? nodes.filter((candidate) => candidate.id !== node.id)
    : nodes.map((candidate) => candidate.id === node.id ? { ...candidate, vectorPath: draft.originalVectorPath } : candidate);
  selectedIds = previousSelection;
  transientSceneVersion += 1;
  rebuildNodeIndex();
  if (kind === "create") dispatch({ type: "create", node });
  else if ((draft.insertedPoints.length || draft.connectTarget) && wasmDocument && draft.subpathIndex !== undefined && draft.endpoint) {
    const connectTarget = draft.connectTarget;
    if (connectTarget?.kind === "cross-vector") {
      const source = nodes.find((candidate) => candidate.id === connectTarget.nodeId);
      const joined = source && joinCrossVectorEndpoints(
        nodes,
        node,
        { subpathIndex: draft.subpathIndex, pointId: draft.lastPointId },
        source,
        { subpathIndex: connectTarget.subpathIndex, pointId: connectTarget.pointId },
      );
      if (joined) {
        dispatchTransaction({
          id: createId(),
          baseRevision: Number(wasmDocument.revision),
          commands: [
            { type: "update", id: node.id, patch: { vectorPath: joined.targetPath } },
            ...(joined.sourcePath
              ? [{ type: "update" as const, id: source!.id, patch: { vectorPath: joined.sourcePath } }]
              : [{ type: "delete" as const, ids: [source!.id] }]),
          ],
        });
      } else { render(); emitViewState(); }
      return true;
    }
    let afterPointId = draft.endpoint === "end"
      ? draft.originalVectorPath?.subpaths[draft.subpathIndex]?.points.at(-1)?.id
      : undefined;
    const workingPoints = node.vectorPath?.subpaths[draft.subpathIndex]?.points ?? [];
    const commands: PenCommitCommand[] = draft.insertedPoints.flatMap((inserted) => {
      const point = workingPoints.find((candidate) => candidate.id === inserted.id);
      if (!point) return [];
      const command = { type: "insertVectorPoint" as const, id: node.id, subpathIndex: draft.subpathIndex!, afterPointId, point };
      if (draft.endpoint === "end") afterPointId = point.id;
      return command;
    });
    if (draft.closeOnFinish) commands.push({ type: "setVectorSubpathClosed", id: node.id, subpathIndex: draft.subpathIndex!, closed: true });
    if (draft.connectTarget?.kind === "same-vector") commands.push({
      type: "connectVectorEndpoints",
      id: node.id,
      firstSubpathIndex: draft.subpathIndex!,
      firstPointId: draft.lastPointId,
      secondSubpathIndex: draft.connectTarget.subpathIndex,
      secondPointId: draft.connectTarget.pointId,
    });
    if (commands.length) dispatchTransaction({ id: createId(), baseRevision: Number(wasmDocument.revision), commands });
    else { render(); emitViewState(); }
  } else { render(); emitViewState(); }
  return true;
}
function penDraftClosesAtScreen(screenX: number, screenY: number) {
  const draft = penDraft;
  if (!draft) return false;
  const subpathIndex = draft.kind === "extend" ? draft.subpathIndex! : 0;
  const subpath = draft.node.vectorPath?.subpaths[subpathIndex];
  if (!subpath || subpath.closed || subpath.points.length < 3) return false;
  const closePoint = draft.kind === "create"
    ? subpath.points[0]
    : draft.endpoint === "start"
      ? draft.originalVectorPath?.subpaths[subpathIndex]?.points.at(-1)
      : draft.originalVectorPath?.subpaths[subpathIndex]?.points[0];
  if (!closePoint) return false;
  const transform = worldTransformForNode(nodes, draft.node.id);
  if (!transform) return false;
  const world = transformPoint(transform, { x: closePoint.x, y: closePoint.y });
  const screen = toScreen(world.x, world.y);
  return Math.hypot(screenX - screen.x, screenY - screen.y) <= canvasDesignTokens.overlay.selectionHandle.hitRadius;
}
function penDraftConnectsAtScreen(screenX: number, screenY: number) {
  const draft = penDraft;
  if (!draft || draft.kind !== "extend") return undefined;
  const target = vectorOpenEndpointAtScreen(screenX, screenY);
  if (target?.id === draft.node.id && target.subpathIndex !== draft.subpathIndex && target.pointId !== draft.lastPointId) {
    return { kind: "same-vector" as const, subpathIndex: target.subpathIndex, pointId: target.pointId };
  }
  // The cross-layer join consumes only the clicked source subpath. Any other
  // source subpaths remain in their original layer; an emptied source is
  // deleted atomically with the target-path update.
  const source = vectorOpenEndpointAtScreenForNodes(screenX, screenY, nodes.filter((candidate) => candidate.id !== draft.node.id
    && candidate.kind === "vector"
    && candidate.pageId === draft.node.pageId
    && candidate.parentId === draft.node.parentId
    && candidate.locked !== true
    && candidate.visible !== false));
  return source ? { kind: "cross-vector" as const, nodeId: source.id, subpathIndex: source.subpathIndex, pointId: source.pointId } : undefined;
}
function vectorOpenEndpointAtScreenForNodes(screenX: number, screenY: number, candidates: readonly CanvasNode[]): { id: string; subpathIndex: number; endpoint: "start" | "end"; pointId: string } | undefined {
  const hitRadius = canvasDesignTokens.overlay.selectionHandle.hitRadius;
  const hit = candidates.flatMap((candidate) => {
    if (candidate.kind !== "vector" || !candidate.vectorPath || candidate.locked || candidate.visible === false) return [];
    const transform = worldTransformForNode(nodes, candidate.id);
    if (!transform) return [];
    return candidate.vectorPath.subpaths.flatMap((subpath, subpathIndex) => {
      if (subpath.closed || !subpath.points.length) return [];
      return (["start", "end"] as const).map((endpoint) => {
        const point = endpoint === "start" ? subpath.points[0] : subpath.points.at(-1)!;
        const world = transformPoint(transform, { x: point.x, y: point.y });
        const screen = toScreen(world.x, world.y);
        return { id: candidate.id, subpathIndex, endpoint, pointId: point.id, distance: Math.hypot(screenX - screen.x, screenY - screen.y) };
      });
    });
  }).filter(({ distance }) => distance <= hitRadius).sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id))[0];
  return hit && { id: hit.id, subpathIndex: hit.subpathIndex, endpoint: hit.endpoint, pointId: hit.pointId };
}
function vectorOpenEndpointAtScreen(screenX: number, screenY: number) {
  const selected = selectedIds.length === 1 ? nodes.find((node) => node.id === selectedIds[0]) : undefined;
  return selected ? vectorOpenEndpointAtScreenForNodes(screenX, screenY, [selected]) : undefined;
}
function beginPenExtension(endpoint: { id: string; subpathIndex: number; endpoint: "start" | "end"; pointId: string }) {
  const existing = nodes.find((node) => node.id === endpoint.id);
  if (!existing?.vectorPath) return false;
  const node = structuredClone(existing);
  penDraft = {
    kind: "extend",
    node,
    lastPointId: endpoint.pointId,
    previousSelection: [...selectedIds],
    originalVectorPath: structuredClone(existing.vectorPath),
    subpathIndex: endpoint.subpathIndex,
    endpoint: endpoint.endpoint,
    insertedPoints: [],
  };
  selectedIds = [node.id];
  render();
  return true;
}
function beginPenPoint(world: { x: number; y: number }) {
  const snapped = snapCanvasPoint(world);
  if (!penDraft) {
    const node = createNode("vector", snapped.x, snapped.y);
    const pointId = createId();
    node.name = "Pen";
    node.width = 1;
    node.height = 1;
    node.vectorPath = { fillRule: "nonZero", subpaths: [{ closed: false, points: [{ id: pointId, x: 0, y: 0, pointType: "corner" }] }] };
    penDraft = { kind: "create", node, lastPointId: pointId, previousSelection: [...selectedIds], insertedPoints: [] };
    nodes = [...nodes, node];
    selectedIds = [node.id];
    transientSceneVersion += 1;
    rebuildNodeIndex();
    render();
    return { id: node.id, pointId, start: snapped } as const;
  }
  const local = localVectorPointAtWorld(penDraft.node, snapped);
  const subpathIndex = penDraft.kind === "extend" ? penDraft.subpathIndex! : 0;
  const subpath = penDraft.node.vectorPath?.subpaths[subpathIndex];
  const previous = penDraft.endpoint === "start" ? subpath?.points[0] : subpath?.points.at(-1);
  if (!local || !subpath || !previous || (local.x === previous.x && local.y === previous.y)) return undefined;
  const pointId = createId();
  const node = structuredClone(penDraft.node);
  const point: VectorPoint = { id: pointId, x: local.x, y: local.y, pointType: "corner" };
  const points = node.vectorPath!.subpaths[subpathIndex].points;
  if (penDraft.endpoint === "start") points.unshift(point);
  else points.push(point);
  penDraft.lastPointId = pointId;
  if (penDraft.kind === "extend") penDraft.insertedPoints.push(point);
  replacePenDraftNode(node);
  return { id: node.id, pointId, start: snapped } as const;
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
  if (canonical.kind === "line" || canonical.kind === "connector") {
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

/** Figma-style placement affordance for a drag over an eligible Frame. The
 * tint sits below the dragged selection, while the label makes the hierarchy
 * mutation explicit before the user releases the pointer. */
function renderFrameDropTarget(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, isAutoLayout: boolean) {
  const canonical = nodes.find((candidate) => candidate.id === node.id) ?? node;
  const point = toScreen(canonical.x, canonical.y);
  const targetWidth = canonical.width * viewport.zoom;
  const targetHeight = canonical.height * viewport.zoom;
  ctx.save();
  if (!applyNativeAffine(ctx, canonical)) {
    ctx.translate(point.x + targetWidth / 2, point.y + targetHeight / 2);
    ctx.rotate(canonical.rotation * Math.PI / 180);
    ctx.translate(-targetWidth / 2, -targetHeight / 2);
  }
  ctx.fillStyle = canvasDesignTokens.color.selectionFill;
  ctx.strokeStyle = canvasDesignTokens.color.selection;
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 3]);
  ctx.fillRect(0, 0, targetWidth, targetHeight);
  ctx.strokeRect(1, 1, Math.max(0, targetWidth - 2), Math.max(0, targetHeight - 2));
  ctx.restore();

  const world = worldTransformForNode(nodes, canonical.id);
  if (!world) return;
  const worldAnchor = transformPoint(world, { x: 0, y: 0 });
  const anchor = toScreen(worldAnchor.x, worldAnchor.y);
  const label = `${isAutoLayout ? "Insert into Auto layout" : "Move into Frame"} · ${canonical.name}`;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = canvasFont(canvasDesignTokens.typography.selectionLabel);
  const labelWidth = Math.ceil(ctx.measureText(label).width) + 14;
  const labelX = Math.max(0, Math.min(anchor.x, width - labelWidth));
  const labelY = Math.max(0, anchor.y - 24);
  renderSelectionDimensions(ctx, label, labelX, labelY, labelWidth, 20, 7, 3);
  ctx.restore();
}

/** Shows the exact sibling slot that will be committed when a flow child is
 * released. This is intentionally calculated from the immutable pre-drag
 * scene: the transient geometry follows the pointer, while Auto layout itself
 * owns the final positions after the atomic reposition command. */
function renderAutoLayoutInsertion(ctx: OffscreenCanvasRenderingContext2D, sourceNodes: readonly CanvasNode[], movingIds: readonly string[], point: { x: number; y: number }) {
  const reorder = autoLayoutDropReorder(sourceNodes, movingIds, point);
  if (!reorder?.result) return;
  const { frame, rootIds, result } = reorder;
  const moving = new Set(rootIds);
  const ordered = result.orderedIds;
  const insertionIndex = ordered.findIndex((id) => moving.has(id));
  if (insertionIndex < 0) return;
  const next = ordered.slice(insertionIndex).map((id) => sourceNodes.find((node) => node.id === id)).find((node): node is CanvasNode => Boolean(node) && !moving.has(node!.id));
  const previous = [...ordered.slice(0, insertionIndex)].reverse().map((id) => sourceNodes.find((node) => node.id === id)).find((node): node is CanvasNode => Boolean(node) && !moving.has(node!.id));
  const frameWorld = worldTransformForNode(sourceNodes, frame.id);
  const inverseFrame = frameWorld && invertAffine(frameWorld);
  if (!frameWorld || !inverseFrame) return;
  const localBounds = (node: CanvasNode) => {
    const world = worldTransformForNode(sourceNodes, node.id);
    if (!world) return undefined;
    const corners = [
      transformPoint(inverseFrame, transformPoint(world, { x: 0, y: 0 })),
      transformPoint(inverseFrame, transformPoint(world, { x: node.width, y: 0 })),
      transformPoint(inverseFrame, transformPoint(world, { x: node.width, y: node.height })),
      transformPoint(inverseFrame, transformPoint(world, { x: 0, y: node.height })),
    ];
    return { left: Math.min(...corners.map((corner) => corner.x)), right: Math.max(...corners.map((corner) => corner.x)), top: Math.min(...corners.map((corner) => corner.y)), bottom: Math.max(...corners.map((corner) => corner.y)) };
  };
  const nextBounds = next && localBounds(next);
  const previousBounds = previous && localBounds(previous);
  const [paddingTop, paddingRight, paddingBottom, paddingLeft] = frame.autoLayout!.padding;
  const horizontal = frame.autoLayout!.mode === "horizontal";
  const primary = horizontal
    ? (nextBounds?.left ?? previousBounds?.right ?? paddingLeft)
    : (nextBounds?.top ?? previousBounds?.bottom ?? paddingTop);
  const startLocal = horizontal ? { x: primary, y: paddingTop } : { x: paddingLeft, y: primary };
  const endLocal = horizontal ? { x: primary, y: Math.max(paddingTop, frame.height - paddingBottom) } : { x: Math.max(paddingLeft, frame.width - paddingRight), y: primary };
  const startWorld = transformPoint(frameWorld, startLocal);
  const endWorld = transformPoint(frameWorld, endLocal);
  const start = toScreen(startWorld.x, startWorld.y);
  const end = toScreen(endWorld.x, endWorld.y);
  const flowCount = sortNodesByLayerOrder(sourceNodes.filter((node) => node.parentId === frame.id && !node.autoLayout?.absolute)).length;
  const label = next ? `Insert before ${next.name} · ${insertionIndex + 1} of ${flowCount}` : `Insert at end · ${insertionIndex + 1} of ${flowCount}`;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = canvasDesignTokens.color.selection;
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.lineTo(end.x, end.y); ctx.stroke(); ctx.setLineDash([]);
  ctx.font = canvasFont(canvasDesignTokens.typography.selectionLabel);
  const labelWidth = Math.ceil(ctx.measureText(label).width) + 14;
  const labelX = Math.max(0, Math.min((start.x + end.x) / 2 - labelWidth / 2, width - labelWidth));
  const labelY = Math.max(0, Math.min((start.y + end.y) / 2 - 10, height - 20));
  renderSelectionDimensions(ctx, label, labelX, labelY, labelWidth, 20, 7, 3);
  ctx.restore();
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
  if (canonical.kind === "line" || canonical.kind === "connector") {
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
  } else if (canonical.kind === "text" || isFrameLike(canonical) || canonical.kind === "section") {
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
  if (!showsPersistentCanvasLayerName(node) || selectedIds.includes(node.id)) return;
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

/** Places the single-selection HUD in the selected rectangle's local axes.
 * The outline, its title, and its dimensions therefore keep the same visual
 * relationship while rotating. Multi-selection deliberately remains an
 * axis-aligned aggregate and continues through the fallback below. */
function renderRotatedSingleSelectionLabels(
  ctx: OffscreenCanvasRenderingContext2D,
  node: CanvasNode,
  dimensions: string,
  labelWidth: number,
  labelHeight: number,
  horizontalInset: number,
  cornerRadius: number,
  offsetY: number,
) {
  const canonical = nodes.find((candidate) => candidate.id === node.id) ?? node;
  const world = worldTransformForNode(nodes, canonical.id);
  if (!world) return false;
  const topLeft = toScreen(transformPoint(world, { x: 0, y: 0 }).x, transformPoint(world, { x: 0, y: 0 }).y);
  const bottomCenter = toScreen(transformPoint(world, { x: canonical.width / 2, y: canonical.height }).x, transformPoint(world, { x: canonical.width / 2, y: canonical.height }).y);
  // The local Y axis identifies the physical top/bottom sides after rotation
  // (and works for Relative-v1 descendants too). Keep HUD sizing in screen
  // pixels; only its anchor and orientation inherit the selection transform.
  const localYAxisLength = Math.hypot(world.c, world.d);
  if (!Number.isFinite(localYAxisLength) || localYAxisLength <= 1e-9) return false;
  const localYAxis = { x: world.c / localYAxisLength, y: world.d / localYAxisLength };
  const angle = Math.atan2(world.b, world.a);
  ctx.save();
  ctx.translate(topLeft.x, topLeft.y);
  ctx.rotate(angle);
  if (isFrameLike(canonical) || canonical.kind === "section") {
    ctx.font = canvasFont(canvasDesignTokens.typography.layerName);
    ctx.fillStyle = canvasDesignTokens.color.selection;
    ctx.textBaseline = "bottom";
    ctx.fillText(canonical.name, 0, -canvasDesignTokens.overlay.frameName.offsetY);
  }
  ctx.restore();
  const bottomAnchor = {
    x: bottomCenter.x + localYAxis.x * (offsetY + labelHeight / 2),
    y: bottomCenter.y + localYAxis.y * (offsetY + labelHeight / 2),
  };
  ctx.save();
  ctx.translate(bottomAnchor.x, bottomAnchor.y);
  ctx.rotate(angle);
  renderSelectionDimensions(ctx, dimensions, -labelWidth / 2, -labelHeight / 2, labelWidth, labelHeight, horizontalInset, cornerRadius);
  ctx.restore();
  return true;
}
function renderSelectionLabel(ctx: OffscreenCanvasRenderingContext2D, multiSelection?: MultiResizeSelection) {
  // Selection remains authoritative for layer-panel and keyboard operations,
  // while its canvas affordance must not reveal a layer that an ancestor Clip
  // Frame or alpha mask fully hides. This is the same conservative predicate
  // used by marquee selection; partially visible nodes deliberately keep their
  // normal bounds so the editor remains predictable while arranging content.
  const selectedNodes = selectedIds.map((id) => nodeById.get(id)).filter((node): node is CanvasNode => Boolean(
    node && node.visible !== false && !isFullyClippedForSelection(nodes, node.id, boundsForNode),
  ));
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
  ctx.font = canvasFont(canvasDesignTokens.typography.selectionLabel);
  const labelWidth = Math.ceil(ctx.measureText(dimensions).width) + horizontalInset * 2;
  if (selectedNode && !multiSelection && renderRotatedSingleSelectionLabels(ctx, selectedNode, dimensions, labelWidth, labelHeight, horizontalInset, cornerRadius, offsetY)) {
    ctx.restore();
    return;
  }
  if (selectedNode && (isFrameLike(selectedNode) || selectedNode.kind === "section")) renderLayerName(ctx, selectedNode, true);
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
    : activeNodes().filter((node) => node.visible !== false && !isFullyClippedForSelection(nodes, node.id, boundsForNode) && boundsIntersect(boundsForNode(node), selection)).map((node) => node.id);
  selectedIds = resolveMarqueeSelection(activeDrag.initialSelection, marqueeIds, activeDrag.additive);
  storeActivePageSelection();
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
function render(
  rendersPerInputFrame?: number,
  reportRemoteProgress?: (
    stage: "render-paint" | "render-overlay" | "render-finalize",
  ) => void,
  fastStructuralPreview = false,
) {
  if (!renderVisible) return;
  const progressiveRequestKey = nodes.length >= COMPLEX_DOCUMENT_NODE_THRESHOLD
    ? [revision, nodes.length, activePageId, transientSceneVersion, viewport.x, viewport.y, viewport.zoom, width, height, dpr, renderQuality.tier].join(":")
    : undefined;
  // Inspector, presence and persistence updates may request the same frame
  // while a dense structural paint is already progressing. Do not restart
  // that work: repeated cancellation otherwise leaves the low-res preview on
  // screen indefinitely even though the camera and scene never changed.
  if (
    !reportRemoteProgress &&
    renderQuality.tier === "settled" &&
    progressiveRequestKey &&
    (progressivePaintKey === progressiveRequestKey || completedProgressivePaintKey === progressiveRequestKey)
  ) return;
  // Once a preview/reprojection replaces the surface, an earlier completed
  // camera key no longer proves what is on screen (including zoom A → B → A).
  completedProgressivePaintKey = undefined;
  const paintGeneration = ++progressivePaintGeneration;
  finishProgressivePaint();
  // Some local commits advance the revision after rebuilding the indexes. Do
  // not let the derived scene advertise that older fence to a Hit Test.
  if (!compiledScene || compiledScene.scene.revision !== revision) rebuildCompiledScene();
  if (!context || !canvas) return;
  const startedAt = performance.now();
  if (reprojectCachedFrameDuringInteraction()) {
    renderPerformance.record({
      totalMs: performance.now() - startedAt,
      cullingMs: 0,
      gpuPrepareMs: 0,
      overlayMs: 0,
      imageBitmapMs: 0,
      compositeMs: 0,
      candidateNodes: 0,
      visibleNodes: 0,
      gpuUploadBytes: 0,
      rendersPerInputFrame,
    });
    maybeSimulateGpuLoss();
    return;
  }
  // Cache eviction is presentation-only. Re-request each visible missing asset
  // so a page converges on the shared per-image proxy budget instead of
  // leaving an evicted layer on its striped placeholder indefinitely.
  new Set(activeNodes()
    .filter((node) => node.visible !== false && node.kind !== "text" && Boolean(node.assetId) && !imageBitmaps.has(node.assetId!))
    .map((node) => node.assetId!))
    .forEach((assetId) => void ensureImageBitmap(assetId));
  const cullingStartedAt = startedAt;
  const viewportBounds = viewportWorldBounds(viewport, width, height);
  const candidateNodes = spatialGrid.query(viewportBounds);
  // The spatial index intentionally contains every canonical node. Intersect
  // it with hierarchy visibility here so a hidden Section's descendants cannot
  // reappear merely because this render path bypasses `activeNodes()`.
  const pageVisibleNodes = visibleNodesOnPage(nodes, activePageId, defaultPageId);
  const hierarchyVisibleIds = new Set(pageVisibleNodes.map((node) => node.id));
  const visibleNodes = candidateNodes.filter((node) => hierarchyVisibleIds.has(node.id) && node.id !== editingTextNodeId && boundsIntersect(nodeBoundsById.get(node.id) ?? rotatedNodeBounds(node), viewportBounds));
  // `nodeById` and the spatial grid intentionally build their own projected
  // copies. Object identity therefore cannot decide whether an overlay node is
  // visible; compare the durable NodeId so Line selection/hover is not skipped
  // after a Relative-v1 projection.
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  // Rust supplies the committed command order for flat Canvas/GPU paths.
  // Structural composition is deliberately different: a mask consumes the
  // following *sibling* run, so reordering by render pass could put an Image
  // or Text target before its alpha source. Preserve Canonical back-to-front
  // layer order whenever Frame clips or alpha masks require the tree walker.
  // Keep validating the Rust plan and surfacing its diagnostics while Canvas
  // now consumes the shared Scene IR as its ordering authority.
  // Recovery can temporarily advance Core ahead of the displayed projection.
  // Such a graph cannot validate this frame; building it only delays zoom.
  if (Number(wasmDocument?.revision) === revision)
    void rustRenderGraphForVisibleNodes(viewportBounds, visibleNodes);
  reportRemoteProgress?.("render-paint");
  // Canvas' input order comes from the same Scene IR used by hit testing. The
  // Rust command stream remains an optional GPU optimization, but it cannot
  // redefine the Canvas stacking order.
  const sceneOrderedNodes = sceneNodesInPaintOrder(compiledScene?.scene, visibleNodes);
  const renderOrderedNodes = sceneOrderedNodes;
  const structuralRenderNodes = sceneOrderedNodes;
  const cullingMs = performance.now() - cullingStartedAt;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  let gpuRenderedNodeIds: ReadonlySet<string> | undefined;
  let gpuUploadBytes = 0;
  let imageBitmapMs = 0;
  let compositeMs = 0;
  const gpuStartedAt = performance.now();
  const pageHasFrameChildren = pageVisibleNodes.some((node) => {
    const parent = node.parentId ? nodeById.get(node.parentId) : undefined;
    return parent && isFrameLike(parent) && parent.clipsContent !== false;
  });
  const pageHasBooleanOperations = pageVisibleNodes
    .some((node) => node.kind === "booleanOperation");
  const pageHasAlphaMasks = pageVisibleNodes
    .some((node) => Boolean(node.isMask));
  const pageHasTransformGroupRepeat = pageVisibleNodes
    .some((node) => node.kind === "transformGroup" && Boolean(transformGroupRepeatMatrices(nodes, node)?.length));
  const useProgressiveStructuralRender =
    (fastStructuralPreview || nodes.length >= COMPLEX_DOCUMENT_NODE_THRESHOLD) &&
    pageHasFrameChildren &&
    !pageHasAlphaMasks &&
    !pageHasTransformGroupRepeat;
  const hasReusablePresentedFrame =
    presentedPageId === activePageId &&
    presentedSurfaceWidth === canvas.width &&
    presentedSurfaceHeight === canvas.height &&
    cachedPresentedFrameSceneKey === `${revision}:${activePageId}:${transientSceneVersion}` &&
    isSameRenderedViewport(cachedPresentedFrameViewport, viewport);
  if (!useProgressiveStructuralRender || !hasReusablePresentedFrame) {
    context.clearRect(0, 0, width, height);
    context.fillStyle = canvasDesignTokens.color.backdrop;
    context.fillRect(0, 0, width, height);
    if (useProgressiveStructuralRender) renderGrid(context);
  }
  if (gpuRenderer && !useProgressiveStructuralRender) {
    try {
      // GPU stores the whole world-space document once; the camera uniform performs
      // viewport changes. Canvas-only overlays continue to use the culled list.
      const pageNodes = activeNodes().filter((node) => node.id !== editingTextNodeId && node.kind !== "slice");
      const pageHasRelativeTransform = pageVisibleNodes
        .some((node) => Boolean(node.relativeTransform));
      const decodedImageAssetIds = new Set(pageNodes
        .filter((node) => node.kind === "image" && Boolean(node.assetId) && Boolean(imageBitmaps.get(node.assetId!)))
        .map((node) => node.assetId!));
      refreshRustGpuTextGlyphs();
      const gpuTextNodeIds = new Set([...rustGpuTextGlyphs]
        .filter(([, cached]) => cached.revision === revision && cached.glyphs.length > 0)
        .map(([nodeId]) => nodeId));
      const gpuNodes = pageHasFrameChildren || pageHasBooleanOperations || pageHasAlphaMasks || pageHasTransformGroupRepeat ? [] : gpuLayerPrefix(pageNodes, decodedImageAssetIds, gpuTextNodeIds, (node) => !nativeAffineForNode(node) || requiresCanvasEffectOrBlend(node));
      const currentRustGpuScene = gpuNodes.length === pageNodes.length && rustGpuScene
        && rustGpuScene.revision === revision
        && rustGpuScene.pageId === activePageId
        && rustGpuScene.transientSceneVersion === transientSceneVersion
        // A precomputed Rust instance buffer is a local acceleration only.
        // It is admissible only when it proves the same Scene IR draw order;
        // otherwise the TypeScript GPU builder receives the shared list.
        && rustGpuScene.renderedNodeIds.size === gpuNodes.length
        && [...rustGpuScene.renderedNodeIds].every((nodeId, index) => gpuNodes[index]?.id === nodeId)
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
      gpuEffectTextureBytes = result.effectTextures.bytes;
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
      const effectTextureSignature = `${result.effectTextures.textures}:${result.effectTextures.bytes}`;
      if (effectTextureSignature !== effectTextureStatsSignature) {
        effectTextureStatsSignature = effectTextureSignature;
        diagnostics.record({ category: "renderer", code: "EFFECT_TEXTURE_STATS", documentRevision: revision, details: {
          textures: result.effectTextures.textures,
          bytes: result.effectTextures.bytes,
          active: result.effectTextures.active,
          cacheHits: result.effectTextures.cacheHits,
          allocations: result.effectTextures.allocations,
          evictions: result.effectTextures.evictions,
          rejected: result.effectTextures.rejected,
        } });
      }
      if (result.effectTextures.evictions) diagnostics.record({ category: "renderer", code: "EFFECT_TEXTURE_EVICTED", documentRevision: revision, details: { textures: result.effectTextures.textures, evictions: result.effectTextures.evictions, bytes: result.effectTextures.bytes } });
      if (result.effectTextures.rejected) diagnostics.record({ category: "renderer", code: "EFFECT_TEXTURE_FALLBACK", documentRevision: revision, details: { textures: result.effectTextures.textures, rejected: result.effectTextures.rejected, bytes: result.effectTextures.bytes } });
      gpuSceneWithinBudget = true;
      gpuSceneLimitReported = false;
    } catch (error) {
      if (error instanceof GpuSceneResourceLimitError) {
        gpuSceneBytes = error.admission.resourceBytes;
        gpuEffectTextureBytes = 0;
        gpuSceneWithinBudget = false;
        if (!gpuSceneLimitReported) diagnostics.record({ category: "renderer", code: "GPU_SCENE_RESOURCE_LIMIT" });
        gpuSceneLimitReported = true;
      } else {
        const code = classifyWebGpuRendererFailure(error);
        gpuSceneBytes = 0;
        gpuEffectTextureBytes = 0;
        gpuSceneWithinBudget = true;
        gpuRenderer.destroy();
        gpuRenderer = undefined;
        gpuStatus = "unavailable";
        diagnostics.record({ category: "renderer", code, documentRevision: revision, details: { errorKind: code } });
      }
    }
  }
  const gpuPrepareMs = performance.now() - gpuStartedAt;
  reportRemoteProgress?.("render-overlay");
  const overlayStartedAt = performance.now();
  const dragPreviewRootIds = escapedFrameDragPreviewRootIds();
  if (useProgressiveStructuralRender) {
    const booleanOperandIds = renderedBooleanOperandIds(structuralRenderNodes);
    const progressiveNodes = structuralRenderNodes.filter((node) => !booleanOperandIds.has(node.id));
    const clippingAncestorsByNodeId = new Map<string, CanvasNode[]>();
    const clippingAncestorsFor = (node: CanvasNode) => {
      const cached = clippingAncestorsByNodeId.get(node.id);
      if (cached) return cached;
      const ancestors: CanvasNode[] = [];
      const visited = new Set<string>([node.id]);
      // Look up all projected parents, including those culled out of this
      // viewport. Culling a Frame must not remove its clip from a child.
      let parent = node.parentId ? nodeById.get(node.parentId) : undefined;
      while (parent && !visited.has(parent.id)) {
        visited.add(parent.id);
        if (isFrameLike(parent) && parent.clipsContent !== false) ancestors.unshift(parent);
        parent = parent.parentId ? nodeById.get(parent.parentId) : undefined;
      }
      clippingAncestorsByNodeId.set(node.id, ancestors);
      return ancestors;
    };
    const paintStructuralNode = (destination: OffscreenCanvasRenderingContext2D, node: CanvasNode, effects = false) => {
      const ancestors = clippingAncestorsFor(node);
      for (const ancestor of ancestors) clipFrameContents(destination, ancestor);
      if (effects) renderNode(destination, node);
      else renderNodePreview(destination, node);
      for (let ancestorIndex = 0; ancestorIndex < ancestors.length; ancestorIndex += 1) destination.restore();
    };
    // Paint into an untransferred staging surface. Yielding after each layer
    // keeps Worker input responsive, while publishing only occasional
    // checkpoints avoids forcing Chromium to composite the full transferred
    // canvas hundreds of times during a large import.
    let stagingCanvas = new OffscreenCanvas(canvas.width, canvas.height);
    let stagingContext = stagingCanvas.getContext("2d");
    if (!stagingContext) return;
    progressivePaintKey = progressiveRequestKey;
    progressivePaintCompletion = new Promise<void>((resolve) => {
      resolveProgressivePaintCompletion = resolve;
    });
    stagingContext.setTransform(dpr, 0, 0, dpr, 0, 0);
    stagingContext.fillStyle = canvasDesignTokens.color.backdrop;
    stagingContext.fillRect(0, 0, width, height);
    renderGrid(stagingContext);
    const renderedViewport = { ...viewport };
    const renderedSurfaceWidth = width;
    const renderedSurfaceHeight = height;
    const needsEffectPass = renderedViewport.zoom >= 1.5 && progressiveNodes.some((node) => orderedEffects(node).length > 0);
    let paintingEffects = false;
    const publishStagingSurface = () => {
      if (paintGeneration !== progressivePaintGeneration || !context || !stagingContext) return;
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas!.width, canvas!.height);
      context.drawImage(stagingCanvas, 0, 0);
      context.restore();
      presentedPageId = activePageId;
      presentedSurfaceWidth = canvas!.width;
      presentedSurfaceHeight = canvas!.height;
      // The completed staging surface is safe to reuse between Worker turns:
      // painting and input never execute concurrently. It becomes the raster
      // used for subsequent camera-only interaction.
      cachePresentedFrame(stagingCanvas, renderedViewport, renderedSurfaceWidth, renderedSurfaceHeight);
    };
    if (!hasReusablePresentedFrame) {
      // Dense remote documents become usable after this complete overview is
      // published. The exact 1.5x frame continues in the staging surface, but
      // must not hold the entire editor behind a blocking loading screen.
      const previewDpr = Math.min(dpr, 0.5);
      const previewCanvas = new OffscreenCanvas(
        Math.max(1, Math.ceil(width * previewDpr)),
        Math.max(1, Math.ceil(height * previewDpr)),
      );
      const previewContext = previewCanvas.getContext("2d");
      if (previewContext) {
        previewContext.setTransform(previewDpr, 0, 0, previewDpr, 0, 0);
        previewContext.fillStyle = canvasDesignTokens.color.backdrop;
        previewContext.fillRect(0, 0, width, height);
        renderGrid(previewContext);
        progressiveNodes.forEach((node) => paintStructuralNode(previewContext, node));
        context.save();
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(previewCanvas, 0, 0, canvas.width, canvas.height);
        context.restore();
        presentedPageId = activePageId;
        presentedSurfaceWidth = canvas.width;
        presentedSurfaceHeight = canvas.height;
        cachePresentedFrame(previewCanvas, renderedViewport, renderedSurfaceWidth, renderedSurfaceHeight);
        emit({
          type: "frame-ready",
          revision,
          pageId: activePageId,
          quality: "preview",
        });
      }
    }
    let index = 0;
    const progressStep = Math.max(
      100,
      Math.ceil(progressiveNodes.length / 10),
    );
    let nextProgressIndex = progressStep;
    const paintChunk = () => {
      if (paintGeneration !== progressivePaintGeneration || !context || !stagingContext) return;
      const chunkStartedAt = performance.now();
      const end = Math.min(index + PROGRESSIVE_PAINT_MAX_NODES, progressiveNodes.length);
      for (; index < end; index += 1) {
        const node = progressiveNodes[index]!;
        // A zoomed-out dense page can carry hundreds of blur/shadow records.
        // Clearing multiple full-size effect surfaces per node can take tens of
        // seconds, so overview mode preserves canonical vector/text paint and
        // clipping at full presentation DPR. Detail zoom and normal-sized
        // documents retain the complete ordered effect pipeline.
        paintStructuralNode(stagingContext, node, paintingEffects);
        if (performance.now() - chunkStartedAt >= PROGRESSIVE_PAINT_BUDGET_MS) {
          index += 1;
          break;
        }
      }
      // Keep the complete low-resolution preview visible until every exact
      // layer is ready. Publishing an early canonical prefix can replace a
      // complete preview with an apparently blank or half-built page because
      // background/container layers commonly precede visible descendants.
      if (index === progressiveNodes.length) {
        publishStagingSurface();
        if (needsEffectPass && !paintingEffects) {
          // Publish sharp geometry/text before expensive full-surface effects.
          // Keep this completed raster immutable while the effect pass paints
          // into a separate surface, so subsequent zooms cannot sample a blank
          // or partially overwritten cache.
          emit({ type: "frame-ready", revision, pageId: activePageId, quality: "sharp" });
          stagingCanvas = new OffscreenCanvas(canvas!.width, canvas!.height);
          stagingContext = stagingCanvas.getContext("2d");
          if (!stagingContext) throw new Error("Progressive effect surface unavailable");
          stagingContext.setTransform(dpr, 0, 0, dpr, 0, 0);
          stagingContext.fillStyle = canvasDesignTokens.color.backdrop;
          stagingContext.fillRect(0, 0, width, height);
          renderGrid(stagingContext);
          paintingEffects = true;
          index = 0;
          scheduleProgressivePaint(runPaintChunk);
          return;
        }
      }
      if (
        reportRemoteProgress &&
        (index >= nextProgressIndex || index === progressiveNodes.length)
      ) {
        emit({
          type: "remote-load-progress",
          stage: "render-nodes",
          completed: index,
          total: progressiveNodes.length,
        });
        nextProgressIndex =
          Math.floor(index / progressStep + 1) * progressStep;
      }
      if (index < progressiveNodes.length) {
        scheduleProgressivePaint(runPaintChunk);
        return;
      }
      cachePresentedFrame(stagingCanvas, renderedViewport, renderedSurfaceWidth, renderedSurfaceHeight);
      completedProgressivePaintKey = progressiveRequestKey;
      finishProgressivePaint();
      reportRemoteProgress?.("render-finalize");
      renderPerformance.record({
        totalMs: performance.now() - startedAt,
        cullingMs,
        gpuPrepareMs,
        overlayMs: performance.now() - overlayStartedAt,
        imageBitmapMs,
        compositeMs,
        candidateNodes: candidateNodes.length,
        visibleNodes: visibleNodes.length,
        gpuUploadBytes,
        rendersPerInputFrame,
      });
      emit({
        type: "frame-ready",
        revision,
        pageId: activePageId,
        quality: "settled",
      });
      maybeSimulateGpuLoss();
    };
    const runPaintChunk = () => {
      try { paintChunk(); }
      catch (error) {
        if (paintGeneration === progressivePaintGeneration) finishProgressivePaint();
        // Preserve the existing Worker crash/recovery path on paint failure.
        throw error;
      }
    };
    scheduleProgressivePaint(runPaintChunk);
    return;
  } else if (pageHasFrameChildren || pageHasAlphaMasks || pageHasTransformGroupRepeat)
    renderFrameClippedTree(
      context!,
      structuralRenderNodes,
      dragPreviewRootIds,
      reportRemoteProgress
        ? (completed, total) =>
            emit({
              type: "remote-load-progress",
              stage: "render-nodes",
              completed,
              total,
            })
        : undefined,
    );
  else {
    const booleanOperandIds = renderedBooleanOperandIds(renderOrderedNodes);
    renderOrderedNodes.forEach((node) => { if (!gpuRenderedNodeIds?.has(node.id) && !booleanOperandIds.has(node.id)) renderNode(context!, node); });
  }
  reportRemoteProgress?.("render-finalize");
  visibleNodes.forEach((node) => renderFrameName(context!, node));
  const hovered = hoveredId ? nodeById.get(hoveredId) : undefined;
  if (hovered && visibleNodeIds.has(hovered.id)) renderHover(context!, hovered);
  const frameDropTarget = drag?.mode === "move" && drag.dropTargetId ? nodeById.get(drag.dropTargetId) : undefined;
  if (frameDropTarget && isFrameLike(frameDropTarget)) {
    renderFrameDropTarget(context!, frameDropTarget, frameDropTarget.autoLayout?.mode === "horizontal" || frameDropTarget.autoLayout?.mode === "vertical");
  }
  if (drag?.mode === "move" && !drag.dropTargetId) {
    renderAutoLayoutInsertion(context!, drag.before, [...drag.initial], { x: drag.currentX, y: drag.currentY });
  }
  // The editing DOM layer intentionally replaces only glyph painting. Keep the
  // Canvas selection geometry visible beneath it, so the edit outline remains
  // identical to the hover/selected document bounds rather than using a browser
  // textarea focus ring with its own outside offset.
  const visibleSelected = selectedIds.map((id) => nodeById.get(id)).filter((node): node is CanvasNode => Boolean(
    node
    && node.visible !== false
    && (!isFullyClippedForSelection(nodes, node.id, boundsForNode) || dragPreviewRootIds.has(node.id))
    && boundsIntersect(nodeBoundsById.get(node.id) ?? rotatedNodeBounds(node), viewportBounds)
    && (visibleNodeIds.has(node.id) || node.id === editingTextNodeId),
  ));
  // Multi-selection geometry is an overlay, so construct it from the same
  // visible subset instead of expanding the outline around fully clipped
  // layers that remain selected in the Layers panel.
  const multiSelection = resolveMultiResizeSelection(nodes, visibleSelected.map((node) => node.id));
  const renderedMultiSelection = renderMultiResizeSelection(context!, multiSelection);
  if (!renderedMultiSelection) visibleSelected.forEach((node) => renderSelection(context!, node));
  if (!renderedMultiSelection) visibleSelected.forEach((node) => renderVectorAnchorOverlay(context!, node));
  if (visibleSelected.length) renderSelectionLabel(context, multiSelection);
  renderPenDraftPreview(context!);
  renderMarquee(context);
  renderGrid(context);
  presentedPageId = activePageId;
  presentedSurfaceWidth = canvas.width;
  presentedSurfaceHeight = canvas.height;
  renderPerformance.record({ totalMs: performance.now() - startedAt, cullingMs, gpuPrepareMs, overlayMs: performance.now() - overlayStartedAt, imageBitmapMs, compositeMs, candidateNodes: candidateNodes.length, visibleNodes: visibleNodes.length, gpuUploadBytes, rendersPerInputFrame });
  emit({
    type: "frame-ready",
    revision,
    pageId: activePageId,
    quality: "settled",
  });
  maybeSimulateGpuLoss();
}
async function pasteClipboard() {
  if (!clipboard || pasteInFlight) return;
  pasteInFlight = true;
  const createdAttachments: DocumentAsset[] = [];
  try {
  const requestedTarget = pasteTarget();
  // A selected container cannot be the direct destination of its own
  // clipboard root: that turns an ordinary copy/paste into a recursive layout
  // insertion. Match normal editor semantics by duplicating the container
  // beside its source instead.
  const pastedSource = requestedTarget.parentId && clipboard.rootIds.includes(requestedTarget.parentId)
    ? nodes.find((node) => node.id === requestedTarget.parentId)
    : undefined;
  const target = pastedSource
    ? { pageId: pastedSource.pageId ?? activePageId, parentId: pastedSource.parentId }
    : requestedTarget;
  const existingAssets = new Map(assets.map((asset) => [asset.assetId, asset]));
  const resourcesToAttach = (clipboard.resourceAssets ?? []).filter((asset) => !existingAssets.has(asset.assetId));
  if (resourcesToAttach.length) {
    if (!clipboardSourceDocumentId || clipboardSourceDocumentId === documentId) {
      emitError(undefined, "INVALID_COMMAND");
      return;
    }
    const headers = { "content-type": "application/json", "x-makefigma-dev-tenant-id": "00000000-0000-0000-0000-000000000002", "x-makefigma-dev-actor-id": localDevActorId };
    for (const asset of resourcesToAttach) {
      const response = await fetch(`${assetApiUrl}/v1/documents/${encodeURIComponent(documentId)}/assets/${encodeURIComponent(asset.assetId)}/attach-from-document`, {
        method: "POST", headers, body: JSON.stringify({ sourceDocumentId: clipboardSourceDocumentId }),
      });
      if (!response.ok) {
        throw new Error("ASSET_DOCUMENT_TRANSFER_AUTHORIZATION_FAILED");
      }
      if (response.status === 201) createdAttachments.push(asset);
      existingAssets.set(asset.assetId, asset);
    }
  }
  const availableAssetIds = new Set(existingAssets.keys());
  const availableAssetContentHashes = new Map([...existingAssets].map(([assetId, asset]) => [assetId, asset.contentHash]));
  const resolved = resolvePasteBatch(nodes, clipboard, target, availableAssetIds, undefined, documentSchemaVersion, availableAssetContentHashes);
  if (!resolved) throw new Error("INVALID_COMMAND");
  const batch: CoreBatchCommand[] = [
    ...resourcesToAttach.map((asset) => ({ type: "registerAsset" as const, asset })),
    ...resolved.batch,
  ];
  if (!wasmDocument) {
    commit(() => { nodes = resolved.nextNodes; assets = [...existingAssets.values()]; selectedIds = resolved.createdIds; });
    return;
  }
  const pasteBaseRevision = Number(wasmDocument.revision);
  const pasteTransactionId = createId();
  wasmDocument.apply_transaction_json(pasteTransactionId, wasmDocument.revision, JSON.stringify(batch));
    recordHistory("core");
    syncProjectionFromWasm(false);
    selectedIds = resolved.createdIds;
    rebuildNodeIndex();
    render();
    emitSnapshot(journalEntry({ type: "restore-core", coreSnapshot: wasmDocument.snapshot_json() }, pasteBaseRevision, pasteTransactionId));
    queueRemoteOperation(pasteTransactionId, pasteBaseRevision, batch, wasmDocument.canonical_hash());
    // The Core transaction is now authoritative, so drop rollback markers.
    // A failed best-effort cleanup is safe: it cannot corrupt the committed
    // document, and an eventual retry may finish the housekeeping.
    for (const asset of createdAttachments) {
      void fetch(`${assetApiUrl}/v1/documents/${encodeURIComponent(documentId)}/assets/${encodeURIComponent(asset.assetId)}/clipboard-attachment/commit`, {
        method: "POST",
        headers: { "x-makefigma-dev-tenant-id": "00000000-0000-0000-0000-000000000002", "x-makefigma-dev-actor-id": localDevActorId },
      }).catch(() => undefined);
    }
  } catch (error) {
    await Promise.allSettled(createdAttachments.map(async (asset) => {
      const headers = { "x-makefigma-dev-tenant-id": "00000000-0000-0000-0000-000000000002", "x-makefigma-dev-actor-id": localDevActorId };
      await fetch(`${assetApiUrl}/v1/documents/${encodeURIComponent(documentId)}/assets/${encodeURIComponent(asset.assetId)}/clipboard-attachment`, { method: "DELETE", headers });
    }));
    emitError(error, error instanceof Error && error.message === "ASSET_DOCUMENT_TRANSFER_AUTHORIZATION_FAILED" ? "AUTHZ_DENIED" : error instanceof Error && error.message === "INVALID_COMMAND" ? "INVALID_COMMAND" : undefined);
  } finally {
    pasteInFlight = false;
  }
}

function dispatch(command: EditorCommand) {
  command = withResolvedTextAutoSize(command);
  if (command.type === "update") command = { ...command, patch: withManualAutoLayoutSizing(nodes, command.id, command.patch) };
  command = withResolvedLayerPosition(command);
  if (command.type === "arrange") {
    const arranged = resolveArrangeCommand(nodes, command);
    if (!arranged.ok) { emitError(undefined, "INVALID_COMMAND"); return; }
    if (!arranged.updates.length) return;
    if (wasmDocument) {
      dispatchTransaction({ id: createId(), baseRevision: Number(wasmDocument.revision), commands: [command] });
      return;
    }
    const before = cloneDocument();
    nodes = nodes.map((node) => {
      const patch = arranged.updates.find((candidate) => candidate.id === node.id)?.patch;
      return patch ? { ...node, ...patch } : node;
    });
    history.push({ nodes: before, advancesRevision: true });
    recordHistory("local");
    revision += 1;
    rebuildNodeIndex();
    render();
    emitSnapshot();
    return;
  }
  if (command.type === "flattenBoolean") {
    if (!wasmDocument) { emitError(undefined, "TRANSIENT"); return; }
    const boolean = nodes.find((node) => node.id === command.id);
    const path = boolean && canonicalBooleanPath(boolean);
    if (!path) { emitError(undefined, "INVALID_COMMAND"); return; }
    const flattened = resolveFlattenBooleanBatch(nodes, command.id, path, createId);
    if (!flattened) { emitError(undefined, "INVALID_COMMAND"); return; }
    const { batch, replacement } = flattened;
    const replacementId = replacement.id;
    const baseRevision = Number(wasmDocument.revision);
    const transactionId = createId();
    try {
      wasmDocument.apply_transaction_json(transactionId, wasmDocument.revision, JSON.stringify(batch));
      recordHistory("core");
      syncProjectionFromWasm(false);
      selectedIds = [replacementId];
      rebuildNodeIndex(); render();
      emitSnapshot(journalEntry({ type: "restore-core", coreSnapshot: wasmDocument.snapshot_json() }, baseRevision, transactionId));
      queueRemoteOperation(transactionId, baseRevision, batch, wasmDocument.canonical_hash());
    } catch (error) { emitError(error); }
    return;
  }
  if (command.type === "outlineStroke") {
    if (!wasmDocument) { emitError(undefined, "TRANSIENT"); return; }
    const subject = nodes.find((node) => node.id === command.id);
    const path = subject?.kind === "vector" ? canonicalVectorStrokeOutline(subject) : subject?.kind === "line" ? canonicalLineStrokeOutline(subject) : undefined;
    if (!path) { emitError(undefined, "UNSUPPORTED_FEATURE"); return; }
    const outlined = subject?.kind === "vector"
      ? resolveOutlineStrokeBatch(nodes, command.id, path, createId)
      : subject?.kind === "line"
        ? resolveLineOutlineStrokeBatch(nodes, command.id, path, createId)
        : undefined;
    if (!outlined) { emitError(undefined, "RESOURCE_LIMIT"); return; }
    const baseRevision = Number(wasmDocument.revision);
    const transactionId = createId();
    try {
      wasmDocument.apply_transaction_json(transactionId, wasmDocument.revision, JSON.stringify(outlined.batch));
      recordHistory("core");
      syncProjectionFromWasm(false);
      selectedIds = [outlined.outlined.id];
      rebuildNodeIndex(); render();
      emitSnapshot(journalEntry({ type: "restore-core", coreSnapshot: wasmDocument.snapshot_json() }, baseRevision, transactionId));
      queueRemoteOperation(transactionId, baseRevision, outlined.batch, wasmDocument.canonical_hash());
    } catch (error) { emitError(error); }
    return;
  }
  if (command.type === "convertParametricToVector") {
    if (!wasmDocument) { emitError(undefined, "TRANSIENT"); return; }
    const shape = nodes.find((node) => node.id === command.id);
    const points = shape && canonicalParametricOutline(shape, shape.width, shape.height);
    if (!points?.length) { emitError(undefined, "INVALID_COMMAND"); return; }
    const converted = resolveParametricShapeToVectorBatch(nodes, command.id, points, createId);
    if (!converted) { emitError(undefined, "INVALID_COMMAND"); return; }
    const baseRevision = Number(wasmDocument.revision);
    const transactionId = createId();
    try {
      wasmDocument.apply_transaction_json(transactionId, wasmDocument.revision, JSON.stringify(converted.batch));
      recordHistory("core");
      syncProjectionFromWasm(false);
      selectedIds = [converted.replacement.id];
      rebuildNodeIndex(); render();
      emitSnapshot(journalEntry({ type: "restore-core", coreSnapshot: wasmDocument.snapshot_json() }, baseRevision, transactionId));
      queueRemoteOperation(transactionId, baseRevision, converted.batch, wasmDocument.canonical_hash());
    } catch (error) { emitError(error); }
    return;
  }
  if (command.type === "group" || command.type === "boolean" || command.type === "ungroup" || command.type === "reparent" || (command.type === "delete" && wasmDocument)) {
    if (!wasmDocument) { emitError(undefined, "TRANSIENT"); return; }
    const resolved = resolveCoreBatch(nodes, [command]);
    if (!resolved) { emitError(undefined, "INVALID_COMMAND"); return; }
    const structuralBaseRevision = Number(wasmDocument.revision);
    const structuralTransactionId = createId();
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
      if (command.id === activePageId) { emitViewState(); break; }
      storeActivePageSelection();
      rememberActivePageViewport();
      activePageId = command.id;
      restoreOrFitPageViewport(activePageId);
      restorePageSelection(activePageId);
      editingTextNodeId = undefined;
      hoveredId = undefined;
      // Publish navigation before the potentially expensive first paint of a
      // complex page so the page row and Layers panel acknowledge the click.
      emitViewState(true);
      emitViewportCheckpoint();
      // The precomputed Rust GPU batch is only an acceleration. Rebuilding it
      // from the full document snapshot on every page switch can dominate the
      // first paint, while the renderer already has a bounded TS fallback.
      rustGpuScene = undefined;
      activateInteractiveRenderQuality();
      rebuildNodeIndex();
      render();
      emitSnapshot(undefined, false);
      break;
    }
    case "create-page": {
      if (!wasmDocument) { emitError(undefined, "INVALID_COMMAND"); break; }
      try {
        const pageBaseRevision = Number(wasmDocument.revision);
        const pageTransactionId = createId();
        if (command.positionId) wasmDocument.create_page_at_position(pageTransactionId, wasmDocument.revision, command.id, command.name.trim(), command.positionId);
        else wasmDocument.create_page(pageTransactionId, wasmDocument.revision, command.id, command.name.trim());
        recordHistory("core");
        syncProjectionFromWasm(false);
        storeActivePageSelection();
        rememberActivePageViewport();
        activePageId = command.id;
        restoreOrFitPageViewport(activePageId);
        rustGpuScene = undefined;
        restorePageSelection(activePageId);
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
    case "select": selectedIds = command.ids; storeActivePageSelection(); render(); emitViewState(); break;
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
      const duplicateTransactionId = createId();
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
      const cutTransactionId = createId();
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
      void pasteClipboard();
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
        retainExistingSelection();
        if (before.advancesRevision) revision += 1;
        render(); emitSnapshot(); break;
      }
      if (!wasmDocument?.can_undo) { undoOrder.push(kind); break; }
      const undoBaseRevision = Number(wasmDocument.revision);
      const undoBeforeHash = wasmDocument.canonical_hash();
      const before = cloneDocument();
      wasmDocument.undo(); redoOrder.push(kind); syncProjectionFromWasm(); retainExistingSelection(); render();
      let batch = historyReplayBatch(before, nodes);
      if (!batch.length && undoBeforeHash !== wasmDocument.canonical_hash()) {
        diagnostics.record({ category: "recovery", code: "HISTORY_REPLAY_DIFF_FALLBACK", documentRevision: revision, details: { direction: "undo", nodeCount: nodes.length } });
        batch = fullStateReplayBatch(nodes);
      }
      if (!batch.length) { emitSnapshot(); break; }
      const undoTransactionId = createId();
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
        retainExistingSelection();
        if (after.advancesRevision) revision += 1;
        render(); emitSnapshot(); break;
      }
      if (!wasmDocument?.can_redo) { redoOrder.push(kind); break; }
      const redoBaseRevision = Number(wasmDocument.revision);
      const redoBeforeHash = wasmDocument.canonical_hash();
      const before = cloneDocument();
      wasmDocument.redo(); undoOrder.push(kind); syncProjectionFromWasm(); retainExistingSelection(); render();
      let batch = historyReplayBatch(before, nodes);
      if (!batch.length && redoBeforeHash !== wasmDocument.canonical_hash()) {
        diagnostics.record({ category: "recovery", code: "HISTORY_REPLAY_DIFF_FALLBACK", documentRevision: revision, details: { direction: "redo", nodeCount: nodes.length } });
        batch = fullStateReplayBatch(nodes);
      }
      if (!batch.length) { emitSnapshot(); break; }
      const redoTransactionId = createId();
      emitSnapshot(journalEntry({ type: "restore-core", coreSnapshot: wasmDocument.snapshot_json() }, redoBaseRevision, redoTransactionId));
      queueRemoteOperation(redoTransactionId, redoBaseRevision, batch, wasmDocument.canonical_hash());
      break;
    }
    case "reset": resetDocumentToBlankPage(); break;
    case "hydrate": {
      if (command.snapshot.format === "rust-core-v1") {
        ephemeralBenchmarkProjection = false;
        viewport = { ...command.snapshot.viewport };
        void loadDocumentBridge(command.snapshot, false, [], command.requestId);
      } else {
        ephemeralBenchmarkProjection = command.snapshot.format === "benchmark-projection-v1";
        const seedAssets = command.snapshot.format === "legacy-projection-v0"
          ? command.snapshot.assets ?? []
          : [];
        nodes = normalizeIds(command.snapshot.nodes);
        rebuildNodeIndex();
        viewport = command.snapshot.viewport;
        render();
        emitSnapshot();
        void loadDocumentBridge(undefined, ephemeralBenchmarkProjection, seedAssets, command.requestId);
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
  const coreDocument = wasmDocument;
  const commitStructuralReplacement = (batch: readonly CoreBatchCommand[], nextSelection: readonly string[]) => {
    try {
      const baseRevision = Number(coreDocument.revision);
      coreDocument.apply_transaction_json(transaction.id, BigInt(transaction.baseRevision), JSON.stringify(batch));
      recordHistory("core");
      syncProjectionFromWasm(false);
      selectedIds = [...nextSelection];
      rebuildNodeIndex(); render();
      diagnostics.record({ category: "transaction", code: "TRANSACTION_ACCEPTED", documentRevision: revision, transactionId: transaction.id, details: { commandCount: 1 } });
      emitSnapshot(journalEntry({ type: "restore-core", coreSnapshot: coreDocument.snapshot_json() }, baseRevision, transaction.id));
      queueRemoteOperation(transaction.id, baseRevision, batch, coreDocument.canonical_hash());
      emit({ type: "ack", transactionId: transaction.id, acceptedRevision: revision });
    } catch (error) {
      const errorCode = error instanceof Error && error.message.includes("ResourceLimit") ? "RESOURCE_LIMIT" : "INVALID_TRANSACTION";
      diagnostics.record({ category: "transaction", code: "TRANSACTION_REJECTED", documentRevision: revision, transactionId: transaction.id, details: { errorCode } });
      emitError(error, errorCode === "RESOURCE_LIMIT" ? "RESOURCE_LIMIT" : "INVALID_COMMAND", transaction.id);
      emit({ type: "ack", transactionId: transaction.id, errorCode });
    }
  };
  if (transaction.commands.length === 1 && transaction.commands[0].type === "flattenBoolean") {
    const command = transaction.commands[0];
    const boolean = nodes.find((node) => node.id === command.id);
    const path = boolean && canonicalBooleanPath(boolean);
    const flattened = path && resolveFlattenBooleanBatch(nodes, command.id, path, createId);
    if (!flattened) {
      emitError(undefined, "INVALID_COMMAND", transaction.id);
      emit({ type: "ack", transactionId: transaction.id, errorCode: "INVALID_TRANSACTION" });
      return;
    }
    commitStructuralReplacement(flattened.batch, [flattened.replacement.id]);
    return;
  }
  if (transaction.commands.length === 1 && transaction.commands[0].type === "outlineStroke") {
    const command = transaction.commands[0];
    const subject = nodes.find((node) => node.id === command.id);
    const path = subject?.kind === "vector" ? canonicalVectorStrokeOutline(subject) : subject?.kind === "line" ? canonicalLineStrokeOutline(subject) : undefined;
    const outlined = path && (subject?.kind === "vector"
      ? resolveOutlineStrokeBatch(nodes, command.id, path, createId)
      : subject?.kind === "line"
        ? resolveLineOutlineStrokeBatch(nodes, command.id, path, createId)
        : undefined);
    if (!outlined) {
      emitError(undefined, "INVALID_COMMAND", transaction.id);
      emit({ type: "ack", transactionId: transaction.id, errorCode: "INVALID_TRANSACTION" });
      return;
    }
    commitStructuralReplacement(outlined.batch, [outlined.outlined.id]);
    return;
  }
  if (transaction.commands.length === 1 && transaction.commands[0].type === "convertParametricToVector") {
    const command = transaction.commands[0];
    const shape = nodes.find((node) => node.id === command.id);
    const points = shape && canonicalParametricOutline(shape, shape.width, shape.height);
    const converted = points?.length
      ? resolveParametricShapeToVectorBatch(nodes, command.id, points, createId)
      : undefined;
    if (!converted) {
      emitError(undefined, "INVALID_COMMAND", transaction.id);
      emit({ type: "ack", transactionId: transaction.id, errorCode: "INVALID_TRANSACTION" });
      return;
    }
    try {
      const baseRevision = Number(wasmDocument.revision);
      wasmDocument.apply_transaction_json(transaction.id, BigInt(transaction.baseRevision), JSON.stringify(converted.batch));
      recordHistory("core");
      syncProjectionFromWasm(false);
      selectedIds = [converted.replacement.id];
      rebuildNodeIndex(); render();
      diagnostics.record({ category: "transaction", code: "TRANSACTION_ACCEPTED", documentRevision: revision, transactionId: transaction.id, details: { commandCount: 1 } });
      emitSnapshot(journalEntry({ type: "restore-core", coreSnapshot: wasmDocument.snapshot_json() }, baseRevision, transaction.id));
      queueRemoteOperation(transaction.id, baseRevision, converted.batch, wasmDocument.canonical_hash());
      emit({ type: "ack", transactionId: transaction.id, acceptedRevision: revision });
    } catch (error) {
      const errorCode = error instanceof Error && error.message.includes("ResourceLimit") ? "RESOURCE_LIMIT" : "INVALID_TRANSACTION";
      diagnostics.record({ category: "transaction", code: "TRANSACTION_REJECTED", documentRevision: revision, transactionId: transaction.id, details: { errorCode } });
      emitError(error, errorCode === "RESOURCE_LIMIT" ? "RESOURCE_LIMIT" : "INVALID_COMMAND", transaction.id);
      emit({ type: "ack", transactionId: transaction.id, errorCode });
    }
    return;
  }
  const concreteCommands: EditorCommand[] = [];
  for (const command of transaction.commands) {
    if (command.type !== "arrange") { concreteCommands.push(command); continue; }
    const arranged = resolveArrangeCommand(nodes, command);
    if (!arranged.ok) {
      emitError(undefined, "INVALID_COMMAND", transaction.id);
      emit({ type: "ack", transactionId: transaction.id, errorCode: "INVALID_TRANSACTION" });
      return;
    }
    concreteCommands.push(...arranged.updates.map(({ id, patch }) => ({ type: "update" as const, id, patch })));
  }
  if (!concreteCommands.length) {
    emit({ type: "ack", transactionId: transaction.id, acceptedRevision: revision });
    return;
  }
  // Older persisted snapshots may still carry Relative-v1 matrices on an
  // Auto Layout frame or one of its flow children.  Such a snapshot renders,
  // but Core rightly rejects the first layout reflow.  Commit the lossless
  // world-space normalization alongside an arrange edit, rather than allowing
  // a visible UI action to fail after the user has invoked it.
  const normalizationPatches = transaction.commands.some((command) => command.type === "arrange")
    ? autoLayoutProjectionNormalizationPatches(nodes)
    : [];
  const mergedUpdates = new Map<string, Partial<CanvasNode>>();
  for (const normalization of normalizationPatches) mergedUpdates.set(normalization.id, normalization.patch);
  const nonUpdates: EditorCommand[] = [];
  for (const command of concreteCommands) {
    if (command.type !== "update") { nonUpdates.push(command); continue; }
    mergedUpdates.set(command.id, { ...(mergedUpdates.get(command.id) ?? {}), ...command.patch });
  }
  const pageScopedCommands = [
    ...normalizationPatches.map(({ id }) => ({ type: "update" as const, id, patch: mergedUpdates.get(id)! })),
    ...concreteCommands
      .filter((command): command is Extract<EditorCommand, { type: "update" }> => command.type === "update" && !normalizationPatches.some((normalization) => normalization.id === command.id))
      .map((command) => ({ type: "update" as const, id: command.id, patch: mergedUpdates.get(command.id)! })),
    ...nonUpdates,
  ].map((command) => {
    if (command.type === "create") return { ...command, node: { ...command.node, pageId: command.node.pageId ?? activePageId } };
    if (command.type === "update") return { ...command, patch: withManualAutoLayoutSizing(nodes, command.id, command.patch) };
    return command;
  });
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

/** Commits a keyboard movement through the same world-to-local conversion and
 * Core transaction boundary as a pointer drag. In particular, directly
 * changing x/y would leave a Relative-v1 child visually frozen. */
function nudgeSelection(delta: { x: number; y: number }) {
  const resolved = resolveSelectionNudge(nodes, selectedIds, delta);
  if (!resolved) return;
  const initial = resolved.movable;
  const patches = resolved.patches.map(({ id, patch }) => ({ type: "update" as const, id, patch }));
  if (!patches.length) return;
  if (wasmDocument) {
    dispatchTransaction({ id: createId(), baseRevision: Number(wasmDocument.revision), commands: patches });
    return;
  }
  const before = cloneDocument();
  nodes = nodes.map((node) => {
    const patch = patches.find((candidate) => candidate.id === node.id)?.patch;
    return patch ? { ...node, ...patch } : node;
  });
  refreshTransientGroupBounds(new Set(nodes.filter((node) => node.kind === "group" && initial.has(node.id)).map((node) => node.id)));
  history.push({ nodes: before, advancesRevision: true });
  recordHistory("local");
  revision += 1;
  rebuildNodeIndex();
  render();
  emitSnapshot();
}

/** Resolves an Arrow-key world delta through the selected Vector's affine
 * transform, then submits the same point command used by an anchor drag. */
function nudgeSelectedVectorPoints(delta: { x: number; y: number }): boolean {
  const targets = selectedVectorPoints;
  const nodeId = targets[0]?.id;
  if (!nodeId || targets.some((target) => target.id !== nodeId)) return false;
  const node = selectedIds.length === 1 && selectedIds[0] === nodeId
    ? nodes.find((candidate) => candidate.id === nodeId)
    : undefined;
  const points = node?.kind === "vector"
    ? targets.map((target) => node.vectorPath?.subpaths.flatMap((subpath) => subpath.points).find((candidate) => candidate.id === target.pointId)).filter((point): point is VectorPoint => Boolean(point))
    : [];
  const transform = node && worldTransformForNode(nodes, node.id);
  const inverse = transform && invertAffine(transform);
  if (!node || points.length !== targets.length || !inverse || !wasmDocument) {
    selectedVectorPoints = [];
    render();
    return false;
  }
  const localOrigin = transformPoint(inverse, { x: 0, y: 0 });
  const localDelta = transformPoint(inverse, delta);
  dispatchTransaction({
    id: createId(),
    baseRevision: Number(wasmDocument.revision),
    commands: points.map((point) => ({ type: "moveVectorPoint" as const, id: node.id, pointId: point.id, x: point.x + localDelta.x - localOrigin.x, y: point.y + localDelta.y - localOrigin.y })),
  });
  return true;
}

function deleteSelectedVectorPoints(): boolean {
  const targets = selectedVectorPoints;
  const nodeId = targets[0]?.id;
  if (!nodeId || targets.some((target) => target.id !== nodeId)) return false;
  const node = selectedIds.length === 1 && selectedIds[0] === nodeId
    ? nodes.find((candidate) => candidate.id === nodeId)
    : undefined;
  if (!node || node.kind !== "vector" || !node.vectorPath || !wasmDocument) return false;
  const pointIds = new Set(targets.map((target) => target.pointId));
  if (pointIds.size !== targets.length || node.vectorPath.subpaths.some((subpath) => {
    const selectedCount = subpath.points.filter((point) => pointIds.has(point.id)).length;
    return selectedCount > 0 && subpath.points.length - selectedCount < (subpath.closed ? 3 : 1);
  })) return false;
  selectedVectorPoints = [];
  dispatchTransaction({
    id: createId(),
    baseRevision: Number(wasmDocument.revision),
    commands: targets.map((target) => ({ type: "deleteVectorPoint" as const, id: node.id, pointId: target.pointId })),
  });
  return true;
}
function pointer(event: Extract<MainToWorker, { type: "pointer" }>) {
  const world = toWorld(event.x, event.y);
  if (event.event === "leave") {
    if (penDraft?.previewWorld) {
      penDraft.previewWorld = undefined;
      render();
    }
    if (!drag && hoveredId !== undefined) {
      hoveredId = undefined;
      render();
    }
    return;
  }
  if (event.event === "down") {
    if (tool === "hand" || event.button === 1) { drag = { mode: "pan", startX: event.x, startY: event.y }; return; }
    if (tool === "pen") {
      if (event.readOnly) { render(); emitViewState(); return; }
      const connectTarget = penDraftConnectsAtScreen(event.x, event.y);
      if (connectTarget) {
        penDraft!.connectTarget = connectTarget;
        finishPenDraft();
        return;
      }
      if (penDraftClosesAtScreen(event.x, event.y)) {
        if (penDraft!.kind === "create") {
          const closed = structuredClone(penDraft!.node);
          closed.vectorPath!.subpaths[0].closed = true;
          replacePenDraftNode(closed);
        } else penDraft!.closeOnFinish = true;
        finishPenDraft();
        return;
      }
      if (!penDraft) {
        const endpoint = vectorOpenEndpointAtScreen(event.x, event.y);
        if (endpoint) {
          beginPenExtension(endpoint);
          return;
        }
      }
      const point = beginPenPoint(world);
      if (point) drag = { mode: "pen-point", ...point };
      return;
    }
    if (tool !== "select") {
      if (event.readOnly) { render(); emitViewState(); return; }
      const snapped = snapCanvasPoint(world);
      const node = createNode(tool === "arrow" ? "line" : tool, snapped.x, snapped.y);
      if (tool === "arrow") {
        node.name = "Arrow";
        node.strokeCapEnd = "arrowLines";
      }
      if (node.kind !== "vector") {
        node.width = 4;
        node.height = node.kind === "line" ? 0 : 4;
      }
      drag = { mode: "draw", startX: snapped.x, startY: snapped.y, node };
      return;
    }
    const vectorHandle = !event.readOnly && vectorHandleAtScreen(event.x, event.y);
    if (vectorHandle) {
      drag = { mode: "vector-handle", ...vectorHandle, before: cloneDocument() };
      return;
    }
    const vectorAnchor = !event.readOnly && vectorAnchorAtScreen(event.x, event.y);
    if (vectorAnchor) {
      const alreadySelected = selectedVectorPoints.some((target) => target.id === vectorAnchor.id && target.pointId === vectorAnchor.pointId);
      if (event.shiftKey) {
        selectedVectorPoints = alreadySelected
          ? selectedVectorPoints.filter((target) => target.id !== vectorAnchor.id || target.pointId !== vectorAnchor.pointId)
          : [...selectedVectorPoints.filter((target) => target.id === vectorAnchor.id), vectorAnchor];
      } else {
        selectedVectorPoints = [vectorAnchor];
        drag = { mode: "vector-point", ...vectorAnchor, before: cloneDocument() };
      }
      render();
      return;
    }
    const vectorSegment = !event.readOnly && event.splitVectorSegment && vectorSegmentAtScreen(event.x, event.y);
    if (vectorSegment && wasmDocument) {
      dispatchTransaction({
        id: createId(),
        baseRevision: Number(wasmDocument.revision),
        commands: [{ type: "splitVectorSegment", id: vectorSegment.id, subpathIndex: vectorSegment.subpathIndex, afterPointId: vectorSegment.afterPointId, t: vectorSegment.t, pointId: createId() }],
      });
      return;
    }
    const rotate = !event.readOnly && rotateHandleAtScreen(event.x, event.y);
    if (rotate) {
      drag = { mode: "rotate", start: world, pivot: rotate.pivot, before: cloneDocument(), ids: rotate.ids };
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
    const target = hit(world.x, world.y, Boolean(event.drillDown), Boolean(event.deepSelect));
    if (!target) {
      drag = { mode: "select", startX: world.x, startY: world.y, currentX: world.x, currentY: world.y, startScreenX: event.x, startScreenY: event.y, marqueeStarted: false, initialSelection: event.shiftKey ? [...selectedIds] : [], additive: event.shiftKey };
      if (!event.shiftKey) {
        selectedIds = [];
        storeActivePageSelection();
        selectedVectorPoints = [];
      }
      render();
      emitViewState();
      return;
    }
    selectedIds = resolveCanvasObjectSelection(selectedIds, target.id, event.shiftKey);
    storeActivePageSelection();
    selectedVectorPoints = [];
    if (target && !event.readOnly) {
      const movable = movableSelectionIds(nodes, selectedIds);
      drag = { mode: "move", startX: world.x, startY: world.y, currentX: world.x, currentY: world.y, before: cloneDocument(), initial: new Set(nodes.filter((node) => movable.has(node.id)).map((node) => node.id)) };
    }
    render(); emitViewState(); return;
  }
  if (!drag) {
    if (event.event === "move") {
      if (tool === "pen" && penDraft) {
        const preview = snapCanvasPoint(world);
        const previous = penDraft.previewWorld;
        if (!previous || previous.x !== preview.x || previous.y !== preview.y) {
          penDraft.previewWorld = preview;
          render();
        }
        return;
      }
      const nextHoveredId = hoverHit(world.x, world.y)?.id;
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
    if ((activeDrag.mode === "move" || activeDrag.mode === "resize" || activeDrag.mode === "line-resize" || activeDrag.mode === "vector-point" || activeDrag.mode === "vector-handle" || activeDrag.mode === "multi-resize" || activeDrag.mode === "rotate") && activeDrag.before) {
      nodes = activeDrag.before;
      transientSceneVersion += 1;
      rebuildNodeIndex();
      render();
      emitSnapshot(undefined, false);
    }
    if (activeDrag.mode === "pen-point") cancelPenDraft();
    if (event.event === "up") drag = undefined;
    return;
  }
  if (event.event === "move") {
    if (activeDrag.mode === "pan") { viewport.x += (event.x - activeDrag.startX) / viewport.zoom; viewport.y += (event.y - activeDrag.startY) / viewport.zoom; activeDrag.startX = event.x; activeDrag.startY = event.y; activateInteractiveRenderQuality(); render(); emitInteractiveViewState(); }
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
        const previousWidth = activeDrag.node.width;
        const previousHeight = activeDrag.node.height;
        activeDrag.node.x = Math.min(activeDrag.startX, end.x);
        activeDrag.node.y = Math.min(activeDrag.startY, end.y);
        activeDrag.node.width = Math.max(4, Math.abs(end.x - activeDrag.startX));
        activeDrag.node.height = Math.max(4, Math.abs(end.y - activeDrag.startY));
        if (activeDrag.node.kind === "vector" && activeDrag.node.vectorPath && previousWidth > 0 && previousHeight > 0) {
          activeDrag.node.vectorPath = scaleVectorPath(activeDrag.node.vectorPath, activeDrag.node.width / previousWidth, activeDrag.node.height / previousHeight);
        }
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
      const movingIds = [...activeDrag.initial];
      const dropTarget = frameDropTargetAtPoint(activeDrag.before, movingIds, world);
      activeDrag.dropTargetId = dropTarget?.frame.id;
      activeDrag.currentX = world.x;
      activeDrag.currentY = world.y;
      render();
    }
    if (activeDrag.mode === "resize") {
      const geometry = resizeGeometryForCanvasNode(activeDrag.node, activeDrag.handle, activeDrag.start, world, event.shiftKey, event.altKey);
      if (geometry) {
        const vectorPath = activeDrag.node.kind === "vector" && activeDrag.node.vectorPath && activeDrag.node.width > 0 && activeDrag.node.height > 0
          ? scaleVectorPath(activeDrag.node.vectorPath, geometry.width / activeDrag.node.width, geometry.height / activeDrag.node.height)
          : undefined;
        nodes = nodes.map((node) => node.id === activeDrag.id ? { ...node, ...geometry, ...(vectorPath ? { vectorPath } : {}) } : node);
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
    if (activeDrag.mode === "vector-point") {
      const vector = activeDrag.before.find((node) => node.id === activeDrag.id);
      const local = vector && localVectorPointAtWorld(vector, world);
      if (vector?.vectorPath && local && Number.isFinite(local.x) && Number.isFinite(local.y)) {
        const vectorPath = structuredClone(vector.vectorPath);
        const point = vectorPath.subpaths.flatMap((subpath) => subpath.points).find((candidate) => candidate.id === activeDrag.pointId);
        if (point) {
          point.x = local.x;
          point.y = local.y;
          nodes = activeDrag.before.map((node) => node.id === activeDrag.id ? { ...node, vectorPath } : node);
          transientSceneVersion += 1;
          rebuildNodeIndex();
          render();
        }
      }
    }
    if (activeDrag.mode === "vector-handle") {
      const vector = activeDrag.before.find((node) => node.id === activeDrag.id);
      const local = vector && localVectorPointAtWorld(vector, world);
      if (vector?.vectorPath && local && Number.isFinite(local.x) && Number.isFinite(local.y)) {
        const vectorPath = structuredClone(vector.vectorPath);
        const point = vectorPath.subpaths.flatMap((subpath) => subpath.points).find((candidate) => candidate.id === activeDrag.pointId);
        if (point) {
          point[activeDrag.handle] = { x: local.x - point.x, y: local.y - point.y };
          nodes = activeDrag.before.map((node) => node.id === activeDrag.id ? { ...node, vectorPath } : node);
          transientSceneVersion += 1;
          rebuildNodeIndex();
          render();
        }
      }
    }
    if (activeDrag.mode === "pen-point" && penDraft?.node.id === activeDrag.id) {
      const local = localVectorPointAtWorld(penDraft.node, world);
      const point = penDraft.node.vectorPath?.subpaths[0]?.points.find((candidate) => candidate.id === activeDrag.pointId);
      if (local && point) {
        const dx = local.x - point.x;
        const dy = local.y - point.y;
        if (Number.isFinite(dx) && Number.isFinite(dy)) {
          const node = structuredClone(penDraft.node);
          const draftPoint = node.vectorPath!.subpaths[0].points.find((candidate) => candidate.id === activeDrag.pointId)!;
          // A dragged Pen point starts as a mirrored pair. It can subsequently
          // be made asymmetric with the existing point-handle editor.
          draftPoint.handleOut = { x: dx, y: dy };
          draftPoint.handleIn = { x: -dx, y: -dy };
          draftPoint.pointType = "mirrored";
          replacePenDraftNode(node);
        }
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
    if (activeDrag.mode === "rotate") {
      const patches = rotateSelectionAroundWorldPoint(activeDrag.before, activeDrag.ids, activeDrag.pivot, activeDrag.start, world, event.shiftKey);
      if (patches) {
        nodes = activeDrag.before.map((node) => patches.has(node.id) ? { ...node, ...patches.get(node.id)! } : node);
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
      const dropTarget = activeDrag.dropTargetId
        ? activeDrag.before.find((node) => node.id === activeDrag.dropTargetId && isFrameLike(node))
        : undefined;
      const movingIds = [...activeDrag.initial];
      const exitTarget = !dropTarget
        ? frameExitTargetAtPoint(activeDrag.before, movingIds, world)
        : undefined;
      // A drag that stays within an Auto layout Frame changes sibling position
      // IDs only. Geometry is owned by layout reflow, so never send the
      // transient drag matrices into Core for these flow children.
      const autoLayoutDrop = !dropTarget && !exitTarget
        ? autoLayoutDropReorder(activeDrag.before, movingIds, world)
        : undefined;
      const geometryCommands = autoLayoutDrop
        ? moveCommands.filter((command) => !movingIds.includes(command.id))
        : moveCommands;
      const commands: EditorCommand[] = dropTarget
        ? [...moveCommands, { type: "reparent", ids: movingIds, parentId: dropTarget.id }]
        : exitTarget
          ? [...moveCommands, { type: "reparent", ids: movingIds, parentId: exitTarget.parentId }]
          : autoLayoutDrop?.result
            ? [...geometryCommands, { type: "reposition", positionIds: [...autoLayoutDrop.result.positionIds].map(([id, positionId]) => ({ id, positionId })) }]
            : geometryCommands;
      if (!commands.length) { drag = undefined; nodes = activeDrag.before; transientSceneVersion += 1; rebuildNodeIndex(); render(); emitViewState(); return; }
      if (wasmDocument) {
        try {
          const baseRevision = Number(wasmDocument.revision);
          const moveTransactionId = createId();
          const resolved = resolveCoreBatch(activeDrag.before, commands);
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
      } else {
        const resolved = resolveCoreBatch(activeDrag.before, commands);
        if (!resolved) { drag = undefined; nodes = activeDrag.before; transientSceneVersion += 1; rebuildNodeIndex(); render(); emitSnapshot(); return; }
        nodes = resolved.nextNodes;
        history.push({ nodes: activeDrag.before, advancesRevision: true }); recordHistory("local"); revision += 1; render(); emitSnapshot();
      }
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
    if (activeDrag.mode === "vector-point") {
      const after = nodes.find((node) => node.id === activeDrag.id)?.vectorPath
        ?.subpaths.flatMap((subpath) => subpath.points)
        .find((point) => point.id === activeDrag.pointId);
      const before = activeDrag.before.find((node) => node.id === activeDrag.id)?.vectorPath
        ?.subpaths.flatMap((subpath) => subpath.points)
        .find((point) => point.id === activeDrag.pointId);
      nodes = activeDrag.before;
      transientSceneVersion += 1;
      rebuildNodeIndex();
      if (after && before && (after.x !== before.x || after.y !== before.y) && wasmDocument) {
        dispatchTransaction({
          id: createId(),
          baseRevision: Number(wasmDocument.revision),
          commands: [{ type: "moveVectorPoint", id: activeDrag.id, pointId: activeDrag.pointId, x: after.x, y: after.y }],
        });
      } else { render(); emitViewState(); }
    }
    if (activeDrag.mode === "vector-handle") {
      const after = nodes.find((node) => node.id === activeDrag.id)?.vectorPath
        ?.subpaths.flatMap((subpath) => subpath.points)
        .find((point) => point.id === activeDrag.pointId);
      const before = activeDrag.before.find((node) => node.id === activeDrag.id)?.vectorPath
        ?.subpaths.flatMap((subpath) => subpath.points)
        .find((point) => point.id === activeDrag.pointId);
      nodes = activeDrag.before;
      transientSceneVersion += 1;
      rebuildNodeIndex();
      const changed = after && before && JSON.stringify(after[activeDrag.handle]) !== JSON.stringify(before[activeDrag.handle]);
      if (changed && after && wasmDocument) {
        dispatchTransaction({
          id: createId(),
          baseRevision: Number(wasmDocument.revision),
          commands: [{
            type: "setVectorPointHandles",
            id: activeDrag.id,
            pointId: activeDrag.pointId,
            handleIn: after.handleIn,
            handleOut: after.handleOut,
            pointType: after.pointType,
          }],
        });
      } else { render(); emitViewState(); }
    }
    if (activeDrag.mode === "pen-point") {
      // The complete open path remains a transient draft until Enter or a
      // click on its first anchor. This avoids a history item per anchor.
      render();
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
          id: createId(),
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
    if (activeDrag.mode === "rotate") {
      const nextNodes = nodes;
      const patches = new Map(nextNodes.flatMap((after) => {
        const before = activeDrag.before.find((node) => node.id === after.id);
        if (!before || (before.x === after.x && before.y === after.y && before.rotation === after.rotation && JSON.stringify(before.relativeTransform) === JSON.stringify(after.relativeTransform))) return [];
        return [[after.id, ({ x: after.x, y: after.y, rotation: after.rotation, relativeTransform: after.relativeTransform }) satisfies SelectionRotationPatch] as const];
      }));
      nodes = activeDrag.before;
      transientSceneVersion += 1;
      rebuildNodeIndex();
      if (!patches.size) { render(); emitViewState(); }
      else if (wasmDocument) {
        dispatchTransaction({ id: createId(), baseRevision: Number(wasmDocument.revision), commands: [...patches].map(([id, patch]) => ({ type: "update" as const, id, patch })) });
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
  render(); emitInteractiveViewState();
}
function dispatchInputBatch(events: readonly Extract<MainToWorker, { type: "pointer" | "wheel" }>[]) {
  const occurredAt = events.reduce<number | undefined>((latest, event) => Number.isFinite(event.occurredAt) && event.occurredAt! >= 0 && (latest === undefined || event.occurredAt! > latest) ? event.occurredAt : latest, undefined);
  if (events.length && events.every((event) => event.type === "wheel")) {
    events.forEach(applyWheel);
    activateInteractiveRenderQuality();
    render(1);
    recordInputToRenderLatency(occurredAt);
    emitInteractiveViewState();
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
    else if (data.type === "visibility") {
      renderVisible = data.visible;
      if (renderVisible) {
        // Hiding the tab cancels the interaction settle timer. Restore it to
        // settled quality so returning cannot leave a cached preview forever.
        renderQuality = resolveRenderQuality(renderQuality, viewport.zoom, false);
        if (setRenderSurface(width, height, deviceDpr)) render();
      }
      else {
        progressivePaintGeneration += 1;
        finishProgressivePaint();
        if (renderQualityTimer) clearTimeout(renderQualityTimer);
        renderQualityTimer = undefined;
      }
    }
    else if (data.type === "tool") {
      if (tool === "pen" && data.tool !== "pen") cancelPenDraft();
      tool = data.tool;
    }
    else if (data.type === "checkpoint") emitViewportCheckpoint();
    else if (data.type === "remote-bootstrap") {
      remoteBootstrapPending = true;
      if (documentCore === "Rust/WASM bridge ready") emitRemoteBootstrap();
    }
    else if (data.type === "remote-hydrate") hydrateRemoteSnapshot(data.snapshot, data.requestId);
    else if (data.type === "remote-reconcile") void reconcileRemoteSnapshot(data.snapshot, data.operations);
    else if (data.type === "register-asset") registerAsset(data.transactionId, data.asset);
    else if (data.type === "import-figma-rest-plan") importFigmaRestPlan(data);
    else if (data.type === "bind-figma-rest-assets") bindFigmaRestAssets(data);
    else if (data.type === "set-clipboard") {
      if (validateClipboardCapture(data.clipboard, documentSchemaVersion)) emitError(undefined, "INVALID_COMMAND");
      else {
        clipboard = structuredClone(data.clipboard);
        clipboardSourceDocumentId = data.sourceDocumentId;
      }
    }
    else if (data.type === "asset-bytes") seedAssetBytes(data.assetId, data.mediaType, data.bytes, data.decodedBitmap);
    else if (data.type === "load-font") void ensureFontFace(data.assetId);
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
      if (data.key === "Escape" && penDraft) {
        cancelPenDraft();
        return;
      }
      if (data.key === "Escape" && selectedVectorPoints.length) {
        selectedVectorPoints = [];
        render();
        return;
      }
      if (shouldClearCanvasSelection({ ...data, selectedIds })) {
        selectedIds = [];
        storeActivePageSelection();
        render();
        emitViewState();
        return;
      }
      if (data.key === "Enter" && penDraft && !data.metaKey && !data.shiftKey) {
        finishPenDraft();
        return;
      }
      if (data.key === "Enter" && !data.metaKey && !data.shiftKey) {
        const node = createKeyboardToolNode({ tool, viewport, surface: { width, height } });
        if (node) {
          dispatch({ type: "create", node });
          return;
        }
      }
      if (data.key === "Enter" && !data.metaKey) {
        const nestedTarget = resolveNestedKeyboardTarget(activeNodes(), selectedIds, data.shiftKey ? "parent" : "child");
        if (nestedTarget) {
          selectedIds = [nestedTarget.id];
          storeActivePageSelection();
          selectedVectorPoints = [];
          render();
          emitViewState();
          return;
        }
      }
      const nudge = keyboardNudgeDelta({ ...data, selectedIds });
      if (nudge && nudgeSelectedVectorPoints(nudge)) return;
      const autoLayoutArrow = autoLayoutArrowReorder(nodes, selectedIds, data.key);
      if (autoLayoutArrow.handled) {
        const result = autoLayoutArrow.reorder?.result;
        if (result) dispatch({ type: "reposition", positionIds: [...result.positionIds].map(([id, positionId]) => ({ id, positionId })) });
        return;
      }
      if (nudge) {
        nudgeSelection(nudge);
        return;
      }
      if ((data.key === "Backspace" || data.key === "Delete") && !data.metaKey && !data.shiftKey && deleteSelectedVectorPoints()) return;
      const command = editorKeyCommand({ ...data, selectedIds, selectedKinds: selectedIds.map((id) => nodes.find((node) => node.id === id)?.kind) });
      if (command) dispatch(command);
    }
  } catch (error) { emitError(error); }
};
