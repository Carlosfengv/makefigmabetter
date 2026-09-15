/// <reference lib="webworker" />

import type { AutoLayoutPaddingSide, BenchmarkProjectionSnapshot, CanvasNode, CanvasPage, CoreJournalOperation, CoreLocalSnapshot, DocumentAsset, DocumentAutoLayout, DocumentFontReference, DocumentGradientPaint, DocumentImagePaint, DocumentPaintLayer, DocumentVectorPath, EditorClipboard, EditorCommand, EditorSnapshot, LocalJournalEntry, MainToWorker, PendingOperationReplay, PendingRemoteOperation, PresentationNode, RendererPreference, SimulatedGpuFault, ToolKind, Viewport, WorkerToMain } from "@/lib/editor-protocol";
import { createDiagnosticRecorder } from "@/lib/diagnostics";
import { createCooperativeYield } from "@/lib/cooperative-yield";
import { findTopmostCanvasSelectionCandidate, findTopmostHit, nodeContainsWorldPoint } from "@/lib/hit-test";
import { createRenderPerformanceSampler } from "@/lib/performance-sampling";
import { admitRenderSurface, MAX_RENDER_SURFACE_BYTES } from "@/lib/render-surface-budget";
import { admitAlphaMaskSurface } from "@/lib/alpha-mask-budget";
import { admitCompositeSurfaceBytes } from "@/lib/composite-surface-budget";
import { admitCompositeFrame, type CompositeFrameSurfacePlan, type CompositePoolDimensions } from "@/lib/composite-frame-demand";
import { admitSubtreeCompositeSurfacePool, MAX_SUBTREE_COMPOSITE_NESTING } from "@/lib/subtree-composite-budget";
import { morphAlphaChannel } from "@/lib/alpha-morphology";
import { compositeEffectSurface } from "@/lib/canvas-effect-composite";
import { canvasTextGlyphBitmap, canvasTextGlyphPose, canvasTextGlyphSurfaceByteLength, MAX_CANVAS_TEXT_GLYPH_SURFACE_BYTES } from "@/lib/canvas-text-glyph";
import { isLinearBlendMode, type LinearBlendMode } from "@/lib/linear-blend-composite";
import { compositeLinearPaintLayer } from "@/lib/linear-paint-layer-composite";
import { compositeSurfaceWindowForWorldBounds, setCompositeSurfaceTransform, transformedCompositeSurfaceWindow, type CompositeSurfaceWindow } from "@/lib/composite-surface-window";
import { activeMaskAlphaEffects, activeNodeEffects, effectChangesPixels, nodePresentationRequiresBackdrop, requiresSubtreeComposition, subtreeSourceNode } from "@/lib/subtree-compositing";
import { normalizedFillLayers, normalizedFillPaints, normalizedNodeEffects, normalizedStrokeLayers, normalizedStrokePaints } from "@/lib/normalized-node-view";
import { assessWasmHeap, MAX_WASM_HEAP_BYTES } from "@/lib/wasm-heap-budget";
import { createId, createNode, DEFAULT_TEXT_LINE_HEIGHT, documentColorFromCssHex } from "@/lib/editor-protocol";
import { resolvedTextLineHeight, resolvedTextLineHeightAt } from "@/lib/text-line-height";
import { colorToLinearSrgbComponents, colorToSrgbCss, sampleLinearGradientForCanvas } from "@/lib/color-rendering";
import { layoutTextRanges, resolveTextRenderMetrics, textAlignedLineLeft, textHangingPunctuationOffsets, textLineStartsParagraph, textListIndentationOffset, textListMarker, textListMarkerBaseIndent, textListMarkerGutterForProperties, textParagraphGap, textParagraphIndentAt, textParagraphListTypeAt, textParagraphStartAtOffset, textParagraphWrapStyleAt } from "@/lib/text-layout";
import { styledTextSpans, styledTextVisualSpans, type RenderTextStyle } from "@/lib/text-style-runs";
import { basicTextDecorationPattern, basicTextDecorationRect, textDecorationPaintLayers, textDecorationVisibleSegments, type BasicTextDecorationPattern, type BasicTextDecorationRect } from "@/lib/text-decoration";
import { usesSmallCaps } from "@/lib/text-case";
import { admitWebGpuSceneResources, classifyWebGpuRendererFailure, GpuSceneResourceLimitError, MAX_GPU_EFFECT_TEXTURE_BYTES, MAX_GPU_SCENE_RESOURCE_BYTES, WebGpuSceneRenderer, type WebGpuTextGlyph } from "@/lib/webgpu-scene";
import { decodeInputBatch } from "@/lib/input-transfer";
import { autoLayoutProjectionNormalizationPatches, captureClipboard, coalesceAdjacentNodeUpdates, coreProjectionNode, normalizeAutoLayoutProjection, resolveCoreBatch, resolveFlattenBooleanBatch, resolveLineOutlineStrokeBatch, resolveOutlineStrokeBatch, resolveParametricShapeToVectorBatch, resolvePasteBatch, type CoreBatchCommand, type CoreProjectionNode } from "@/lib/transaction-batch";
import { validateClipboardCapture } from "@/lib/editor-clipboard";
import { cancelFigmaRestAssetBindings, resolveFigmaRestAssetBindings, resolveFigmaRestImportBatch } from "@/lib/figma-rest-import";
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
import { canMaterializeCanvasIsland, gpuLayerIslands, limitGpuLayerIslands, type GpuLayerIsland } from "@/lib/gpu-layer-prefix";
import { exceedsMarqueeDragThreshold, lineSelectionBounds, marqueeRect, resolveMarqueeSelection, rotatedNodeBounds } from "@/lib/marquee-selection";
import { resolveMultiResizeSelection, type MultiResizeSelection } from "@/lib/multi-selection";
import { worldLineVisualBounds } from "@/lib/line-world-bounds";
import { selectionDimensions } from "@/lib/selection-label";
import { selectionParentRelationship } from "@/lib/selection-parent-relationship";
import { renderParentRelationship } from "@/lib/render-parent-relationship";
import { autoLayoutPaddingOverlay, autoLayoutPaddingSideAtWorldPoint } from "@/lib/auto-layout-padding-overlay";
import { autoLayoutPaddingBadgeBounds, isPointInAutoLayoutPaddingBadge, renderAutoLayoutPadding } from "@/lib/render-auto-layout-padding";
import { autoLayoutPaddingDragDelta, autoLayoutWithDraggedPadding } from "@/lib/auto-layout-padding-drag";
import { normalizeAutoLayout } from "@/lib/auto-layout-normalization";
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
import { firstAvailableResource, LatestResourceLoad } from "@/lib/latest-resource-load";
import { ImageBitmapCache } from "@/lib/image-bitmap-cache";
import { imagePaintHasAlphaAtLocalPoint, type RasterAlpha } from "@/lib/image-alpha-hit";
import { applyImageFiltersToRgba, imageFiltersAreNeutral, imageFiltersKey } from "@/lib/image-filters";
import { alphaChannelFromRgba, maskNeedsRenderedAlphaHit, renderedMaskAlphaAtWorldPoint, type RenderedMaskAlphaHit } from "@/lib/rendered-mask-alpha-hit";
import { scenePresentationKey } from "@/lib/scene-presentation-key";
import { decodeRasterInWorker } from "@/lib/asset-decode-client";
import { MAX_RASTER_DECODED_BYTES } from "@/lib/untrusted-asset";
import { FontFaceRegistry } from "@/lib/font-face-registry";
import { fontVariationCss } from "@/lib/font-variation-axes";
import { documentFontFamilyChain } from "@/lib/document-font-family-chain";
import { leadingTrimLineBox as resolveLeadingTrimLineBox } from "@/lib/text-baseline";
import { parseRustGpuSceneBatch } from "@/lib/rust-gpu-batch";
import { hasMissingRustTextGlyph, parseRustTextLayout, remapRustTextLayoutToSource, type RustTextLayout, type RustTextVisualRun } from "@/lib/rust-text-layout";
import {
  textFrozenLayoutPlan,
  TEXT_PATH_SINGLE_LINE_WIDTH,
  textLayoutInputFromPlan,
} from "@/lib/text-svg-layout-input";
import { endingEllipsis, textDisplayLines } from "@/lib/text-truncation";
import { findTopmostTransformGroupRepeatHit } from "@/lib/transform-group-repeat-hit";
import { parseRustTextCaretLayout } from "@/lib/rust-text-caret";
import { parseRustGlyphRaster } from "@/lib/rust-glyph-raster";
import { parseRustRenderGraphPlan, type RustRenderGraphPlan } from "@/lib/rust-render-graph";
import { projectGpuTextGlyphs } from "@/lib/gpu-text-projection";
import { projectTextPathGpuGlyphs, projectTextPathLocalGlyphs } from "@/lib/text-path-gpu-projection";
import { hasCommittedResize, isCornerResizeHandle, resizeGeometryFromCenter, resizeGeometryFromCorner, resizeGeometryFromCornerWithFlip, resizeRotatedLegacyGeometry, type CanvasResizeHandle, type ResizeGeometry } from "@/lib/canvas-resize";
import { constraintGuidesForNode } from "@/lib/constraint-guides";
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
import { connectorEndpointDecorations, connectorLabelLayout, scaledConnectorDecorationTriangles } from "@/lib/connector-presentation";
import { affineScreenMatrix, indexTransformGroupRepeatChildren, transformGroupRepeatDerivedBounds, transformGroupRepeatMatrices, transformGroupRepeatSubtree, transformGroupRepeatWorldBounds } from "@/lib/transform-group-repeat";
import { traceVectorPath } from "@/lib/vector-path";
import { rotateSelectionAroundWorldPoint, type SelectionRotationPatch } from "@/lib/selection-rotation";
import { wasmHydrationBatches } from "@/lib/wasm-hydration-batches";
import { orderNewLayerAtFront, sortNodesByLayerOrder } from "@/lib/layer-order";
import { planPendingOperationReconciliation } from "@/lib/pending-operation-reconciliation";
import { rebaseCoreBatchForSnapshot } from "@/lib/rebase-core-batch";
import { fullStateReplayBatch, historyReplayBatch } from "@/lib/history-replay-batch";
import { canvasNodeFromWasmProjection } from "@/lib/wasm-projection-node";
import { visibleNodesOnPage } from "@/lib/hierarchy-visibility";
import { fitViewportToBounds, isSameRenderedViewport, pageContentBounds, selectViewportFrameForInteraction } from "@/lib/page-viewport";
import { isFullyClippedForSelection } from "@/lib/selection-clip";
import { invertAffine, multiplyAffine, nodePropsForWorldTransform, normalizeGroupBounds, transformPoint, translateNodeWorldPatch, worldBoundsForTransform, worldSpaceProjectionNodes, worldTransformForNode, worldTransformsForNodes, type AffineMatrix } from "@/lib/scene-transform";
import {
  imagePaintLayoutBox,
  resolvedImagePaintTransform,
} from "@/lib/image-paint-transform";
import { worldEffectPaddingForNodeBounds, worldVisualBoundsForNode } from "@/lib/world-visual-bounds";
import { closedShapeStrokeLocalBounds } from "@/lib/closed-shape-stroke-bounds";
import { ellipseStrokeRing } from "@/lib/ellipse-stroke-ring";
import { frameDropTargetAtPoint, frameExitTargetAtPoint } from "@/lib/frame-drop-target";
import { autoLayoutArrowReorder, autoLayoutDropReorder } from "@/lib/auto-layout-reorder";
import { joinCrossVectorEndpoints } from "@/lib/vector-cross-connect";
import { compileScene, findTopmostSceneHit, sceneNodesInPaintOrder } from "@/runtime/scene-compiler";
import { planDirtyRegionReplay, type DirtyRegionReplayPlan } from "@/runtime/dirty-region-replay";
import { sceneClipGeometryByNodeId, sceneMaskSourceByNodeId, type ClipGeometryRef, type OrderedRenderScene } from "@/runtime/ordered-render-ir";
import { specialNodeFallback } from "@/lib/special-node-fallback";
import { clipsChildren } from "@/lib/node-capabilities";
import { connectorPathForNode, traceConnectorPath } from "@/lib/connector-path";
import { DEFAULT_PAGE_ID, migrateLegacyFigmaBootstrapPage } from "@/lib/document-bootstrap";

declare const self: DedicatedWorkerGlobalScope;
const ENGINE_SEMANTICS_VERSION = 29;

type Drag =
  | { mode: "draw"; startX: number; startY: number; node: CanvasNode }
  | { mode: "move"; startX: number; startY: number; currentX: number; currentY: number; before: CanvasNode[]; initial: Set<string>; dropTargetId?: string }
  | { mode: "resize"; id: string; handle: CanvasResizeHandle; start: { x: number; y: number }; node: CanvasNode; before: CanvasNode[]; ignoreConstraints: boolean; previewTransactionId: string }
  | { mode: "multi-resize"; handle: CanvasResizeHandle; start: { x: number; y: number }; bounds: ResizeGeometry; before: CanvasNode[]; ids: string[]; requiresAffine: boolean }
  | { mode: "rotate"; start: { x: number; y: number }; pivot: { x: number; y: number }; before: CanvasNode[]; ids: string[] }
  | { mode: "line-resize"; id: string; endpoint: LineEndpoint; node: CanvasNode; before: CanvasNode[] }
  | { mode: "auto-layout-padding"; id: string; side: AutoLayoutPaddingSide; startX: number; startY: number; layout: DocumentAutoLayout; before: CanvasNode[] }
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
  preview_resize_transaction_json(transactionId: string, commandsJson: string): string;
  register_asset(transactionId: string, baseRevision: bigint, assetId: string, contentHash: string, mediaType: string, byteLength: bigint, pixelWidth: number, pixelHeight: number, fontFacesJson: string): bigint;
  undo(): bigint;
  redo(): bigint;
  snapshot_json(): string;
  render_graph_plan_for_page_json(pageId: string, viewportX: number, viewportY: number, viewportWidth: number, viewportHeight: number): string;
  gpu_scene_instances_json(pageId: string): string;
  load_snapshot_protobuf(bytes: Uint8Array): bigint;
  load_snapshot_json(value: string): bigint;
  seed_document_id(documentId: string): void;
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
let presentedRevision: number | undefined;
let presentedSurfaceWidth = 0;
let presentedSurfaceHeight = 0;
let presentedViewport: Viewport | undefined;
let presentedScene: OrderedRenderScene | undefined;
let lastDirtyRegionReplaySignature = "";
let lastDirtyRegionReplayBlockerSignature = "";
let lastDirtyRegionPlanSignature = "";
let cachedPresentedFrame: OffscreenCanvas | undefined;
let cachedPresentedFramePageId: string | undefined;
let cachedPresentedFrameSceneKey: string | undefined;
let cachedPresentedFrameViewport: Viewport | undefined;
let cachedPresentedFrameSurfaceWidth = 0;
let cachedPresentedFrameSurfaceHeight = 0;
let interactionCacheSurface: OffscreenCanvas | undefined;
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
const filteredImageSurfaces = new Map<string, { bitmap: ImageBitmap; surface: OffscreenCanvas; bytes: number }>();
const MAX_FILTERED_IMAGE_SURFACE_BYTES = 64 * 1024 * 1024;
let filteredImageSurfaceBytes = 0;
const canvasTextGlyphSurfaces = new Map<string, { surface: OffscreenCanvas; bytes: number }>();
let canvasTextGlyphSurfaceBytes = 0;
let canvasTextGlyphLimitReported = false;
const nonLinearGradientSurfaces = new Map<string, OffscreenCanvas>();
const MAX_NON_LINEAR_GRADIENT_CACHE_ENTRIES = 16;
const imageDecodeLoads = new LatestResourceLoad();
const MAX_IMAGE_ALPHA_HIT_BYTES = Math.min(32 * 1024 * 1024, Math.floor(MAX_RASTER_DECODED_BYTES / 8));
const imageAlphaHits = new Map<string, { bitmap: ImageBitmap; raster: RasterAlpha; bytes: number }>();
let imageAlphaHitBytes = 0;
const MAX_RENDERED_MASK_ALPHA_HIT_BYTES = 16 * 1024 * 1024;
const renderedMaskAlphaHits = new Map<string, { rendered: RenderedMaskAlphaHit; bytes: number }>();
let renderedMaskAlphaHitBytes = 0;
const imageLoads = new Set<string>();
const fontFaces = new FontFaceRegistry();
const runtimeFontBlobs = new Map<string, Blob>();
const runtimeFontBlobWaiters = new Map<string, Set<(blob: Blob | undefined) => void>>();
const MAX_RUNTIME_FONT_BYTES = 32 * 1024 * 1024;
const RUNTIME_FONT_WAIT_MS = 1_000;
let runtimeFontBytes = 0;
let nodeById = new Map(nodes.map((node) => [node.id, node]));
let nodeBoundsById = new Map(nodes.map((node) => [node.id, boundsForNode(node)]));
let worldTransformById = worldTransformsForNodes(nodes);
let repeatSourceIdsByGroupId = new Map<string, readonly string[]>();
let activeNodesCache: CanvasNode[] | undefined;
let activeNodeOrderByIdCache: ReadonlyMap<string, number> | undefined;
let activePageRenderFactsCache: Readonly<{
  nodes: readonly CanvasNode[];
  hasFrameChildren: boolean;
  hasAlphaMasks: boolean;
  hasTransformGroupRepeat: boolean;
  hasSubtreeComposition: boolean;
  hasRelativeTransform: boolean;
  hasSlices: boolean;
  parentIds: ReadonlySet<string>;
}> | undefined;
let gpuBackendPlanCache: Readonly<{
  key: string;
  pageNodes: readonly CanvasNode[];
  backendIslands: readonly GpuLayerIsland[];
  gpuIslands: readonly Extract<GpuLayerIsland, { backend: "gpu" }>[];
  gpuNodes: readonly CanvasNode[];
  gpuNodeIds: ReadonlySet<string>;
  gpuImageAssetIds: ReadonlySet<string>;
  textGlyphs: readonly WebGpuTextGlyph[];
  admission?: Readonly<{
    surfaceKey: string;
    value: ReturnType<typeof admitWebGpuSceneResources>;
  }>;
}> | undefined;
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
let compiledScenePreviousScene: OrderedRenderScene | undefined;
let compiledClipGeometryByNodeId: ReadonlyMap<string, ClipGeometryRef> = new Map();
let compiledMaskSourceByNodeId: ReturnType<typeof sceneMaskSourceByNodeId> = new Map();
let compiledSceneFallbackSignature = "";
let sceneResourceGeneration = 0;
let documentId = "00000000-0000-0000-0000-000000000000";
let drag: Drag | undefined;
let hoveredId: string | undefined;
let hoveredAutoLayoutPadding: { frameId: string; side: AutoLayoutPaddingSide } | undefined;
let editingTextNodeId: string | undefined;
let documentCore: EditorSnapshot["documentCore"] = "Starting Rust/WASM bridge";
let wasmDocument: WasmDocumentEngine | undefined;
let bridgeLoadSequence = 0;
let hydrationCompletionRequestId: string | undefined;
let ephemeralBenchmarkProjection = false;
let benchmarkEvidence: EditorSnapshot["benchmark"];
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
let captureFrameHash = false;
let captureFrameSamples: readonly { label: string; x: number; y: number }[] = [];
let capturedFrameHashKey = "";
let gpuSceneBytes = 0;
let gpuEffectTextureBytes = 0;
let gpuSceneWithinBudget = true;
let gpuSceneLimitReported = false;
let textAtlasStatsSignature = "";
let imageTextureStatsSignature = "";
let effectTextureStatsSignature = "";
let affineGpuTextStatsSignature = "";
let rustRenderGraphFailureSignature = "";
type RustGpuScene = { revision: number; pageId: string; transientSceneVersion: number; instances: Float32Array; renderedNodeIds: ReadonlySet<string> };
let rustGpuScene: RustGpuScene | undefined;
const MAX_RUST_GPU_INSTANCE_NODES = 20_000;
type RustTextLayoutProjection = { revision: number; key: string; layout: RustTextLayout };
const rustTextLayouts = new Map<string, RustTextLayoutProjection>();
const rustTextLayoutLoads = new Set<string>();
/** Explicit-font shaping cannot safely decide line breaks once browser font
 * fallback participates. Remember the content-addressed fallback so an
 * unrelated document revision does not repeatedly request the same unusable
 * layout. */
const rustTextLayoutFallbacks = new Map<string, Omit<RustTextLayoutProjection, "layout">>();
type RustTextGlyphProjection = {
  revision: number;
  key: string;
  /** World-space unit-quad affines accepted by the WebGPU text pass. */
  glyphs: readonly WebGpuTextGlyph[];
  /** Node-local quads consumed under Canvas's existing full node affine. */
  canvasGlyphs?: readonly WebGpuTextGlyph[];
};
const rustTextGlyphs = new Map<string, RustTextGlyphProjection>();
const rustTextGlyphLoads = new Set<string>();
const MAX_RUST_TEXT_GLYPHS_PER_NODE = 4_096;
const COMPLEX_DOCUMENT_NODE_THRESHOLD = 1_000;
const MAX_INTERACTION_CACHE_SURFACE_BYTES = 32 * 1024 * 1024;
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
type AlphaMaskSurfaces = {
  target: OffscreenCanvas;
  targetContext: OffscreenCanvasRenderingContext2D;
  mask: OffscreenCanvas;
  maskContext: OffscreenCanvasRenderingContext2D;
};
// Reuse one target/mask pair at each live nesting depth instead of allocating
// two full-canvas bitmaps for every sibling run and every frame.
let alphaMaskSurfaces: Array<AlphaMaskSurfaces | undefined> = [];
type SubtreeCompositeSurfaces = EffectSurfaces;
let subtreeCompositeSurfaces: Array<SubtreeCompositeSurfaces | undefined> = [];
type CanvasFallbackSurface = {
  surface: OffscreenCanvas;
  context: OffscreenCanvasRenderingContext2D;
};
let canvasFallbackSurface: CanvasFallbackSurface | undefined;
let subtreeCompositeLimitReported = false;
let compositeSurfaceLimitReported = false;
const compositeContextWindows = new WeakMap<OffscreenCanvasRenderingContext2D, CompositeSurfaceWindow>();
const repeatScreenTransformByContext = new WeakMap<OffscreenCanvasRenderingContext2D, AffineMatrix>();
const repeatSourcePreparationContexts = new WeakSet<OffscreenCanvasRenderingContext2D>();
/** Mask sources are rendered for coverage only. Background Blur changes the
 * colour behind a layer, not its source alpha, and must not seed this surface
 * with destination alpha. The flag follows nested prepared surfaces while a
 * mask branch is being evaluated. */
const maskAlphaPreparationContexts = new WeakSet<OffscreenCanvasRenderingContext2D>();
/** A prepared subtree is transparent by construction, but descendant
 * Background Blur must see both its earlier local siblings and the real
 * destination behind the prepared owner. The chain is scoped to one paint
 * call and may itself point at another prepared surface. */
const preparedBackdropContextByContext = new WeakMap<
  OffscreenCanvasRenderingContext2D,
  OffscreenCanvasRenderingContext2D
>();
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
type ActiveFrameRenderCost = { canvasReadbackBytes: number };
let activeFrameRenderCost: ActiveFrameRenderCost | undefined;
function recordCanvasReadbackBytes(bytes: number) {
  if (activeFrameRenderCost && Number.isSafeInteger(bytes) && bytes > 0)
    activeFrameRenderCost.canvasReadbackBytes += bytes;
}

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
  if (activeNodesCache) return activeNodesCache;
  const visible = visibleNodesOnPage(nodes, activePageId, defaultPageId);
  const projected = sortNodesByLayerOrder(visible.map((node) => nodeById.get(node.id) ?? node));
  // Every backend starts with the Scene Compiler's display list. The local
  // sort is retained solely as the cold-start/stale-IR fallback inside
  // sceneNodesInPaintOrder; it may not define a different render order.
  activeNodesCache = sceneNodesInPaintOrder(compiledScene?.scene, projected);
  activeNodeOrderByIdCache = new Map(activeNodesCache.map((node, index) => [node.id, index]));
  return activeNodesCache;
}
function activePageRenderFacts(pageNodes: readonly CanvasNode[]) {
  if (activePageRenderFactsCache?.nodes === pageNodes) return activePageRenderFactsCache;
  const parentIds = new Set(pageNodes.flatMap((node) => node.parentId ? [node.parentId] : []));
  const facts = {
    nodes: pageNodes,
    hasFrameChildren: pageNodes.some((node) => {
      const parent = node.parentId ? nodeById.get(node.parentId) : undefined;
      return Boolean(parent && isFrameLike(parent) && parent.clipsContent !== false);
    }),
    hasAlphaMasks: pageNodes.some((node) => Boolean(node.isMask)),
    hasTransformGroupRepeat: pageNodes.some((node) => node.kind === "transformGroup" && Boolean(transformGroupRepeatMatrices(nodes, node)?.length)),
    hasSubtreeComposition: pageNodes.some((node) => requiresSubtreeComposition(node, parentIds.has(node.id))),
    hasRelativeTransform: pageNodes.some((node) => Boolean(node.relativeTransform)),
    hasSlices: pageNodes.some((node) => node.kind === "slice"),
    parentIds,
  } as const;
  activePageRenderFactsCache = facts;
  return facts;
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
  return node.relativeTransform
    ? compiledMaskSourceByNodeId.get(node.id)?.worldTransform ?? worldTransformById.get(node.id)
    : undefined;
}
function isFrameLike(node: CanvasNode | undefined) {
  return Boolean(node && clipsChildren(node.kind));
}

/** Projects a Frame resize through a disposable Core document. This keeps
 * transient Constraints and Auto Layout geometry identical to pointer-up while
 * leaving the live revision/history untouched. */
function coreResizePreview(activeDrag: Extract<Drag, { mode: "resize" }>, geometry: ResizeGeometry): CanvasNode[] | undefined {
  if (!wasmDocument || !isFrameLike(activeDrag.node)) return undefined;
  const command: EditorCommand = activeDrag.ignoreConstraints
    ? { type: "resizeWithoutConstraints", id: activeDrag.id, patch: geometry }
    : { type: "update", id: activeDrag.id, patch: geometry };
  const resolved = resolveCoreBatch(activeDrag.before, [command]);
  if (!resolved) return undefined;
  try {
    const projection = JSON.parse(wasmDocument.preview_resize_transaction_json(
      activeDrag.previewTransactionId,
      JSON.stringify(resolved.batch),
    )) as CoreProjectionNode[];
    const changed = new Map(projection.map((node) => {
      const projected = canvasNodeFromWasmProjection(node);
      return [projected.id, projected] as const;
    }));
    return activeDrag.before.map((node) => changed.get(node.id) ?? node);
  } catch {
    // Invalid intermediate sizes are transient pointer states. Fall back to the
    // authored parent geometry and let the next valid frame retry Core.
    return undefined;
  }
}
function boundsForNode(node: CanvasNode) {
  if (node.kind === "line" || node.kind === "connector") {
    const visual = worldLineVisualBounds(nodes, node, {
      transform: worldTransformById.get(node.id),
      defaultPageId,
      worldTransformByNodeId: worldTransformById,
      nodeById,
    });
    if (visual) return { x: visual.left, y: visual.top, width: visual.right - visual.left, height: visual.bottom - visual.top };
  }
  if ((node.kind === "text" || node.kind === "shapeWithText") && node.textProperties?.paragraph.hangingList) {
    // The spatial index owns projected world nodes. Resolve against that
    // projection so a parent's scale is not applied twice to the marker gutter.
    const visual = worldVisualBoundsForNode([node], node);
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
  if (node.kind === "connector") return nodeContainsWorldPoint(node, point, nodes, worldTransformById, nodeById, defaultPageId);
  const affine = nativeAffineForNode(node);
  if (!affine) return findTopmostHit([node], point) === node;
  const inverse = invertAffine(affine);
  if (!inverse) return false;
  const local = transformPoint(inverse, point);
  return findTopmostHit([{ ...node, x: 0, y: 0, rotation: 0, relativeTransform: undefined }], local) !== undefined;
}

function localPointForNode(node: CanvasNode, point: Readonly<{ x: number; y: number }>) {
  const affine = nativeAffineForNode(node);
  if (affine) {
    const inverse = invertAffine(affine);
    return inverse ? transformPoint(inverse, point) : undefined;
  }
  const radians = node.rotation * Math.PI / 180;
  const dx = point.x - (node.x + node.width / 2);
  const dy = point.y - (node.y + node.height / 2);
  return {
    x: Math.cos(radians) * dx + Math.sin(radians) * dy + node.width / 2,
    y: -Math.sin(radians) * dx + Math.cos(radians) * dy + node.height / 2,
  };
}

function rasterAlphaForBitmap(assetId: string, bitmap: ImageBitmap): RasterAlpha | undefined {
  const cached = imageAlphaHits.get(assetId);
  if (cached?.bitmap === bitmap) {
    imageAlphaHits.delete(assetId);
    imageAlphaHits.set(assetId, cached);
    return cached.raster;
  }
  if (cached) {
    imageAlphaHits.delete(assetId);
    imageAlphaHitBytes -= cached.bytes;
  }
  const bytes = bitmap.width * bitmap.height;
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_IMAGE_ALPHA_HIT_BYTES) return undefined;
  try {
    const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = surface.getContext("2d", { willReadFrequently: true });
    if (!context) return undefined;
    context.drawImage(bitmap, 0, 0);
    const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const alpha = new Uint8Array(bitmap.width * bitmap.height);
    for (let index = 0; index < alpha.length; index += 1) alpha[index] = rgba[index * 4 + 3]!;
    const result = { width: bitmap.width, height: bitmap.height, alpha };
    while (imageAlphaHitBytes + bytes > MAX_IMAGE_ALPHA_HIT_BYTES) {
      const oldest = imageAlphaHits.entries().next().value as [string, { bitmap: ImageBitmap; raster: RasterAlpha; bytes: number }] | undefined;
      if (!oldest) break;
      imageAlphaHits.delete(oldest[0]);
      imageAlphaHitBytes -= oldest[1].bytes;
    }
    imageAlphaHits.set(assetId, { bitmap, raster: result, bytes });
    imageAlphaHitBytes += bytes;
    return result;
  } catch {
    return undefined;
  }
}

/** Image-only masks use decoded source alpha for hit testing. A missing or
 * unreadable bitmap keeps the visible placeholder's conservative geometry hit. */
function cachedRenderedMaskAlphaAtWorldPoint(nodeId: string, point: Readonly<{ x: number; y: number }>) {
  const cached = renderedMaskAlphaHits.get(nodeId);
  if (!cached) return undefined;
  const rendered = renderedMaskAlphaAtWorldPoint(cached.rendered, {
    revision,
    resourceGeneration: sceneResourceGeneration,
    viewport,
    canvasWidth: width,
    canvasHeight: height,
  }, point);
  if (rendered !== undefined) {
    renderedMaskAlphaHits.delete(nodeId);
    renderedMaskAlphaHits.set(nodeId, cached);
  }
  return rendered;
}

function maskPaintHasAlphaAtWorldPoint(node: CanvasNode, point: Readonly<{ x: number; y: number }>) {
  const rendered = cachedRenderedMaskAlphaAtWorldPoint(node.id, point);
  if (rendered !== undefined) return rendered;
  const local = localPointForNode(node, point);
  if (!local) return false;
  if (node.assetId) {
    const bitmap = imageBitmaps.get(node.assetId);
    const raster = bitmap && rasterAlphaForBitmap(node.assetId, bitmap);
    return !bitmap || !raster || imagePaintHasAlphaAtLocalPoint({
      assetId: node.assetId,
      scaleMode: "fill",
      transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    }, node.width, node.height, raster, local);
  }
  const layers = activeFillLayers(node).filter((layer) => layer.visible && layer.opacity > 0);
  if (!layers.some((layer) => layer.image)) return true;
  for (const layer of layers) {
    if (layer.paint) {
      const paintAlpha = layer.paint.gradient?.stops.some((stop) => stop.color.alpha > 0)
        ?? layer.paint.gradientPaint?.stops.some((stop) => stop.color.alpha > 0)
        ?? (layer.paint.color ?? documentColorFromCssHex(layer.paint.css))?.alpha !== 0;
      if (paintAlpha) return true;
      continue;
    }
    const bitmap = imageBitmaps.get(layer.image.assetId);
    const raster = bitmap && rasterAlphaForBitmap(layer.image.assetId, bitmap);
    if (!bitmap || !raster || imagePaintHasAlphaAtLocalPoint(layer.image, node.width, node.height, raster, local)) return true;
  }
  return false;
}

function cacheRenderedMaskAlphaHit(
  node: CanvasNode,
  context: OffscreenCanvasRenderingContext2D,
  window: CompositeSurfaceWindow,
  force = false,
) {
  const existing = renderedMaskAlphaHits.get(node.id);
  if (existing) {
    renderedMaskAlphaHits.delete(node.id);
    renderedMaskAlphaHitBytes -= existing.bytes;
  }
  if (!force && !maskNeedsRenderedAlphaHit(node)) return;
  try {
    const rgba = context.getImageData(0, 0, window.pixelWidth, window.pixelHeight).data;
    const alpha = alphaChannelFromRgba(rgba, window.pixelWidth, window.pixelHeight);
    if (!alpha || alpha.byteLength > MAX_RENDERED_MASK_ALPHA_HIT_BYTES) return;
    while (renderedMaskAlphaHitBytes + alpha.byteLength > MAX_RENDERED_MASK_ALPHA_HIT_BYTES) {
      const oldest = renderedMaskAlphaHits.entries().next().value as [string, { rendered: RenderedMaskAlphaHit; bytes: number }] | undefined;
      if (!oldest) break;
      renderedMaskAlphaHits.delete(oldest[0]);
      renderedMaskAlphaHitBytes -= oldest[1].bytes;
    }
    const rendered: RenderedMaskAlphaHit = {
      revision,
      resourceGeneration: sceneResourceGeneration,
      viewport: { ...viewport },
      canvasWidth: width,
      canvasHeight: height,
      window: { ...window },
      alpha,
    };
    renderedMaskAlphaHits.set(node.id, { rendered, bytes: alpha.byteLength });
    renderedMaskAlphaHitBytes += alpha.byteLength;
  } catch {
    // An unavailable readback keeps the existing conservative analytic hit
    // path. Rendering and document state remain unaffected.
  }
}
/** Frame clipping and G4 alpha masks are structural visibility gates. Keep
 * this test beside hit testing so targets outside either source are never
 * selected even if their own geometry contains the pointer. */
function isInsideClippingFrames(node: CanvasNode, point: { x: number; y: number }, stopParentId?: string) {
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
      const renderedAlpha = cachedRenderedMaskAlphaAtWorldPoint(mask.id, point);
      if (mask.visible === false || renderedAlpha === false || (renderedAlpha === undefined && (!containsWorldPoint(mask, point) || !maskPaintHasAlphaAtWorldPoint(mask, point)))) return false;
    }
    const parentId = current.parentId;
    if (!parentId || parentId === stopParentId) return true;
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
  activeNodesCache = undefined;
  activeNodeOrderByIdCache = undefined;
  activePageRenderFactsCache = undefined;
  gpuBackendPlanCache = undefined;
  const projected = worldSpaceProjectionNodes(nodes);
  nodeById = new Map(projected.map((node) => [node.id, node]));
  nodeBoundsById = new Map(projected.map((node) => [node.id, boundsForNode(node)]));
  repeatSourceIdsByGroupId = new Map();
  const visibleCanonical = visibleNodesOnPage(nodes, activePageId, defaultPageId);
  const visibleProjected = visibleCanonical.map((node) => nodeById.get(node.id) ?? node);
  const canonicalNodeById = new Map(visibleCanonical.map((node) => [node.id, node]));
  const visibleChildrenByParentId = indexTransformGroupRepeatChildren(visibleProjected);
  visibleCanonical.filter((node) => node.kind === "transformGroup").forEach((group) => {
    const subtree = transformGroupRepeatSubtree(visibleProjected, group, visibleChildrenByParentId);
    if (!subtree) return;
    const sourceBounds = nodeBoundsById.get(group.id) ?? boundsForNode(nodeById.get(group.id) ?? group);
    const repeatBounds = transformGroupRepeatWorldBounds(nodes, group, {
      subtree,
      sourceBounds: {
        left: sourceBounds.x,
        top: sourceBounds.y,
        right: sourceBounds.x + sourceBounds.width,
        bottom: sourceBounds.y + sourceBounds.height,
      },
      groupWorld: worldTransformById.get(group.id),
      worldTransformByNodeId: worldTransformById,
      canonicalNodeById,
      paintNodes: visibleProjected,
      childrenByParentId: visibleChildrenByParentId,
    });
    if (!repeatBounds) return;
    repeatSourceIdsByGroupId.set(group.id, subtree.nodes.map((source) => source.id));
    nodeBoundsById.set(group.id, {
      x: repeatBounds.left,
      y: repeatBounds.top,
      width: repeatBounds.right - repeatBounds.left,
      height: repeatBounds.bottom - repeatBounds.top,
    });
  });
  spatialGrid = createSpatialGridIndex(visibleProjected, (node) => nodeBoundsById.get(node.id) ?? boundsForNode(node));
  rebuildCompiledScene();
  // The compiled Scene is now the ordering authority for the next lazy read.
  activeNodesCache = undefined;
  activeNodeOrderByIdCache = undefined;
  activePageRenderFactsCache = undefined;
}
function rebuildCompiledScene() {
  renderedMaskAlphaHits.clear();
  renderedMaskAlphaHitBytes = 0;
  compiledScenePreviousScene = compiledScene?.scene;
  compiledScene = compileScene({ revision, nodes, pageId: activePageId, defaultPageId, resourceGeneration: sceneResourceGeneration, previousScene: compiledScenePreviousScene });
  compiledClipGeometryByNodeId = sceneClipGeometryByNodeId(compiledScene.scene);
  compiledMaskSourceByNodeId = sceneMaskSourceByNodeId(compiledScene.scene);
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
  emit({ type: "snapshot", snapshot: { documentId, revision, documentHash, memory, resources: { documentNodes: memory?.nodeCount ?? nodes.length, maxDocumentNodes: 100_000, documentBytes: memory?.nodeBytes ?? 0, maxDocumentBytes: memory?.maxDocumentBytes ?? 256 * 1024 * 1024, wasmHeapBytes: wasmHeap.bytes, maxWasmHeapBytes: MAX_WASM_HEAP_BYTES, renderSurfaceBytes, maxRenderSurfaceBytes: MAX_RENDER_SURFACE_BYTES, gpuSceneBytes, maxGpuSceneBytes: MAX_GPU_SCENE_RESOURCE_BYTES, gpuEffectTextureBytes, maxGpuEffectTextureBytes: MAX_GPU_EFFECT_TEXTURE_BYTES, gpuSceneWithinBudget }, benchmark: benchmarkEvidence, diagnostics: diagnostics.summary(), performance: renderPerformance.summary(), nodes, assets, fontAvailability, pages, activePageId, selectedIds, viewport, canUndo: undoOrder.length > 0, canRedo: redoOrder.length > 0, renderer: gpuRenderer && gpuSceneWithinBudget ? "WebGPU + Canvas 2D overlay" : "Canvas 2D", gpu: { webgpu: gpuStatus, webgl2Available, recoveryAttempts: gpuRecoveryAttempts, ...(simulatedGpuLossesRequested ? { developmentSimulation: { requestedLosses: simulatedGpuLossesRequested, completedLosses: simulatedGpuLosses } } : {}) }, documentCore, localSnapshot, localJournalEntry } });
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
    engineSemanticsVersion: ENGINE_SEMANTICS_VERSION,
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
    wasmDocument.register_asset(transactionId, wasmDocument.revision, asset.assetId, asset.contentHash, asset.mediaType, BigInt(asset.byteLength), asset.pixelWidth ?? 0, asset.pixelHeight ?? 0, JSON.stringify(asset.fontFaces ?? []));
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
  // Large pages use the same dynamic-quality contract as ordinary pages:
  // interaction may lower the backing scale, while the settled frame restores
  // the device DPR for exact presentation and pixel evidence.
  const nextDpr = qualityDpr;
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
    presentedRevision = undefined;
    presentedSurfaceWidth = 0;
    presentedSurfaceHeight = 0;
    presentedViewport = undefined;
    presentedScene = undefined;
    effectSurfaces = undefined;
    alphaMaskSurfaces = [];
    subtreeCompositeSurfaces = [];
    canvasFallbackSurface = undefined;
    alphaMaskLimitReported = false;
    effectSurfaceLimitReported = false;
    subtreeCompositeLimitReported = false;
    compositeSurfaceLimitReported = false;
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
  const sceneKey = currentScenePresentationKey();
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

/** Flat large pages do not enter the progressive structural painter, so they
 * need their own presentation copy for camera-only interaction. */
function cacheCurrentPresentedFrameForInteraction() {
  if (renderQuality.tier !== "settled" || nodes.length < COMPLEX_DOCUMENT_NODE_THRESHOLD || !canvas) return;
  if (canvas.width * canvas.height * 4 > MAX_INTERACTION_CACHE_SURFACE_BYTES) return;
  // The overview metadata must continue to describe immutable pixels. When a
  // newer detail frame is more zoomed in, allocate a separate current-frame
  // surface instead of overwriting the canvas retained as the widest view.
  if (!interactionCacheSurface
    || interactionCacheSurface.width !== canvas.width
    || interactionCacheSurface.height !== canvas.height
    || (cachedOverviewFrame?.canvas === interactionCacheSurface
      && viewport.zoom > cachedOverviewFrame.viewport.zoom)) {
    interactionCacheSurface = new OffscreenCanvas(canvas.width, canvas.height);
  }
  const cacheContext = interactionCacheSurface.getContext("2d");
  if (!cacheContext) return;
  cacheContext.save();
  cacheContext.setTransform(1, 0, 0, 1, 0, 0);
  cacheContext.globalAlpha = 1;
  cacheContext.globalCompositeOperation = "copy";
  cacheContext.drawImage(canvas, 0, 0);
  cacheContext.restore();
  cachePresentedFrame(interactionCacheSurface, viewport, width, height);
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
    cachedPresentedFrameSceneKey !== currentScenePresentationKey()
  ) return false;
  const frames = [{
    canvas: cachedPresentedFrame,
    viewport: cachedPresentedFrameViewport,
    width: cachedPresentedFrameSurfaceWidth,
    height: cachedPresentedFrameSurfaceHeight,
  }];
  if (cachedOverviewFrame?.sceneKey === cachedPresentedFrameSceneKey) frames.push(cachedOverviewFrame);
  const projection = selectViewportFrameForInteraction(
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
  presentedRevision = revision;
  presentedSurfaceWidth = canvas.width;
  presentedSurfaceHeight = canvas.height;
  return true;
}
function currentScenePresentationKey() {
  return scenePresentationKey({ revision, pageId: activePageId, transientSceneVersion, resourceGeneration: sceneResourceGeneration });
}

function markPresentedScene() {
  presentedPageId = activePageId;
  presentedRevision = revision;
  presentedSurfaceWidth = canvas?.width ?? 0;
  presentedSurfaceHeight = canvas?.height ?? 0;
  presentedViewport = { ...viewport };
  presentedScene = compiledScene?.scene;
}

function emitFrameHashEvidence() {
  if (!captureFrameHash || !canvas || !context) return;
  const evidenceCanvas = canvas;
  const evidenceContext = context;
  const evidenceSceneFingerprint = compiledScene
    ? compactEvidenceFingerprint(JSON.stringify([
        compiledScene.scene.dependencyFingerprint,
        compiledScene.scene.semanticNodes.map((node) => [
          node.nodeId,
          node.presentationFingerprint,
          node.visible,
          node.paintable,
          node.worldBounds,
          node.effectBounds,
          node.clipBounds,
          node.maskNodeIds,
        ]),
      ]))
    : "scene-unavailable";
  const sceneKey = JSON.stringify([
    currentScenePresentationKey(),
    evidenceSceneFingerprint,
    viewport.x,
    viewport.y,
    viewport.zoom,
    evidenceCanvas.width,
    evidenceCanvas.height,
    renderQuality.tier,
  ]);
  if (sceneKey === capturedFrameHashKey) return;
  capturedFrameHashKey = sceneKey;
  try {
    const rgba = evidenceContext.getImageData(0, 0, evidenceCanvas.width, evidenceCanvas.height).data;
    const pixels = new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    const capturedRevision = revision;
    const capturedPageId = activePageId;
    const capturedWidth = evidenceCanvas.width;
    const capturedHeight = evidenceCanvas.height;
    const samples = captureFrameSamples.flatMap((sample) => {
      const screen = toScreen(sample.x, sample.y);
      const x = Math.floor(screen.x * dpr);
      const y = Math.floor(screen.y * dpr);
      if (x < 0 || y < 0 || x >= evidenceCanvas.width || y >= evidenceCanvas.height) return [];
      const offset = (y * evidenceCanvas.width + x) * 4;
      return [{
        ...sample,
        rgba: [rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!, rgba[offset + 3]!] as const,
      }];
    });
    void sha256Bytes(pixels)
      .then((digest) => emit({
        type: "frame-hash",
        revision: capturedRevision,
        pageId: capturedPageId,
        width: capturedWidth,
        height: capturedHeight,
        rgbaSha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
        sceneKey,
        ...(samples.length ? { samples } : {}),
      }))
      .catch(() => {
        if (capturedFrameHashKey === sceneKey) capturedFrameHashKey = "";
        diagnostics.record({ category: "renderer", code: "FRAME_HASH_UNAVAILABLE", documentRevision: capturedRevision });
      });
  } catch {
    diagnostics.record({ category: "renderer", code: "FRAME_HASH_UNAVAILABLE", documentRevision: revision });
  }
}

/** Fixed-length, non-cryptographic cache identity. The cryptographic evidence
 * remains the RGBA SHA-256; this value only prevents a different frozen Scene
 * at the same canonical revision from suppressing capture. */
function compactEvidenceFingerprint(value: string) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
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
    affineGpuTextStatsSignature = "";
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
    affineGpuTextStatsSignature = "";
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
  const activeAssetIds = new Set(assets.map((asset) => asset.assetId));
  for (const [assetId, blob] of runtimeFontBlobs) {
    if (activeAssetIds.has(assetId)) continue;
    runtimeFontBlobs.delete(assetId);
    runtimeFontBytes -= blob.size;
  }
  if (!pages.some((page) => page.id === activePageId)) activePageId = pages[0]?.id ?? defaultPageId;
  nodes = snapshot.nodes.map((node) => {
    const previous = preservedProjectionNodes.get(node.id);
    const projected = canvasNodeFromProjection(node);
    if (snapshot.schemaVersion < 3) projected.text = previous?.text;
    preservedProjectionNodes.set(projected.id, presentationNode(projected));
    return projected;
  });
  revision = snapshot.revision;
  setRenderSurface(width, height, deviceDpr);
  selectedIds = normalizePageSelection(nodes, activePageId, selectedIds, defaultPageId);
  rebuildNodeIndex();
  refreshRustGpuScene();
  new Set(nodes.flatMap(nodeImagePaintAssetIds)).forEach((assetId) => void ensureImageBitmap(assetId));
  nodes.filter((node) => node.textProperties).forEach((node) => {
    const properties = node.textProperties;
    if (!properties) return;
    const fontIds = [
      ...properties.runs.flatMap((run) => run.font ? [run.font.assetId] : []),
      ...(properties.baseStyle?.font ? [properties.baseStyle.font.assetId] : []),
      ...(properties.fallbackFonts ?? []).map((font) => font.assetId),
    ];
    new Set(fontIds).forEach((assetId) => void ensureFontFace(assetId));
  });
  refreshRustTextLayouts();
  refreshRustTextGlyphs();
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

/** Derives one source-addressed layout from contiguous explicit font/size runs.
 * PIXELS tracking participates in Rust line fitting and caret geometry;
 * synthetic weight/italic retain authored advances and travel with the raster
 * identity, while small caps remain on the documented Canvas transition. */
function rustTextLayoutRequest(node: CanvasNode) {
  if ((node.textProperties?.paragraph.paragraphIndent ?? 0) !== 0
      || node.textProperties?.paragraphStyleRuns?.some((run) => (run.paragraphIndent ?? 0) !== 0)) return undefined;
  if (node.textProperties?.paragraphStyleRuns?.some((run) =>
    run.lineHeight !== undefined || run.lineHeightUnit !== undefined)) return undefined;
  if (node.textProperties?.paragraph.textWrapStyle
      || node.textProperties?.paragraphStyleRuns?.some((run) => run.textWrapStyle !== undefined)) return undefined;
  if (node.textProperties?.paragraph.hangingPunctuation) return undefined;
  if (node.textProperties?.paragraph.listType
    || node.textProperties?.paragraphStyleRuns?.some((run) => run.listType && run.listType !== "none")) return undefined;
  if (node.textProperties?.runs.some((run) => run.leadingTrim !== undefined)
    || node.textProperties?.baseStyle?.leadingTrim !== undefined) return undefined;
  const plan = textFrozenLayoutPlan(node);
  if (!plan) return undefined;
  const key = JSON.stringify([
    node.id,
    plan.source,
    plan.shapingSource,
    node.width,
    plan.runs.map((run) => [run.start, run.end, run.font.assetId, run.font.faceIndex, run.axes, run.fontSize, run.fontWeight, run.italic, run.letterSpacing]),
  ]);
  return {
    key,
    plan,
    fontSize: plan.fontSize,
    widthPx: node.kind === "textPath" ? TEXT_PATH_SINGLE_LINE_WIDTH : node.width,
  };
}

function refreshRustTextLayouts() {
  const active = new Set<string>();
  nodes.filter((node) => node.kind === "text" || node.kind === "textPath").forEach((node) => {
    const request = rustTextLayoutRequest(node);
    if (!request) return;
    active.add(node.id);
    const cached = rustTextLayouts.get(node.id);
    if (cached?.key === request.key) {
      cached.revision = revision;
      return;
    }
    const fallback = rustTextLayoutFallbacks.get(node.id);
    if (fallback?.key === request.key) {
      fallback.revision = revision;
      return;
    }
    if (rustTextLayoutLoads.has(request.key)) return;
    if (request.plan.runs.some((run) => fontFaces.statusFor(run.font.assetId) !== "ready")) return;
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
    const layout = await deriveRustTextLayout(request);
    const currentNode = nodes.find((node) => node.id === nodeId);
    if (!currentNode || rustTextLayoutRequest(currentNode)?.key !== request.key) return;
    if (hasMissingRustTextGlyph(layout)) {
      rustTextLayoutFallbacks.set(nodeId, { revision, key: request.key });
      if (captureFrameHash) diagnostics.record({ category: "renderer", code: "RUST_TEXT_LAYOUT_MISSING_GLYPH", documentRevision: revision });
      emitSnapshot(undefined, false);
      return;
    }
    rustTextLayoutFallbacks.delete(nodeId);
    rustTextLayouts.set(nodeId, { revision, key: request.key, layout });
    sceneResourceGeneration += 1;
    refreshRustTextGlyphs();
    render();
  } catch (error) {
    diagnostics.record({
      category: "renderer",
      code: "RUST_TEXT_LAYOUT_UNAVAILABLE",
      documentRevision: revision,
      details: captureFrameHash ? { errorCode: error instanceof Error ? error.message : String(error) } : undefined,
    });
    emitSnapshot(undefined, false);
  } finally {
    rustTextLayoutLoads.delete(request.key);
  }
}

async function deriveRustTextLayout(
  request: NonNullable<ReturnType<typeof rustTextLayoutRequest>>,
) {
  const fontBytes = new Map<string, ArrayBuffer>();
  for (const assetId of new Set(request.plan.runs.map((run) => run.font.assetId))) {
    const asset = assets.find((candidate) => candidate.assetId === assetId);
    if (!asset) throw new Error("FONT_ASSET_MISSING");
    const blob = await loadAssetBlob(asset);
    if (!blob) throw new Error("FONT_ASSET_UNAVAILABLE");
    fontBytes.set(assetId, await blob.arrayBuffer());
  }
  const input = textLayoutInputFromPlan(request.plan, fontBytes);
  if (!input) throw new Error("INVALID_RUST_TEXT_STYLE_RUNS");
  const wasm = await loadWasmRuntime();
  const payload = wasm.layout_shaped_text_runs_json(
    new Uint8Array(input.fontBundle),
    input.runsJson,
    input.shapingSource,
    request.widthPx,
  );
  const displayLayout = parseRustTextLayout(payload, input.shapingSource);
  const sourceLayout = displayLayout && remapRustTextLayoutToSource(displayLayout, input.projection);
  if (!sourceLayout) throw new Error("INVALID_RUST_TEXT_LAYOUT");
  return sourceLayout;
}

/** Returns the Core-owned set of legal UTF-8 caret stops for a live DOM edit.
 * This never changes the Document: it only prevents browser UTF-16 selections
 * from splitting graphemes before a later atomic text transaction commits. */
async function emitRustTextCaretLayout(request: Extract<MainToWorker, { type: "text-caret-layout" }>) {
  try {
    const wasm = await loadWasmRuntime();
    const node = nodes.find((candidate) => candidate.id === request.nodeId && candidate.kind === "text");
    let shaped = node && (node.text ?? "") === request.text ? rustTextLayoutFor(node) : undefined;
    if (!shaped && node && (node.text ?? "") === request.text) {
      const shapedRequest = rustTextLayoutRequest(node);
      if (shapedRequest) {
        const candidate = await deriveRustTextLayout(shapedRequest);
        if (!hasMissingRustTextGlyph(candidate)) shaped = candidate;
      }
    }
    const positionedCaretComplete = shaped?.carets && shaped.lines.every((line, lineIndex) => {
      if (!line.visualCarets?.length) return false;
      const logical = new Set(shaped.carets!
        .filter((caret) => caret.lineIndex === lineIndex)
        .map((caret) => caret.byteOffset));
      const positioned = new Set(line.visualCarets.map((caret) => caret.byteOffset));
      return logical.size === positioned.size && [...logical].every((offset) => positioned.has(offset));
    });
    const payload = shaped && positionedCaretComplete
      ? {
          unitsPerEm: shaped.unitsPerEm,
          lines: shaped.lines.map((line) => ({
            start: line.start,
            end: line.end,
            direction: line.direction,
            advance: line.advance,
            visualRuns: line.visualRuns,
            visualCarets: line.visualCarets,
          })),
          carets: shaped.carets!,
        }
      : JSON.parse(wasm.fallback_text_layout_json(
          request.text,
          Math.max(1, Math.min(65_535, Array.from(request.text).length)),
        ));
    const layout = parseRustTextCaretLayout(payload);
    if (!layout) throw new Error("INVALID_RUST_TEXT_CARET_LAYOUT");
    emit({ type: "text-caret-layout", requestId: request.requestId, nodeId: request.nodeId, text: request.text, layout });
  } catch {
    diagnostics.record({ category: "renderer", code: "RUST_TEXT_CARET_UNAVAILABLE", documentRevision: revision });
    emit({ type: "text-caret-layout", requestId: request.requestId, nodeId: request.nodeId, text: request.text });
  }
}

/** Converts an already-validated multi-run horizontal layout into ephemeral GPU glyph
 * draws. Each Rust glyph selects its run's immutable font raster resource.
 * Rust has already included PIXELS tracking in glyph advances; paint changes
 * remain on Canvas until the GPU pass preserves those semantics. */
function rustTextGlyphRequest(node: CanvasNode) {
  const layoutRequest = rustTextLayoutRequest(node);
  const layout = rustTextLayoutFor(node);
  if (!layoutRequest || !layout || !layout.lines.length) return undefined;
  const properties = node.textProperties;
  // Ordinary Text still needs a full box-transform projection. TextPath owns
  // a complete local-glyph → world affine in its WebGPU instance.
  if ((node.kind !== "textPath" && node.rotation !== 0)
    || node.fillStack !== undefined
    || Boolean(node.fillGradient)
    || Boolean(node.fills?.length)
    || properties?.runs.some((candidate) => candidate.fillStack !== undefined || candidate.textDecoration !== undefined || candidate.leadingTrim !== undefined)) return undefined;
  if (node.kind === "text" && (
    properties?.paragraph.alignment !== "left"
    || (properties?.paragraph.paragraphSpacing ?? 0) !== 0
    || properties?.paragraphStyleRuns?.some((run) => (run.paragraphSpacing ?? 0) !== 0)
    || properties?.runs.some((candidate) => candidate.color)
  )) return undefined;
  if (node.kind === "textPath" && layout.lines.length !== 1) return undefined;
  if (layout.lines.reduce((total, line) => total + line.glyphs.length, 0) > MAX_RUST_TEXT_GLYPHS_PER_NODE) return undefined;
  const gpuRuns = layoutRequest.plan.runs.map((run, index) => ({
    font: run.font,
    axesKey: run.axes,
    syntheticStyleKey: `${run.fontWeight}:${run.italic ? "italic" : "normal"}`,
    fontSize: run.fontSize,
    fontWeight: run.fontWeight,
    italic: run.italic,
    pixelSize: Math.min(512, Math.max(8, Math.ceil(run.fontSize))),
    fill: properties?.runs[index]?.color ? colorToSrgbCss(properties.runs[index]!.color!) : node.fill,
    opacity: 1,
  }));
  if (layout.lines.some((line) => line.glyphs.some((glyph) => !gpuRuns[glyph.runIndex]))) return undefined;
  const textPathWorldTransform = node.kind === "textPath" ? worldTransformById.get(node.id) : undefined;
  if (node.kind === "textPath" && !textPathWorldTransform) return undefined;
  const key = JSON.stringify([
    layoutRequest.key,
    gpuRuns.map((run) => [run.font.assetId, run.font.faceIndex, run.axesKey, run.syntheticStyleKey, run.fontSize, run.pixelSize]),
    node.kind === "textPath" ? textPathWorldTransform : [node.x, node.y, node.rotation],
    node.fill,
    node.opacity,
    node.textProperties?.paragraph.lineHeight,
    node.textProperties?.paragraph.lineHeightUnit,
    node.textProperties?.paragraph.paragraphSpacing,
    node.vectorPath,
    node.textPathMetadata,
    gpuRuns.map((run) => run.fill),
  ]);
  return {
    ...layoutRequest,
    node,
    gpuRuns,
    key,
    layout,
    nodeX: node.x,
    nodeY: node.y,
    nodeWidth: node.width,
    nodeRotation: node.rotation,
    nodeFill: node.fill,
    nodeOpacity: node.opacity,
    nodeLineHeight: resolvedTextLineHeight(node.textProperties, node.kind === "shapeWithText" ? 14 : 31),
    textPathWorldTransform,
  };
}

function refreshRustTextGlyphs() {
  const active = new Set<string>();
  // TextPath projection owns its node transform explicitly: Canvas consumes
  // node-local glyphs under the full affine and WebGPU receives a full world
  // projection. Feeding it `activeNodes()` would substitute the Scene's AABB
  // compatibility projection for a rotated node, so the async completion key
  // could never match the current Canonical node. Ordinary Text retains its
  // existing world-space compatibility projection.
  visibleNodesOnPage(nodes, activePageId, defaultPageId)
    .filter((node) => (node.kind === "text" || node.kind === "textPath") && node.visible !== false)
    .forEach((node) => {
    const projectionNode = node.kind === "textPath" ? node : (nodeById.get(node.id) ?? node);
    const request = rustTextGlyphRequest(projectionNode);
    if (!request) return;
    active.add(node.id);
    const cached = rustTextGlyphs.get(node.id);
    if (cached?.key === request.key) {
      cached.revision = revision;
      return;
    }
    if (rustTextGlyphLoads.has(request.key)) return;
    rustTextGlyphLoads.add(request.key);
    void loadRustTextGlyphs(node.id, request);
  });
  [...rustTextGlyphs].forEach(([nodeId, cached]) => {
    if (!active.has(nodeId) || cached.revision !== revision) rustTextGlyphs.delete(nodeId);
  });
}

async function loadRustTextGlyphs(
  nodeId: string,
  request: NonNullable<ReturnType<typeof rustTextGlyphRequest>>,
) {
  try {
    const wasm = await loadWasmRuntime();
    const bytesByAssetId = new Map<string, Uint8Array>();
    for (const run of request.gpuRuns) {
      if (bytesByAssetId.has(run.font.assetId)) continue;
      const asset = assets.find((candidate) => candidate.assetId === run.font.assetId);
      if (!asset) throw new Error("FONT_ASSET_MISSING");
      const blob = await loadAssetBlob(asset);
      if (!blob) throw new Error("FONT_ASSET_UNAVAILABLE");
      bytesByAssetId.set(run.font.assetId, new Uint8Array(await blob.arrayBuffer()));
    }
    const rasterRuns = request.gpuRuns.map((run) => ({
      fontAssetId: run.font.assetId,
      faceIndex: run.font.faceIndex,
      variationAxesKey: run.axesKey,
      syntheticStyleKey: run.syntheticStyleKey,
      fontSize: run.fontSize,
      pixelSize: run.pixelSize,
      rasters: new Map<number, NonNullable<ReturnType<typeof parseRustGlyphRaster>>>(),
    }));
    for (const line of request.layout.lines) {
      for (const glyph of line.glyphs) {
        if (glyph.glyphId === 0) throw new Error("MISSING_GLYPH_OUTLINE");
        const run = request.gpuRuns[glyph.runIndex];
        const rasterRun = rasterRuns[glyph.runIndex];
        if (!run || !rasterRun) throw new Error("INVALID_GLYPH_RUN_INDEX");
        if (rasterRun.rasters.has(glyph.glyphId)) continue;
        const fontBytes = bytesByAssetId.get(run.font.assetId);
        if (!fontBytes) throw new Error("FONT_ASSET_UNAVAILABLE");
        const raster = parseRustGlyphRaster(wasm.rasterize_glyph_with_style_json(
          fontBytes,
          run.font.faceIndex,
          run.axesKey,
          run.fontWeight,
          run.italic,
          glyph.glyphId,
          run.pixelSize,
        ));
        if (!raster) throw new Error("INVALID_GLYPH_RASTER");
        rasterRun.rasters.set(glyph.glyphId, raster);
      }
    }
    const projectionRuns = rasterRuns.map((run, index) => ({
      ...run,
      fill: request.gpuRuns[index]!.fill,
      opacity: request.gpuRuns[index]!.opacity,
    }));
    const canvasGlyphs = request.node.kind === "textPath"
      ? projectTextPathLocalGlyphs({ node: request.node, runs: projectionRuns, layout: request.layout })
      : undefined;
    const glyphs = request.node.kind === "textPath"
      ? projectTextPathGpuGlyphs({ node: request.node, runs: projectionRuns, layout: request.layout, worldTransform: request.textPathWorldTransform })
      : projectGpuTextGlyphs({
          nodeId,
          runs: projectionRuns,
          x: request.nodeX,
          y: request.nodeY,
          width: request.nodeWidth,
          rotation: request.nodeRotation,
          fill: request.nodeFill,
          opacity: request.nodeOpacity,
          lineHeight: request.nodeLineHeight ?? DEFAULT_TEXT_LINE_HEIGHT,
          layout: request.layout,
        });
    if (!glyphs || (request.node.kind === "textPath" && !canvasGlyphs)) throw new Error("INVALID_GPU_TEXT_PROJECTION");
    const currentNode = nodes.find((node) => node.id === nodeId);
    const currentProjectionNode = currentNode?.kind === "textPath"
      ? currentNode
      : currentNode ? (nodeById.get(nodeId) ?? currentNode) : undefined;
    const currentRequest = currentProjectionNode ? rustTextGlyphRequest(currentProjectionNode) : undefined;
    if (!currentNode || currentRequest?.key !== request.key) return;
    rustTextGlyphs.set(nodeId, { revision, key: request.key, glyphs, ...(canvasGlyphs ? { canvasGlyphs } : {}) });
    // Full-frame evidence runs expose the asynchronous resource fence so a
    // browser gate can distinguish the final GPU frame from the short Canvas
    // fallback shown while a newly created Text/TextPath raster is loading.
    if (captureFrameHash) diagnostics.record({ category: "renderer", code: "RUST_TEXT_GLYPH_RESOURCE_READY", documentRevision: revision, details: { entries: canvasGlyphs?.length ?? glyphs.length } });
    sceneResourceGeneration += 1;
    render();
    if (captureFrameHash) emitSnapshot(undefined, false);
  } catch (error) {
    diagnostics.record({
      category: "renderer",
      code: "RUST_TEXT_GLYPH_RASTER_UNAVAILABLE",
      documentRevision: revision,
      details: captureFrameHash ? { errorCode: error instanceof Error ? error.message : String(error) } : undefined,
    });
    emitSnapshot(undefined, false);
  } finally {
    rustTextGlyphLoads.delete(request.key);
  }
}

function rustTextLayoutFor(node: CanvasNode): RustTextLayout | undefined {
  const cached = rustTextLayouts.get(node.id);
  return cached?.revision === revision ? cached.layout : undefined;
}

function nodeImagePaintAssetIds(node: CanvasNode): string[] {
  return [
    ...(node.assetId ? [node.assetId] : []),
    ...(node.fillStack?.layers.flatMap((layer) => layer.image ? [layer.image.assetId] : []) ?? []),
    ...(node.strokeStack?.layers.flatMap((layer) => layer.image ? [layer.image.assetId] : []) ?? []),
    ...(node.textProperties?.runs.flatMap((run) => run.fillStack?.layers.flatMap((layer) => layer.image ? [layer.image.assetId] : []) ?? []) ?? []),
    ...(node.textProperties?.baseStyle?.fillStack?.layers.flatMap((layer) => layer.image ? [layer.image.assetId] : []) ?? []),
  ];
}

function imageDecodeBudget(assetId: string) {
  const visibleAssetIds = new Set(activeNodes()
    .filter((node) => node.visible !== false)
    .flatMap(nodeImagePaintAssetIds));
  // Dividing the global cache budget ensures every simultaneously visible
  // background can stay resident instead of repeatedly evicting one another.
  const assetCount = Math.max(1, visibleAssetIds.has(assetId) ? visibleAssetIds.size : 1);
  return Math.max(4, Math.floor(MAX_RASTER_DECODED_BYTES / assetCount));
}

function cacheImageBitmap(assetId: string, attempt: number, bitmap: ImageBitmap) {
  if (!imageDecodeLoads.isCurrent(assetId, attempt)) {
    bitmap.close();
    return;
  }
  if (!imageBitmaps.set(assetId, bitmap, bitmap.width * bitmap.height * 4)) return;
  for (const [key, cached] of filteredImageSurfaces) {
    if (!key.startsWith(`${assetId}|`)) continue;
    filteredImageSurfaces.delete(key);
    filteredImageSurfaceBytes -= cached.bytes;
  }
  sceneResourceGeneration += 1;
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
  const attempt = imageDecodeLoads.begin(assetId);
  try {
    const asset = assets.find((candidate) => candidate.assetId === assetId);
    if (!asset) return;
    const blob = await loadAssetBlob(asset);
    if (!blob) return;
    cacheImageBitmap(assetId, attempt, await decodeImageBitmap(asset, blob));
  } catch {
    // Rendering keeps the documented placeholder; network failure never changes Core.
  } finally { imageLoads.delete(assetId); }
}

async function loadAssetBlob(asset: DocumentAsset): Promise<Blob | undefined> {
  const runtimeFont = runtimeFontBlobFor(asset);
  if (runtimeFont) return runtimeFont;
  let cached: Blob | undefined;
  if (asset.mediaType.startsWith("font/")) {
    const runtimeDelivery = waitForRuntimeFontBlob(asset);
    cached = await firstAvailableResource(readCachedAsset(asset), runtimeDelivery);
  } else cached = await readCachedAsset(asset);
  if (cached) return cached;
  const lateRuntimeFont = runtimeFontBlobFor(asset);
  if (lateRuntimeFont) return lateRuntimeFont;
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

function runtimeFontBlobFor(asset: DocumentAsset): Blob | undefined {
  const runtimeFont = runtimeFontBlobs.get(asset.assetId);
  if (runtimeFont && asset.mediaType.startsWith("font/") && runtimeFont.type === asset.mediaType && runtimeFont.size === asset.byteLength) {
    runtimeFontBlobs.delete(asset.assetId);
    runtimeFontBlobs.set(asset.assetId, runtimeFont);
    return runtimeFont;
  }
  return undefined;
}

function waitForRuntimeFontBlob(asset: DocumentAsset): Promise<Blob | undefined> {
  return new Promise((resolve) => {
    const waiters = runtimeFontBlobWaiters.get(asset.assetId) ?? new Set();
    let timer = 0;
    const finish = (blob: Blob | undefined) => {
      clearTimeout(timer);
      waiters.delete(finish);
      if (!waiters.size) runtimeFontBlobWaiters.delete(asset.assetId);
      resolve(blob && blob.type === asset.mediaType && blob.size === asset.byteLength ? blob : undefined);
    };
    waiters.add(finish);
    runtimeFontBlobWaiters.set(asset.assetId, waiters);
    timer = setTimeout(() => finish(undefined), RUNTIME_FONT_WAIT_MS) as unknown as number;
  });
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
  const source = await blob.arrayBuffer();
  retainRuntimeFontBlob(asset.assetId, asset.mediaType, new Blob([source], { type: asset.mediaType }));
  const family = await fontFaces.load(assetId, source, fontScope.fonts, create);
  if (family) { sceneResourceGeneration += 1; refreshRustTextLayouts(); render(); }
  else diagnostics.record({ category: "renderer", code: "FONT_FACE_UNAVAILABLE", details: { assetId } });
  emitSnapshot(undefined, false);
}

function seedAssetBytes(assetId: string, mediaType: string, bytes: ArrayBuffer, decodedBitmap?: ImageBitmap) {
  const blob = new Blob([bytes], { type: mediaType });
  const asset = assets.find((candidate) => candidate.assetId === assetId);
  if (mediaType.startsWith("font/")) {
    retainRuntimeFontBlob(assetId, mediaType, blob);
    void ensureFontFaceFromBlob(assetId, blob, asset);
  } else {
    const attempt = imageDecodeLoads.begin(assetId);
    const imageAsset = asset;
    if (!imageAsset) {
      decodedBitmap?.close();
      return;
    }
    if (decodedBitmap) {
      if (imageDecodeLoads.isCurrent(assetId, attempt)) void cacheAsset(imageAsset, blob);
      cacheImageBitmap(assetId, attempt, decodedBitmap);
      return;
    }
    void decodeImageBitmap(imageAsset, blob)
      .then((bitmap) => {
        if (!imageDecodeLoads.isCurrent(assetId, attempt)) {
          bitmap.close();
          return;
        }
        void cacheAsset(imageAsset, blob);
        cacheImageBitmap(assetId, attempt, bitmap);
      })
      .catch(() => {
        if (!imageDecodeLoads.isCurrent(assetId, attempt)) return;
        diagnostics.record({ category: "renderer", code: "IMAGE_ASSET_DECODE_FAILED", details: { assetId } });
        emitSnapshot(undefined, false);
      });
  }
}

function retainRuntimeFontBlob(assetId: string, mediaType: string, blob: Blob) {
  if (!mediaType.startsWith("font/") || mediaType !== blob.type || blob.size <= 0 || blob.size > MAX_RUNTIME_FONT_BYTES) return;
  const previous = runtimeFontBlobs.get(assetId);
  if (previous) runtimeFontBytes -= previous.size;
  runtimeFontBlobs.delete(assetId);
  while (runtimeFontBytes + blob.size > MAX_RUNTIME_FONT_BYTES && runtimeFontBlobs.size) {
    const oldest = runtimeFontBlobs.entries().next().value as [string, Blob] | undefined;
    if (!oldest) break;
    runtimeFontBlobs.delete(oldest[0]);
    runtimeFontBytes -= oldest[1].size;
  }
  runtimeFontBlobs.set(assetId, blob);
  runtimeFontBytes += blob.size;
  runtimeFontBlobWaiters.get(assetId)?.forEach((resolve) => resolve(blob));
}

async function ensureFontFaceFromBlob(assetId: string, blob: Blob, asset?: DocumentAsset) {
  const fontScope = self as unknown as { fonts?: { add(face: { load(): Promise<unknown> }): void } };
  const create = typeof FontFace === "function"
    ? (family: string, source: ArrayBuffer) => new FontFace(family, source)
    : undefined;
  const family = await fontFaces.load(assetId, await blob.arrayBuffer(), fontScope.fonts, create);
  if (family) {
    if (asset) void cacheAsset(asset, blob);
    sceneResourceGeneration += 1;
    refreshRustTextLayouts();
    render();
  }
  else diagnostics.record({ category: "renderer", code: "FONT_FACE_UNAVAILABLE", details: { assetId } });
  emitSnapshot(undefined, false);
}
function registerAsset(transactionId: string, asset: DocumentAsset) {
  if (!wasmDocument) { emitError(undefined, "TRANSIENT", transactionId); return; }
  const baseRevision = Number(wasmDocument.revision);
  try {
    wasmDocument.register_asset(transactionId, wasmDocument.revision, asset.assetId, asset.contentHash, asset.mediaType, BigInt(asset.byteLength), asset.pixelWidth ?? 0, asset.pixelHeight ?? 0, JSON.stringify(asset.fontFaces ?? []));
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

function cancelFigmaRestAssets(input: Extract<MainToWorker, { type: "cancel-figma-rest-assets" }>) {
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
  const resolved = cancelFigmaRestAssetBindings(nodes, input.pending);
  if (resolved.issues.some((issue) => issue.outcome === "rejected")) {
    diagnostics.record({ category: "transaction", code: "FIGMA_REST_ASSET_CANCELLATION_REJECTED", documentRevision: revision, transactionId: input.transactionId, details: { issueCount: resolved.issues.length } });
    emitError(undefined, "INVALID_COMMAND", input.transactionId);
    emit({ type: "ack", transactionId: input.transactionId, errorCode: "INVALID_TRANSACTION" });
    return;
  }
  if (!resolved.batch.length) {
    emit({ type: "ack", transactionId: input.transactionId, acceptedRevision: revision });
    return;
  }
  try {
    const baseRevision = Number(wasmDocument.revision);
    wasmDocument.apply_transaction_json(input.transactionId, wasmDocument.revision, JSON.stringify(resolved.batch));
    recordHistory("core");
    syncProjectionFromWasm(false);
    render();
    diagnostics.record({ category: "transaction", code: "FIGMA_REST_ASSET_CANCELLATION_ACCEPTED", documentRevision: revision, transactionId: input.transactionId, details: { cancelledNodeCount: resolved.cancelledNodeIds.length } });
    emitSnapshot(journalEntry({ type: "restore-core", coreSnapshot: wasmDocument.snapshot_json() }, baseRevision, input.transactionId));
    queueRemoteOperation(input.transactionId, baseRevision, resolved.batch, wasmDocument.canonical_hash());
    emit({ type: "ack", transactionId: input.transactionId, acceptedRevision: revision });
  } catch (error) {
    emitError(error, "INVALID_COMMAND", input.transactionId);
    emit({ type: "ack", transactionId: input.transactionId, errorCode: "INVALID_TRANSACTION" });
  }
}
type JournalReplayEngine = Pick<WasmDocumentEngine, "revision" | "snapshot_json" | "apply_transaction_json" | "move_nodes" | "load_snapshot_json">;

function replayJournalEntry(engine: JournalReplayEngine, entry: LocalJournalEntry) {
  if (entry.acceptedRevision <= Number(engine.revision)) return;
  try {
    if (entry.baseRevision !== Number(engine.revision)) throw new Error("JOURNAL_REVISION_CONFLICT");
    const operation = entry.operation;
    if (operation.type === "create" || operation.type === "update" || operation.type === "resizeWithoutConstraints" || operation.type === "reposition" || operation.type === "reparent" || operation.type === "group" || operation.type === "boolean" || operation.type === "ungroup" || operation.type === "transformGroup" || operation.type === "delete") {
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
type BenchmarkScenario = NonNullable<BenchmarkProjectionSnapshot["benchmark"]>;

function runBenchmarkScenario(
  engine: WasmDocumentEngine,
  benchmark: BenchmarkScenario,
): EditorSnapshot["benchmark"] {
  const layoutChildren = nodes.filter(
    (node) => node.parentId === benchmark.frameId,
  ).length;
  const failed = (): NonNullable<EditorSnapshot["benchmark"]> => ({
    kind: "pf02-layout-cascade",
    status: "failed",
    nodeCount: nodes.length,
    layoutChildren,
  });
  try {
    const frame = nodes.find((node) => node.id === benchmark.frameId);
    if (!frame || frame.kind !== "frame") return failed();
    const autoLayout: DocumentAutoLayout = {
      mode: "horizontal",
      padding: [0, 0, 0, 0],
      itemSpacing: 0,
      wrap: false,
      primaryAlignment: "spaceBetween",
      counterAlignment: "start",
      primarySizing: "fixed",
      counterSizing: "fixed",
      absolute: false,
    };

    // Enable layout only after all nodes have hydrated. This setup is excluded
    // from the measured width transaction and prevents batch-by-batch cascades.
    engine.apply_transaction_json(
      createId(),
      engine.revision,
      JSON.stringify([
        {
          type: "update",
          node: coreProjectionNode({ ...frame, autoLayout }),
        } satisfies CoreBatchCommand,
      ]),
    );
    const before = JSON.parse(
      engine.memory_stats_json(),
    ) as NonNullable<EditorSnapshot["memory"]>;
    const beforeWasmHeapBytes = wasmMemory?.buffer.byteLength ?? 0;
    const started = performance.now();
    engine.apply_transaction_json(
      createId(),
      engine.revision,
      JSON.stringify([
        {
          type: "update",
          node: coreProjectionNode({
            ...frame,
            width: benchmark.targetWidth,
            autoLayout,
          }),
        } satisfies CoreBatchCommand,
      ]),
    );
    const transactionMs = performance.now() - started;
    const after = JSON.parse(
      engine.memory_stats_json(),
    ) as NonNullable<EditorSnapshot["memory"]>;
    revision = Number(engine.revision);
    return {
      kind: "pf02-layout-cascade",
      status: "complete",
      nodeCount: nodes.length,
      layoutChildren,
      transactionMs,
      beforeWasmHeapBytes,
      afterWasmHeapBytes: wasmMemory?.buffer.byteLength ?? 0,
      beforeDocumentBytes: before.nodeBytes,
      afterDocumentBytes: after.nodeBytes,
      beforeUndoBytes: before.undoBytes,
      afterUndoBytes: after.undoBytes,
      beforeDedupeBytes: before.dedupeBytes,
      afterDedupeBytes: after.dedupeBytes,
    };
  } catch {
    return failed();
  }
}

async function loadDocumentBridge(localSnapshot?: CoreLocalSnapshot, benchmarkProjection = false, seedAssets: readonly DocumentAsset[] = [], hydrationRequestId?: string, benchmark?: BenchmarkScenario) {
  const loadSequence = ++bridgeLoadSequence;
  benchmarkEvidence = undefined;
  renderPerformance.reset();
  try {
    // `hydrate` can arrive immediately after `init`. wasm-bindgen's default
    // initializer mutates module-global memory, so concurrent calls must share
    // one initialized runtime. Each bridge load still creates its own document.
    const wasm = await loadWasmRuntime();
    const runtime = await wasm.default();
    wasmMemory = runtime.memory;
    if (wasm.engine_semantics_version() !== ENGINE_SEMANTICS_VERSION) throw new Error("Unsupported WASM engine semantics");
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
      engine.seed_document_id(documentId);
      if (seedAssets.length) engine.seed_assets_json(JSON.stringify(seedAssets));
      nodes = normalizeAutoLayoutProjection(nodes);
      for (const batchNodes of wasmHydrationBatches(nodes)) {
        const hydrated = resolveCoreBatch([], batchNodes.map((node) => ({ type: "create" as const, node })));
        if (!hydrated) throw new Error("INVALID_LEGACY_PROJECTION");
        engine.seed_batch_json(JSON.stringify(hydrated.batch));
      }
      // Identity was installed before the first node so hydration never needs
      // a second full Snapshot projection solely to replace `documentId`.
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
      if (benchmark) benchmarkEvidence = runBenchmarkScenario(engine, benchmark);
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
      void loadDocumentBridge(undefined, benchmarkProjection, [], hydrationRequestId, benchmark);
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
    if (command.type === "update" || command.type === "resizeWithoutConstraints") {
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
  return Boolean(wasmDocument) && (command.type === "create" || command.type === "delete" || command.type === "reposition" || command.type === "update" || command.type === "resizeWithoutConstraints");
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
  nonLinearGradientSurfaces.clear();
  filteredImageSurfaces.clear();
  filteredImageSurfaceBytes = 0;
  documentCore = "Starting Rust/WASM bridge";
  const reset = resetDocumentProjection([]);
  nodes = reset.nodes;
  revision = reset.revision;
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
    if (advancesRevision) revision += 1;
    rebuildNodeIndex();
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
  let ordinaryHit = semanticHit ? nodesById.get(semanticHit.nodeId) : undefined;
  if (!ordinaryHit) {
    // Fallback remains available while an older/partial scene compiler cannot
    // map a node kind. It keeps an optimization failure from changing selection.
    const candidates = [...active].reverse().filter((candidate) => candidate.visible !== false && !isRenderedBooleanOperand(candidate) && !isEffectivelyLocked(nodesById, candidate.id) && isInsideClippingFrames(candidate, point) && containsWorldPoint(candidate, point));
    // Slices are export-only regions. The shared selector keeps them available
    // from Layers while direct canvas clicks reach painted content underneath.
    ordinaryHit = findTopmostCanvasSelectionCandidate(candidates);
  }
  const repeatHit = findTopmostTransformGroupRepeatHit({
    documentNodes: nodes,
    paintOrderNodes: active,
    point,
    worldTransformByNodeId: worldTransformById,
    containsSourcePoint: containsWorldPoint,
    isSourcePointVisible: (candidate, sourcePoint, groupId) =>
      isInsideClippingFrames(candidate, sourcePoint, groupId),
    isDerivedPointVisible: (candidate, derivedPoint, groupId) => candidate.visible !== false
      && !isRenderedBooleanOperand(candidate)
      && !isEffectivelyLocked(nodesById, candidate.id)
      && Boolean(nodesById.get(groupId) && isInsideClippingFrames(nodesById.get(groupId)!, derivedPoint)),
  });
  const ordinaryPaintIndex = ordinaryHit ? active.findIndex((candidate) => candidate.id === ordinaryHit!.id) : -1;
  return { active, node: repeatHit && repeatHit.paintAfterIndex >= ordinaryPaintIndex ? repeatHit.node : ordinaryHit };
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
function paintStackStyle(ctx: OffscreenCanvasRenderingContext2D, paint: NonNullable<CanvasNode["fills"]>[number], width: number, height: number): string | CanvasGradient | CanvasPattern {
  if (paint.gradientPaint) return nonLinearGradientPattern(ctx, paint.gradientPaint, width, height) ?? paint.css;
  return paintStyle(ctx, paint.css, paint.gradient, width, height);
}

function nonLinearGradientPattern(
  ctx: OffscreenCanvasRenderingContext2D,
  gradient: DocumentGradientPaint,
  width: number,
  height: number,
): CanvasPattern | undefined {
  const pixelWidth = Math.max(1, Math.min(512, Math.ceil(Math.abs(width) * viewport.zoom * dpr)));
  const pixelHeight = Math.max(1, Math.min(512, Math.ceil(Math.abs(height) * viewport.zoom * dpr)));
  const key = JSON.stringify([gradient, pixelWidth, pixelHeight]);
  let surface = nonLinearGradientSurfaces.get(key);
  if (!surface) {
    surface = renderNonLinearGradientSurface(gradient, pixelWidth, pixelHeight);
    nonLinearGradientSurfaces.set(key, surface);
    while (nonLinearGradientSurfaces.size > MAX_NON_LINEAR_GRADIENT_CACHE_ENTRIES) {
      const oldest = nonLinearGradientSurfaces.keys().next().value;
      if (oldest === undefined) break;
      nonLinearGradientSurfaces.delete(oldest);
    }
  } else {
    nonLinearGradientSurfaces.delete(key);
    nonLinearGradientSurfaces.set(key, surface);
  }
  const pattern = ctx.createPattern(surface, "no-repeat") ?? undefined;
  pattern?.setTransform({ a: width / pixelWidth, d: height / pixelHeight } as DOMMatrix2DInit);
  return pattern;
}

function renderNonLinearGradientSurface(
  gradient: DocumentGradientPaint,
  pixelWidth: number,
  pixelHeight: number,
): OffscreenCanvas {
  const surface = new OffscreenCanvas(pixelWidth, pixelHeight);
  const context = surface.getContext("2d", { alpha: true });
  if (!context) return surface;
  const pixels = context.createImageData(pixelWidth, pixelHeight);
  const stops = gradient.stops.map((stop) => ({
    position: stop.position,
    linear: colorToLinearSrgbComponents(stop.color),
    alpha: stop.color.alpha,
  }));
  for (let y = 0; y < pixelHeight; y += 1) {
    for (let x = 0; x < pixelWidth; x += 1) {
      const localX = (x + .5) / pixelWidth;
      const localY = (y + .5) / pixelHeight;
      const gx = gradient.transform.a * localX + gradient.transform.c * localY + gradient.transform.e;
      const gy = gradient.transform.b * localX + gradient.transform.d * localY + gradient.transform.f;
      const dx = gx;
      const dy = (gy - .5) * 2;
      const position = gradient.kind === "radial"
        ? Math.hypot(dx, dy)
        : gradient.kind === "diamond"
          ? Math.abs(dx) + Math.abs(dy)
          : ((Math.atan2(dy, dx) / (Math.PI * 2)) + 1) % 1;
      const [red, green, blue, alpha] = sampleNonLinearGradient(stops, position);
      const offset = (y * pixelWidth + x) * 4;
      pixels.data[offset] = red;
      pixels.data[offset + 1] = green;
      pixels.data[offset + 2] = blue;
      pixels.data[offset + 3] = alpha;
    }
  }
  context.putImageData(pixels, 0, 0);
  return surface;
}

function sampleNonLinearGradient(
  stops: readonly { position: number; linear: [number, number, number]; alpha: number }[],
  rawPosition: number,
): [number, number, number, number] {
  const position = Math.min(1, Math.max(0, rawPosition));
  let rightIndex = stops.findIndex((stop) => stop.position >= position);
  if (rightIndex < 0) rightIndex = stops.length - 1;
  const right = stops[rightIndex]!;
  const left = stops[Math.max(0, rightIndex - 1)]!;
  const amount = right.position === left.position ? 1 : (position - left.position) / (right.position - left.position);
  const encode = (value: number) => {
    const bounded = Math.min(1, Math.max(0, value));
    const srgb = bounded <= .0031308 ? bounded * 12.92 : 1.055 * bounded ** (1 / 2.4) - .055;
    return Math.round(srgb * 255);
  };
  return [
    encode(left.linear[0] + (right.linear[0] - left.linear[0]) * amount),
    encode(left.linear[1] + (right.linear[1] - left.linear[1]) * amount),
    encode(left.linear[2] + (right.linear[2] - left.linear[2]) * amount),
    Math.round(Math.min(1, Math.max(0, left.alpha + (right.alpha - left.alpha) * amount)) * 255),
  ];
}
function activeFills(node: CanvasNode) { return normalizedFillPaints(node); }
function activeStrokes(node: CanvasNode) { return normalizedStrokePaints(node); }
function activeFillLayers(node: CanvasNode) { return normalizedFillLayers(node); }
function activeStrokeLayers(node: CanvasNode) { return normalizedStrokeLayers(node); }
function hasVisibleFill(node: CanvasNode) {
  if (activeFillLayers(node).some((layer) => Boolean(layer.image))) return true;
  return activeFills(node).some(
    (paint) =>
      paint.gradient?.stops.some((stop) => stop.color.alpha > 0) ??
      paint.gradientPaint?.stops.some((stop) => stop.color.alpha > 0) ??
      (paint.color ?? documentColorFromCssHex(paint.css))?.alpha !== 0,
  );
}
function withNormalizedPaintLayer(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, layer: DocumentPaintLayer, draw: () => void) {
  if (maskAlphaPreparationContexts.has(ctx)) {
    // Mask source rendering consumes alpha only. Every supported Figma paint
    // blend uses source-over coverage, so its colour equation cannot change
    // the resulting mask alpha. Draw as Normal here to avoid native colour
    // blending and the Linear Burn/Dodge device-pixel readback path while
    // retaining the authored layer opacity and geometry.
    ctx.save();
    ctx.globalAlpha *= layer.opacity;
    ctx.globalCompositeOperation = "source-over";
    draw();
    ctx.restore();
    return;
  }
  if (isLinearBlendMode(layer.blendMode)) {
    const repeatTransform = repeatScreenTransformByContext.get(ctx);
    const canonicalWindow = compositeWindowForBounds(
      worldCompositeBoundsForNode(node),
      !repeatTransform && !repeatSourcePreparationContexts.has(ctx),
    );
    const window = canonicalWindow && repeatTransform
      ? transformedCompositeSurfaceWindow(canonicalWindow, repeatTransform, width, height)
      : canonicalWindow;
    if (window && !compositeLinearPaintLayer(
      ctx,
      window,
      compositeContextWindows.get(ctx),
      layer.blendMode,
      layer.opacity,
      draw,
      recordCanvasReadbackBytes,
    )) diagnostics.record({
      category: "renderer",
      code: "LINEAR_PAINT_BLEND_READBACK_FAILED",
      documentRevision: revision,
      details: { nodeId: node.id },
    });
    return;
  }
  ctx.save();
  ctx.globalAlpha *= layer.opacity;
  // A normal paint layer must inherit the node-level composite selected by
  // renderNode. Resetting it to source-over makes every simple node blend a
  // no-op. Non-normal layer blends deliberately override that inherited mode.
  if (layer.blendMode !== "normal") ctx.globalCompositeOperation = canvasCompositeMode(layer.blendMode);
  draw();
  ctx.restore();
}

function drawImagePaint(ctx: OffscreenCanvasRenderingContext2D, image: DocumentImagePaint, width: number, height: number) {
  const bitmap = imageBitmaps.get(image.assetId);
  const documentWidth = width / viewport.zoom;
  const documentHeight = height / viewport.zoom;
  const transform = resolvedImagePaintTransform(image, documentWidth, documentHeight);
  const layout = imagePaintLayoutBox(image, documentWidth, documentHeight);
  if (!transform || !layout) return;
  ctx.transform(transform.a, transform.b, transform.c, transform.d, transform.e * viewport.zoom, transform.f * viewport.zoom);
  if (!bitmap) {
    ctx.fillStyle = "rgba(0, 72, 255, .16)";
    for (let offset = -height; offset < width; offset += 18) ctx.fillRect(offset, 0, 8, height);
    return;
  }
  const source = filteredImageSource(image, bitmap);
  if (image.scaleMode === "tile") {
    const pattern = ctx.createPattern(source, "repeat");
    if (pattern) {
      ctx.fillStyle = pattern;
      ctx.fillRect(-width * 2, -height * 2, width * 5, height * 5);
    }
    return;
  }
  const layoutX = layout.x * viewport.zoom;
  const layoutY = layout.y * viewport.zoom;
  const layoutWidth = layout.width * viewport.zoom;
  const layoutHeight = layout.height * viewport.zoom;
  const scale = image.scaleMode === "fit"
    ? Math.min(layoutWidth / source.width, layoutHeight / source.height)
    : Math.max(layoutWidth / source.width, layoutHeight / source.height);
  const drawWidth = source.width * scale;
  const drawHeight = source.height * scale;
  ctx.drawImage(
    source,
    layoutX + (layoutWidth - drawWidth) / 2,
    layoutY + (layoutHeight - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
}

function filteredImageSource(image: DocumentImagePaint, bitmap: ImageBitmap): ImageBitmap | OffscreenCanvas {
  if (imageFiltersAreNeutral(image.filters)) return bitmap;
  const key = `${image.assetId}|${imageFiltersKey(image.filters!)}`;
  const cached = filteredImageSurfaces.get(key);
  if (cached?.bitmap === bitmap) {
    filteredImageSurfaces.delete(key);
    filteredImageSurfaces.set(key, cached);
    return cached.surface;
  }
  if (cached) {
    filteredImageSurfaces.delete(key);
    filteredImageSurfaceBytes -= cached.bytes;
  }
  const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = surface.getContext("2d", { willReadFrequently: true });
  if (!context) return bitmap;
  context.drawImage(bitmap, 0, 0);
  const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height);
  applyImageFiltersToRgba(pixels.data, image.filters!);
  context.putImageData(pixels, 0, 0);
  const bytes = bitmap.width * bitmap.height * 4;
  while (filteredImageSurfaces.size && filteredImageSurfaceBytes + bytes > MAX_FILTERED_IMAGE_SURFACE_BYTES) {
    const oldestKey = filteredImageSurfaces.keys().next().value as string;
    const oldest = filteredImageSurfaces.get(oldestKey)!;
    filteredImageSurfaces.delete(oldestKey);
    filteredImageSurfaceBytes -= oldest.bytes;
  }
  if (bytes <= MAX_FILTERED_IMAGE_SURFACE_BYTES) {
    filteredImageSurfaces.set(key, { bitmap, surface, bytes });
    filteredImageSurfaceBytes += bytes;
  }
  return surface;
}

function textImagePaintPattern(
  ctx: OffscreenCanvasRenderingContext2D,
  image: DocumentImagePaint,
  width: number,
  height: number,
): CanvasPattern | undefined {
  const bitmap = imageBitmaps.get(image.assetId);
  if (!bitmap) return undefined;
  const source = filteredImageSource(image, bitmap);
  const documentWidth = width / viewport.zoom;
  const documentHeight = height / viewport.zoom;
  const transform = resolvedImagePaintTransform(image, documentWidth, documentHeight);
  const layout = imagePaintLayoutBox(image, documentWidth, documentHeight);
  if (!transform || !layout) return undefined;
  const pattern = ctx.createPattern(source, image.scaleMode === "tile" ? "repeat" : "no-repeat") ?? undefined;
  if (!pattern) return undefined;
  if (image.scaleMode === "tile") {
    pattern.setTransform({
      a: transform.a,
      b: transform.b,
      c: transform.c,
      d: transform.d,
      e: transform.e * viewport.zoom,
      f: transform.f * viewport.zoom,
    });
    return pattern;
  }
  const layoutX = layout.x * viewport.zoom;
  const layoutY = layout.y * viewport.zoom;
  const layoutWidth = layout.width * viewport.zoom;
  const layoutHeight = layout.height * viewport.zoom;
  const scale = image.scaleMode === "fit"
    ? Math.min(layoutWidth / source.width, layoutHeight / source.height)
    : Math.max(layoutWidth / source.width, layoutHeight / source.height);
  const drawWidth = source.width * scale;
  const drawHeight = source.height * scale;
  const drawX = layoutX + (layoutWidth - drawWidth) / 2;
  const drawY = layoutY + (layoutHeight - drawHeight) / 2;
  pattern.setTransform({
    a: transform.a * scale,
    b: transform.b * scale,
    c: transform.c * scale,
    d: transform.d * scale,
    e: transform.a * drawX + transform.c * drawY + transform.e * viewport.zoom,
    f: transform.b * drawX + transform.d * drawY + transform.f * viewport.zoom,
  });
  return pattern;
}

function textPaintLayers(
  node: CanvasNode,
  style: RenderTextStyle,
  fallback: readonly DocumentPaintLayer[],
): readonly DocumentPaintLayer[] {
  if (style.fillStack !== undefined) return style.fillStack.layers.filter((layer) => layer.visible && layer.opacity > 0);
  if (style.color) return [{
    visible: true,
    opacity: 1,
    blendMode: "normal",
    paint: { css: colorToSrgbCss(style.color), color: style.color },
  }];
  return fallback;
}

function paintTextSpan(
  ctx: OffscreenCanvasRenderingContext2D,
  node: CanvasNode,
  style: RenderTextStyle,
  text: string,
  x: number,
  baseline: number,
  width: number,
  height: number,
  fallback: readonly DocumentPaintLayer[],
) {
  const glyphLayers = textPaintLayers(node, style, fallback);
  glyphLayers.forEach((layer) => withNormalizedPaintLayer(ctx, node, layer, () => {
    if (layer.paint) ctx.fillStyle = paintStackStyle(ctx, layer.paint, width, height);
    else if (layer.image) ctx.fillStyle = textImagePaintPattern(ctx, layer.image, width, height) ?? "rgba(0, 72, 255, .16)";
    else return;
    ctx.fillText(text, x, baseline);
  }));
  paintTextDecorationLayers(ctx, node, style, text, x, baseline, width, height, glyphLayers);
}

function paintTextDecorationLayers(
  ctx: OffscreenCanvasRenderingContext2D,
  node: CanvasNode,
  style: RenderTextStyle,
  text: string,
  x: number,
  baseline: number,
  width: number,
  height: number,
  glyphLayers: readonly DocumentPaintLayer[],
) {
  textDecorationPaintLayers(style.textDecoration, style.textDecorationColor, glyphLayers)
    .forEach((layer) => withNormalizedPaintLayer(ctx, node, layer, () => {
      if (layer.paint) ctx.fillStyle = paintStackStyle(ctx, layer.paint, width, height);
      else if (layer.image) ctx.fillStyle = textImagePaintPattern(ctx, layer.image, width, height) ?? "rgba(0, 72, 255, .16)";
      else return;
      paintBasicTextDecoration(ctx, style, text, x, baseline);
    }));
}

/** Draws the supported underline and strikethrough decoration forms. Metrics,
 * SOLID/WAVY/DOTTED patterns, explicit offsets/thicknesses and descender-aware
 * skip-ink are resolved from the same Canvas font metrics as glyph painting. */
function paintBasicTextDecoration(
  ctx: OffscreenCanvasRenderingContext2D,
  style: RenderTextStyle,
  text: string,
  x: number,
  baseline: number,
) {
  if (!style.textDecoration || !text) return;
  const metrics = ctx.measureText(text);
  const rect = basicTextDecorationRect({
    decoration: style.textDecoration,
    fontSize: style.fontSize,
    zoom: viewport.zoom,
    textWidth: metrics.width,
    textAlign: ctx.textAlign,
    anchorX: x,
    baseline,
    actualBoundingBoxDescent: metrics.actualBoundingBoxDescent,
    offset: style.textDecoration === "underline" ? style.textDecorationOffset : undefined,
    thickness: style.textDecoration === "underline" ? style.textDecorationThickness : undefined,
  });
  if (!rect) return;
  const styleKind = style.textDecoration === "underline" ? style.textDecorationStyle : undefined;
  const pattern = basicTextDecorationPattern(styleKind, rect.height);
  if (!pattern) return;
  const segments = style.textDecoration === "underline" && style.textDecorationSkipInk === true
    ? textDecorationVisibleSegments(rect, textDecorationInkExclusions(ctx, text, rect, baseline))
    : [rect];
  for (const segment of segments) paintBasicTextDecorationSegment(ctx, segment, pattern);
}

function textDecorationInkExclusions(
  ctx: OffscreenCanvasRenderingContext2D,
  text: string,
  rect: BasicTextDecorationRect,
  baseline: number,
) {
  const glyphs = Array.from(text).map((glyph) => {
    const metrics = ctx.measureText(glyph);
    return { advance: metrics.width, descent: metrics.actualBoundingBoxDescent };
  });
  const totalAdvance = glyphs.reduce((sum, glyph) => sum + glyph.advance, 0);
  if (!(totalAdvance > 0)) return [];
  const scale = rect.width / totalAdvance;
  const rtl = ctx.direction === "rtl";
  const gap = Math.max(1, rect.height * .75);
  let advance = 0;
  const exclusions: Array<{ start: number; end: number }> = [];
  for (const glyph of glyphs) {
    const next = advance + glyph.advance;
    if (Number.isFinite(glyph.descent) && baseline + glyph.descent >= rect.y) {
      const start = rtl ? rect.x + rect.width - next * scale : rect.x + advance * scale;
      const end = rtl ? rect.x + rect.width - advance * scale : rect.x + next * scale;
      exclusions.push({ start: start - gap, end: end + gap });
    }
    advance = next;
  }
  return exclusions;
}

function paintBasicTextDecorationSegment(
  ctx: OffscreenCanvasRenderingContext2D,
  rect: BasicTextDecorationRect,
  pattern: BasicTextDecorationPattern,
) {
  if (pattern.kind === "solid") {
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    return;
  }
  const centerY = rect.y + rect.height / 2;
  if (pattern.kind === "dotted") {
    ctx.beginPath();
    if (rect.width < pattern.radius * 2) {
      const center = rect.x + rect.width / 2;
      ctx.moveTo(center + rect.width / 2, centerY);
      ctx.arc(center, centerY, rect.width / 2, 0, Math.PI * 2);
    } else {
      const limit = rect.x + rect.width - pattern.radius;
      for (let center = rect.x + pattern.radius; center <= limit + Number.EPSILON; center += pattern.spacing) {
        ctx.moveTo(center + pattern.radius, centerY);
        ctx.arc(center, centerY, pattern.radius, 0, Math.PI * 2);
      }
    }
    ctx.fill();
    return;
  }
  ctx.save();
  ctx.beginPath();
  ctx.lineWidth = pattern.strokeWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.moveTo(rect.x, centerY);
  const end = rect.x + rect.width;
  for (let cursor = rect.x; cursor < end;) {
    const segment = Math.min(pattern.wavelength, end - cursor);
    const amplitude = pattern.amplitude * (segment / pattern.wavelength);
    ctx.bezierCurveTo(
      cursor + segment * .25, centerY - amplitude,
      cursor + segment * .75, centerY + amplitude,
      cursor + segment, centerY,
    );
    cursor += segment;
  }
  ctx.strokeStyle = ctx.fillStyle;
  ctx.stroke();
  ctx.restore();
}

function fillPaintStack(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, width: number, height: number, fillRule: CanvasFillRule = "nonzero") {
  activeFillLayers(node).forEach((layer) => withNormalizedPaintLayer(ctx, node, layer, () => {
    if (layer.paint) {
      ctx.fillStyle = paintStackStyle(ctx, layer.paint, width, height);
      ctx.fill(fillRule);
      return;
    }
    if (layer.image) {
      ctx.save();
      ctx.clip(fillRule);
      drawImagePaint(ctx, layer.image, width, height);
      ctx.restore();
    }
  }));
}
function strokePaintStack(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, width: number, height: number) {
  activeStrokeLayers(node).forEach((layer) => withNormalizedPaintLayer(ctx, node, layer, () => {
    if (layer.paint) {
      ctx.strokeStyle = paintStackStyle(ctx, layer.paint, width, height);
      ctx.stroke();
      return;
    }
    const bitmap = layer.image && imageBitmaps.get(layer.image.assetId);
    const source = bitmap && layer.image ? filteredImageSource(layer.image, bitmap) : undefined;
    const pattern = source && ctx.createPattern(source, "repeat");
    if (pattern) {
      const transform = layer.image && resolvedImagePaintTransform(
        layer.image,
        width / viewport.zoom,
        height / viewport.zoom,
      );
      if (!transform) return;
      pattern.setTransform({
        a: transform.a,
        b: transform.b,
        c: transform.c,
        d: transform.d,
        e: transform.e * viewport.zoom,
        f: transform.f * viewport.zoom,
      });
      ctx.strokeStyle = pattern;
      ctx.stroke();
    }
  }));
}
function fillStrokePaintStack(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, width: number, height: number, fillRule: CanvasFillRule = "nonzero") {
  activeStrokeLayers(node).forEach((layer) => withNormalizedPaintLayer(ctx, node, layer, () => {
    if (layer.paint) {
      ctx.fillStyle = paintStackStyle(ctx, layer.paint, width, height);
      ctx.fill(fillRule);
      return;
    }
    if (layer.image) {
      ctx.save();
      ctx.clip(fillRule);
      drawImagePaint(ctx, layer.image, width, height);
      ctx.restore();
    }
  }));
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
  fillStrokePaintStack(ctx, node, width, height);
}
function fillScaledCanonicalStrokeMesh(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, mesh: StrokeMesh, width: number, height: number, scale: number) {
  ctx.beginPath();
  mesh.forEach(([a, b, c]) => {
    ctx.moveTo(a.x * scale, a.y * scale);
    ctx.lineTo(b.x * scale, b.y * scale);
    ctx.lineTo(c.x * scale, c.y * scale);
    ctx.closePath();
  });
  fillStrokePaintStack(ctx, node, width, height);
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

const MAX_RUNTIME_EXPORT_BOOLEAN_NODES = 256;
const MAX_RUNTIME_EXPORT_BOOLEAN_POINTS = 100_000;

function emitRuntimeExportBooleanPaths(request: Extract<MainToWorker, { type: "runtime-export-boolean-paths" }>) {
  const validIds = request.nodeIds.length >= 1
    && request.nodeIds.length <= MAX_RUNTIME_EXPORT_BOOLEAN_NODES
    && new Set(request.nodeIds).size === request.nodeIds.length
    && request.nodeIds.every((id) => id.length >= 1 && id.length <= 256);
  if (!request.requestId || request.requestId.length > 128 || !Number.isSafeInteger(request.revision) || request.revision < 0 || !validIds) {
    emit({ type: "runtime-export-boolean-paths-result", requestId: request.requestId, revision, errorCode: "INVALID_REQUEST" });
    return;
  }
  if (request.revision !== revision) {
    emit({ type: "runtime-export-boolean-paths-result", requestId: request.requestId, revision, errorCode: "REVISION_CONFLICT" });
    return;
  }
  const requestedNodes = request.nodeIds.map((id) => nodes.find((node) => node.id === id));
  if (requestedNodes.some((node) => node?.kind !== "booleanOperation")) {
    emit({ type: "runtime-export-boolean-paths-result", requestId: request.requestId, revision, errorCode: "INVALID_REQUEST" });
    return;
  }
  const paths = Object.create(null) as Record<string, DocumentVectorPath>;
  let pointCount = 0;
  for (const node of requestedNodes as CanvasNode[]) {
    const path = canonicalBooleanPath(node);
    if (!path) continue;
    pointCount += path.subpaths.reduce((total, subpath) => total + subpath.points.length, 0);
    if (pointCount > MAX_RUNTIME_EXPORT_BOOLEAN_POINTS) {
      emit({ type: "runtime-export-boolean-paths-result", requestId: request.requestId, revision, errorCode: "RESOURCE_LIMIT" });
      return;
    }
    paths[node.id] = {
      fillRule: "nonZero",
      subpaths: path.subpaths.map((subpath, subpathIndex) => ({
        closed: subpath.closed,
        points: subpath.points.map((point, pointIndex) => ({
          id: `${node.id}:runtime-export:${subpathIndex}:${pointIndex}`,
          x: point.x,
          y: point.y,
          pointType: "corner",
        })),
      })),
    };
  }
  emit({ type: "runtime-export-boolean-paths-result", requestId: request.requestId, revision, paths });
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
  if (activeStrokeLayers(node).some((layer) => Boolean(layer.image))) return true;
  return activeStrokes(node).some((paint) => paint.gradient?.stops.some((stop) => stop.color.alpha > 0)
    ?? paint.gradientPaint?.stops.some((stop) => stop.color.alpha > 0)
    ?? (paint.color ?? documentColorFromCssHex(paint.css))?.alpha !== 0);
}
function applyStrokeStyle(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode) {
  ctx.lineJoin = node.strokeJoin ?? "miter";
  ctx.miterLimit = node.strokeMiterLimit ?? 10;
  ctx.setLineDash((node.strokeDashPattern ?? []).map((segment) => segment * viewport.zoom));
}
function orderedEffects(node: CanvasNode): readonly NonNullable<CanvasNode["effectStack"]>[number][] {
  return normalizedNodeEffects(node);
}
function nodeEffectScale(node: CanvasNode) {
  const transform = worldTransformById.get(node.id);
  return transform
    ? Math.max(Math.hypot(transform.a, transform.b), Math.hypot(transform.c, transform.d))
    : 1;
}
function worldEffectPaddingForNode(node: CanvasNode, includeOffsets = false) {
  return worldEffectPaddingForNodeBounds(node, worldTransformById.get(node.id), !includeOffsets);
}
function expandedBounds(bounds: Readonly<{ left: number; top: number; right: number; bottom: number }> | undefined, padding: number) {
  if (!bounds) return undefined;
  return {
    left: bounds.left - padding,
    top: bounds.top - padding,
    right: bounds.right + padding,
    bottom: bounds.bottom + padding,
  };
}
function worldCompositeBoundsForNode(node: CanvasNode) {
  return expandedBounds(worldVisualBoundsForNode(nodes, node), worldEffectPaddingForNode(node));
}
function combinedWorldCompositeBounds(nodesToMeasure: readonly CanvasNode[]) {
  return nodesToMeasure.reduce<Readonly<{ left: number; top: number; right: number; bottom: number }> | undefined>((combined, node) => {
    const bounds = cachedWorldCompositeBoundsForNode(node);
    if (!bounds) return combined;
    if (!combined) return bounds;
    return {
      left: Math.min(combined.left, bounds.left),
      top: Math.min(combined.top, bounds.top),
      right: Math.max(combined.right, bounds.right),
      bottom: Math.max(combined.bottom, bounds.bottom),
    };
  }, undefined);
}
function cachedWorldCompositeBoundsForNode(node: CanvasNode) {
  const cached = nodeBoundsById.get(node.id);
  if (!cached) return worldCompositeBoundsForNode(node);
  const scale = nodeEffectScale(node);
  const align = node.strokeAlign ?? "inside";
  const strokeExpansion = Math.max(0, node.strokeWidth) * scale * (align === "outside" ? 1 : align === "center" ? .5 : 0);
  // `nodeBoundsById` stores the geometry envelope, unlike
  // `worldVisualBoundsForNode` which already includes the first drop-shadow
  // radius and its directional offset. The cached fast path therefore needs
  // the complete effect envelope. Using the smaller visual-bounds padding here
  // clipped the soft tail of Canvas islands before they were composited back
  // between WebGPU islands.
  return expandedBounds({
    left: cached.x,
    top: cached.y,
    right: cached.x + cached.width,
    bottom: cached.y + cached.height,
  }, worldEffectPaddingForNode(node, true) + strokeExpansion);
}
function compositeWindowForBounds(
  bounds: Readonly<{ left: number; top: number; right: number; bottom: number }> | undefined,
  clipToCanvas = true,
) {
  if (!bounds) return undefined;
  return compositeSurfaceWindowForWorldBounds(
    bounds,
    viewport,
    width,
    height,
    dpr,
    2 / dpr,
    clipToCanvas,
  );
}
/** Sum of clipped paint envelopes, capped to the frame. Overlapping nodes may
 * make this an upper bound; the metric is intentionally cheap enough to keep
 * enabled on large pages and is reported as such in the public field name. */
function clippedNodeCoverageUpperBound(nodesToMeasure: readonly CanvasNode[]) {
  if (!canvas) return 0;
  const framePixels = canvas.width * canvas.height;
  let coveredPixels = 0;
  for (const node of nodesToMeasure) {
    // Coverage is diagnostic data on the hot render path. Recomputing
    // worldVisualBoundsForNode here rebuilds a document-wide ancestry resolver
    // for every node and turns a 50K flat scene into quadratic work. The
    // spatial index already owns the projected world bounds; expand that cache
    // conservatively for effects and any outward stroke before clipping.
    const bounds = cachedWorldCompositeBoundsForNode(node);
    const window = compositeWindowForBounds(bounds);
    if (!window) continue;
    coveredPixels += window.pixelWidth * window.pixelHeight;
    if (coveredPixels >= framePixels) return framePixels;
  }
  return coveredPixels;
}
function effectSurfaceWindowForNode(node: CanvasNode, context?: OffscreenCanvasRenderingContext2D): CompositeSurfaceWindow | undefined {
  const repeatedSource = Boolean(context && (
    repeatScreenTransformByContext.has(context) || repeatSourcePreparationContexts.has(context)
  ));
  return compositeWindowForBounds(worldCompositeBoundsForNode(node), !repeatedSource);
}
function structuralCompositeSurfacePlan(orderedNodes: readonly CanvasNode[]): CompositeFrameSurfacePlan {
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
  const combine = (left: PaintBounds | undefined, right: PaintBounds | undefined): PaintBounds | undefined => {
    if (!left) return right;
    if (!right) return left;
    return {
      left: Math.min(left.left, right.left),
      top: Math.min(left.top, right.top),
      right: Math.max(left.right, right.right),
      bottom: Math.max(left.bottom, right.bottom),
    };
  };
  const cache = new Map<string, PaintBounds | undefined>();
  const subtreeBackgroundBlurCache = new Map<string, boolean>();
  const canonicalById = new Map(nodes.map((node) => [node.id, node]));
  const subtreeBounds = (node: CanvasNode): PaintBounds | undefined => {
    if (cache.has(node.id)) return cache.get(node.id);
    const descendants = children.get(node.id) ?? [];
    let bounds = descendants.length > 0 && requiresSubtreeComposition(node, true)
      ? worldVisualBoundsForNode(nodes, node)
      : worldCompositeBoundsForNode(node);
    descendants.forEach((child) => { bounds = combine(bounds, subtreeBounds(child)); });
    if (node.kind === "transformGroup") {
      const canonical = canonicalById.get(node.id);
      const repeatSubtree = canonical ? transformGroupRepeatSubtree(orderedNodes, canonical, children) : undefined;
      const derived = canonical && repeatSubtree ? transformGroupRepeatDerivedBounds(nodes, canonical, repeatSubtree.sources, {
        groupWorld: worldTransformById.get(canonical.id),
        worldTransformByNodeId: worldTransformById,
        canonicalNodeById: canonicalById,
        paintNodes: orderedNodes,
        childrenByParentId: children,
      }) : undefined;
      bounds = combine(bounds, derived);
    }
    if (descendants.length > 0 && requiresSubtreeComposition(node, true))
      bounds = expandedBounds(bounds, worldEffectPaddingForNode(node, true));
    cache.set(node.id, bounds);
    return bounds;
  };
  const subtreeHasBackgroundBlur = (node: CanvasNode): boolean => {
    const cached = subtreeBackgroundBlurCache.get(node.id);
    if (cached !== undefined) return cached;
    const result = (!node.isMask && activeNodeEffects(node).some((effect) => Boolean(effect.backgroundBlur)))
      || (children.get(node.id) ?? []).some(subtreeHasBackgroundBlur);
    subtreeBackgroundBlurCache.set(node.id, result);
    return result;
  };
  let effectPool: CompositePoolDimensions | undefined;
  let linearPaintPool: CompositePoolDimensions | undefined;
  const alphaMaskPools: CompositePoolDimensions[] = [];
  const subtreePools: CompositePoolDimensions[] = [];
  const include = (current: CompositePoolDimensions | undefined, window: CompositeSurfaceWindow | undefined) => window
    ? {
        pixelWidth: Math.max(current?.pixelWidth ?? 1, window.pixelWidth),
        pixelHeight: Math.max(current?.pixelHeight ?? 1, window.pixelHeight),
      }
    : current ?? { pixelWidth: 1, pixelHeight: 1 };
  const includeRepeatBackgroundBlurWindows = (
    current: CompositePoolDimensions | undefined,
    window: CompositeSurfaceWindow | undefined,
    transforms: readonly AffineMatrix[],
  ) => {
    let dimensions = include(current, window);
    if (!window) return dimensions;
    for (const transform of transforms) {
      dimensions = include(dimensions, transformedCompositeSurfaceWindow(window, transform, width, height));
    }
    return dimensions;
  };
  const repeatTransformsForChildren = (node: CanvasNode, inherited: readonly AffineMatrix[]) => {
    if (node.kind !== "transformGroup") return inherited;
    const canonical = canonicalById.get(node.id) ?? node;
    const own = (transformGroupRepeatMatrices(nodes, canonical) ?? []).map((matrix) =>
      affineScreenMatrix(matrix, toScreen(0, 0), viewport.zoom));
    if (!own.length) return inherited;
    return [
      ...inherited,
      ...own,
      ...inherited.flatMap((outer) => own.map((inner) => multiplyAffine(outer, inner))),
    ];
  };
  const visitSiblings = (
    siblings: readonly CanvasNode[],
    maskDepth: number,
    compositionDepth: number,
    repeatTransforms: readonly AffineMatrix[] = [],
    maskAlphaOnly = false,
  ) => {
    for (let index = 0; index < siblings.length; index += 1) {
      const node = siblings[index]!;
      const insideRepeat = repeatTransforms.length > 0;
      const alphaOnly = maskAlphaOnly || Boolean(node.isMask);
      const nodeEffects = alphaOnly ? activeMaskAlphaEffects(node) : activeNodeEffects(node);
      const hasAdmittedBackgroundBlur = !alphaOnly
        && nodeEffects.some((effect) => Boolean(effect.backgroundBlur));
      const childRepeatTransforms = repeatTransformsForChildren(node, repeatTransforms);
      if (!alphaOnly && [...activeFillLayers(node), ...activeStrokeLayers(node)]
        .some((layer) => isLinearBlendMode(layer.blendMode))) {
        linearPaintPool = include(linearPaintPool, compositeWindowForBounds(worldCompositeBoundsForNode(node), !insideRepeat));
      }
      if (node.isMask) {
        let end = index + 1;
        while (end < siblings.length && !siblings[end]!.isMask) end += 1;
        const targets = siblings.slice(index + 1, end);
        const maskDescendants = children.get(node.id) ?? [];
        const maskIsolated = requiresSubtreeComposition(node, maskDescendants.length > 0, nodeEffects);
        if (maskIsolated) {
          const maskWindow = compositeWindowForBounds(subtreeBounds(node), !insideRepeat);
          subtreePools[compositionDepth] = include(subtreePools[compositionDepth], maskWindow);
          visitSiblings(maskDescendants, maskDepth + 1, compositionDepth + 1, childRepeatTransforms, true);
        } else {
          if (nodeEffects.length > 0)
            effectPool = include(effectPool, compositeWindowForBounds(worldCompositeBoundsForNode(node), !insideRepeat));
          visitSiblings(maskDescendants, maskDepth + 1, compositionDepth, childRepeatTransforms, true);
        }
        if (targets.length) {
          const runBounds = targets.reduce<PaintBounds | undefined>(
            (bounds, target) => combine(bounds, subtreeBounds(target)),
            subtreeBounds(node),
          );
          alphaMaskPools[maskDepth] = include(alphaMaskPools[maskDepth], compositeWindowForBounds(runBounds, !insideRepeat));
          visitSiblings(targets, maskDepth + 1, compositionDepth, repeatTransforms, false);
        }
        index = end - 1;
        continue;
      }
      const descendants = children.get(node.id) ?? [];
      const isolated = requiresSubtreeComposition(node, descendants.length > 0, nodeEffects);
      if (isolated) {
        const subtreeWindow = compositeWindowForBounds(subtreeBounds(node), !insideRepeat);
        subtreePools[compositionDepth] = !maskAlphaOnly && subtreeHasBackgroundBlur(node)
          ? includeRepeatBackgroundBlurWindows(subtreePools[compositionDepth], subtreeWindow, repeatTransforms)
          : include(subtreePools[compositionDepth], subtreeWindow);
        visitSiblings(descendants, maskDepth, compositionDepth + 1, childRepeatTransforms, maskAlphaOnly);
      } else {
        if (node.kind !== "group" && node.kind !== "slice" && nodeEffects.length > 0) {
          const effectWindow = compositeWindowForBounds(worldCompositeBoundsForNode(node), !insideRepeat);
          effectPool = hasAdmittedBackgroundBlur
            ? includeRepeatBackgroundBlurWindows(effectPool, effectWindow, repeatTransforms)
            : include(effectPool, effectWindow);
        }
        visitSiblings(descendants, maskDepth, compositionDepth, childRepeatTransforms, maskAlphaOnly);
      }
    }
  };
  visitSiblings(roots, 0, 0);
  return { effectPool, linearPaintPool, alphaMaskPools, subtreePools };
}
function prepareCompositeSurface(
  context: OffscreenCanvasRenderingContext2D,
  surface: OffscreenCanvas,
  window: CompositeSurfaceWindow,
) {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, surface.width, surface.height);
  setCompositeSurfaceTransform(context, window);
  compositeContextWindows.set(context, window);
}
function isPreparingRepeatedSource(context: OffscreenCanvasRenderingContext2D) {
  return repeatScreenTransformByContext.has(context) || repeatSourcePreparationContexts.has(context);
}
function withRepeatSourcePreparation<T>(
  context: OffscreenCanvasRenderingContext2D,
  enabled: boolean,
  paint: () => T,
): T {
  const alreadyEnabled = repeatSourcePreparationContexts.has(context);
  if (enabled) repeatSourcePreparationContexts.add(context);
  try {
    return paint();
  } finally {
    if (enabled && !alreadyEnabled) repeatSourcePreparationContexts.delete(context);
  }
}
function withMaskAlphaPreparation<T>(
  context: OffscreenCanvasRenderingContext2D,
  enabled: boolean,
  paint: () => T,
): T {
  const alreadyEnabled = maskAlphaPreparationContexts.has(context);
  if (enabled) maskAlphaPreparationContexts.add(context);
  try {
    return paint();
  } finally {
    if (enabled && !alreadyEnabled) maskAlphaPreparationContexts.delete(context);
  }
}
function drawCompositeSurface(
  context: OffscreenCanvasRenderingContext2D,
  source: OffscreenCanvas,
  window: CompositeSurfaceWindow,
  offsetX = 0,
  offsetY = 0,
) {
  context.drawImage(
    source,
    0,
    0,
    window.pixelWidth,
    window.pixelHeight,
    window.x + offsetX,
    window.y + offsetY,
    window.width,
    window.height,
  );
}

function repeatBackgroundBlurWindow(
  destination: OffscreenCanvasRenderingContext2D,
  window: CompositeSurfaceWindow,
  effects: readonly NonNullable<CanvasNode["effectStack"]>[number][],
) {
  const active = effects.filter(effectChangesPixels);
  const repeatTransform = repeatScreenTransformByContext.get(destination);
  return repeatTransform
    && active.some((effect) => Boolean(effect.backgroundBlur))
    ? transformedCompositeSurfaceWindow(window, repeatTransform, width, height)
    : undefined;
}

/** Effect offsets are authored in the canonical layer coordinate space. Once
 * Background Blur materializes a Repeat copy into occurrence screen space,
 * rotate the remaining shadow offsets through the same rigid Repeat matrix. */
function repeatOccurrenceEffectOffset(
  destination: OffscreenCanvasRenderingContext2D,
  offsetX: number,
  offsetY: number,
  materializedOccurrence: boolean,
) {
  const transform = materializedOccurrence ? repeatScreenTransformByContext.get(destination) : undefined;
  return transform
    ? {
        x: transform.a * offsetX + transform.c * offsetY,
        y: transform.b * offsetX + transform.d * offsetY,
      }
    : { x: offsetX, y: offsetY };
}

function compositePoolDimensionsForWindows(
  first: CompositeSurfaceWindow,
  second?: CompositeSurfaceWindow,
): CompositePoolDimensions {
  return {
    pixelWidth: Math.max(first.pixelWidth, second?.pixelWidth ?? 0),
    pixelHeight: Math.max(first.pixelHeight, second?.pixelHeight ?? 0),
  };
}

/** Paints a canonical prepared surface into the current Repeat occurrence.
 * The resulting bitmap is in ordinary screen coordinates, which lets
 * Background Blur sample and filter the actual destination behind that copy. */
function materializeRepeatPreparedSurface(
  context: OffscreenCanvasRenderingContext2D,
  surface: OffscreenCanvas,
  source: OffscreenCanvas,
  sourceWindow: CompositeSurfaceWindow,
  occurrenceWindow: CompositeSurfaceWindow,
  transform: AffineMatrix,
) {
  context.save();
  prepareCompositeSurface(context, surface, occurrenceWindow);
  context.transform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
  drawCompositeSurface(context, source, sourceWindow);
  context.restore();
}

function compositeMaterializedOccurrence(
  destination: OffscreenCanvasRenderingContext2D,
  source: OffscreenCanvas,
  window: CompositeSurfaceWindow,
  mode: GlobalCompositeOperation | LinearBlendMode,
  opacity = 1,
) {
  return compositeEffectSurface(
    destination,
    source,
    window,
    mode,
    opacity,
    compositeContextWindows.get(destination),
    recordCanvasReadbackBytes,
  );
}
/** Repeat matrices live on the destination context. Native Canvas modes draw
 * the prepared screen-space window through that current transform. Linear
 * Burn and Dodge first project the window to the occurrence AABB, then reuse
 * the bounded readback compositor against the real destination backdrop. */
function compositePreparedSurface(
  destination: OffscreenCanvasRenderingContext2D,
  source: OffscreenCanvas,
  window: CompositeSurfaceWindow,
  mode: GlobalCompositeOperation | LinearBlendMode = "source-over",
  opacity = 1,
) {
  const repeatTransform = repeatScreenTransformByContext.get(destination);
  if (repeatTransform && isLinearBlendMode(mode)) {
    const transformedWindow = transformedCompositeSurfaceWindow(window, repeatTransform, width, height);
    if (!transformedWindow) return true;
    return compositeLinearPaintLayer(
      destination,
      transformedWindow,
      compositeContextWindows.get(destination),
      mode,
      opacity,
      () => {
        destination.save();
        destination.globalCompositeOperation = "source-over";
        destination.globalAlpha = 1;
        drawCompositeSurface(destination, source, window);
        destination.restore();
      },
      recordCanvasReadbackBytes,
    );
  }
  if (repeatTransform && !isLinearBlendMode(mode)) {
    destination.save();
    try {
      destination.globalCompositeOperation = mode;
      destination.globalAlpha = opacity;
      drawCompositeSurface(destination, source, window);
      return true;
    } finally {
      destination.restore();
    }
  }
  return compositeEffectSurface(
    destination,
    source,
    window,
    mode,
    opacity,
    compositeContextWindows.get(destination),
    recordCanvasReadbackBytes,
  );
}
function drawCompositeBacking(
  context: OffscreenCanvasRenderingContext2D,
  sourceContext: OffscreenCanvasRenderingContext2D,
  window: CompositeSurfaceWindow,
) {
  const preparedBackdrop = preparedBackdropContextByContext.get(sourceContext);
  if (preparedBackdrop) drawCompositeBacking(context, preparedBackdrop, window);
  const sourceWindow = compositeContextWindows.get(sourceContext);
  context.drawImage(
    sourceContext.canvas,
    window.pixelX - (sourceWindow?.pixelX ?? 0),
    window.pixelY - (sourceWindow?.pixelY ?? 0),
    window.pixelWidth,
    window.pixelHeight,
    window.x,
    window.y,
    window.width,
    window.height,
  );
}

/** Seeds a canonical intermediate surface with the backing seen by the
 * current Repeat occurrence. Drawing the occurrence through the inverse rigid
 * transform lets target blends and Background Blur execute in canonical space;
 * the completed masked result is transformed once when it is composited. */
function drawRepeatOccurrenceBacking(
  context: OffscreenCanvasRenderingContext2D,
  sourceContext: OffscreenCanvasRenderingContext2D,
  canonicalWindow: CompositeSurfaceWindow,
  repeatTransform: AffineMatrix,
) {
  const occurrenceWindow = transformedCompositeSurfaceWindow(
    canonicalWindow,
    repeatTransform,
    width,
    height,
  );
  const inverse = invertAffine(repeatTransform);
  if (!occurrenceWindow || !inverse) return false;
  context.save();
  context.transform(inverse.a, inverse.b, inverse.c, inverse.d, inverse.e, inverse.f);
  drawCompositeBacking(context, sourceContext, occurrenceWindow);
  context.restore();
  return true;
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
function roundedRectPath(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number, cornerRadii?: CanvasNode["cornerRadii"], cornerSmoothing?: number, beginPath = true) {
  const radii = resolveCornerRadii(width, height, radius, cornerRadii);
  const smoothing = resolveCornerSmoothing(cornerSmoothing);
  if (beginPath) ctx.beginPath();
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
  const effects = maskAlphaPreparationContexts.has(ctx)
    ? activeMaskAlphaEffects(node)
    : activeNodeEffects(node);
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

/** A clipping container owns two distinct paint scopes: its fill/image sits
 * behind descendants, while its stroke remains visible above them. Keeping the
 * split as a presentation-only copy avoids adding a second persisted model. */
function containerFillSourceNode(node: CanvasNode): CanvasNode {
  return {
    ...node,
    strokeWidth: 0,
    strokeWeights: undefined,
    strokeStack: { layers: [] },
  };
}

/** Paints only the outline of a Frame-like owner after its descendants. Rust
 * stroke meshes remain the exact path. The Canvas fallback clips a doubled
 * boundary stroke to the requested inside/outside half so it never repaints
 * the fill or erases already-rendered children. */
function renderContainerStrokeOverlay(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode) {
  if (!hasVisibleStroke(node)) return;
  const point = toScreen(node.x, node.y);
  const width = node.width * viewport.zoom;
  const height = node.height * viewport.zoom;
  const radius = node.radius * viewport.zoom;
  ctx.save();
  ctx.globalAlpha = node.opacity;
  ctx.globalCompositeOperation = canvasCompositeMode(node.blendMode);
  if (!applyNativeAffine(ctx, node)) {
    ctx.translate(point.x + width / 2, point.y + height / 2);
    ctx.rotate(node.rotation * Math.PI / 180);
    ctx.translate(-width / 2, -height / 2);
  }
  applyStrokeStyle(ctx, node);
  if (node.strokeWeights?.length === 4) {
    const meshes = canonicalPerSideRectangleStrokeMeshes(node, width, height);
    if (meshes) {
      if ((node.strokeAlign ?? "inside") === "inside") {
        ctx.save();
        roundedRectPath(ctx, 0, 0, width, height, radius, node.cornerRadii, node.cornerSmoothing);
        ctx.clip();
        meshes.forEach((mesh) => fillCanonicalStrokeMesh(ctx, node, mesh, width, height));
        ctx.restore();
      } else meshes.forEach((mesh) => fillCanonicalStrokeMesh(ctx, node, mesh, width, height));
    } else renderPerSideStroke(ctx, node, width, height, radius);
    ctx.restore();
    return;
  }
  const mesh = canonicalRectangleStrokeMesh(node, width, height);
  if (mesh) {
    fillCanonicalStrokeMesh(ctx, node, mesh, width, height);
    ctx.restore();
    return;
  }
  const strokeWidth = Math.max(1, node.strokeWidth * viewport.zoom);
  const align = node.strokeAlign ?? "inside";
  if (align !== "center") {
    ctx.save();
    ctx.beginPath();
    if (align === "outside") {
      const extent = Math.max(width, height, strokeWidth) * 4 + 16;
      ctx.rect(-extent, -extent, width + extent * 2, height + extent * 2);
      roundedRectPath(ctx, 0, 0, width, height, radius, node.cornerRadii, node.cornerSmoothing, false);
      ctx.clip("evenodd");
    } else {
      roundedRectPath(ctx, 0, 0, width, height, radius, node.cornerRadii, node.cornerSmoothing);
      ctx.clip();
    }
    roundedRectPath(ctx, 0, 0, width, height, radius, node.cornerRadii, node.cornerSmoothing);
    ctx.lineWidth = strokeWidth * 2;
    strokePaintStack(ctx, node, width, height);
    ctx.restore();
  } else {
    roundedRectPath(ctx, 0, 0, width, height, radius, node.cornerRadii, node.cornerSmoothing);
    ctx.lineWidth = strokeWidth;
    strokePaintStack(ctx, node, width, height);
  }
  ctx.restore();
}

function canvasCompositeMode(mode: CanvasNode["blendMode"]): GlobalCompositeOperation {
  return mode && mode !== "normal" && mode !== "pass-through" && !isLinearBlendMode(mode) ? mode : "source-over";
}

function surfaceCompositeMode(mode: CanvasNode["blendMode"]): GlobalCompositeOperation | LinearBlendMode {
  return isLinearBlendMode(mode) ? mode : canvasCompositeMode(mode);
}

function surfaceBytes(surface: OffscreenCanvas) {
  return surface.width * surface.height * 4;
}

function allocatedCompositeSurfaceBytes() {
  return (effectSurfaces ? surfaceBytes(effectSurfaces.source) * 3 : 0)
    + alphaMaskSurfaces.reduce((total, pool) => total + (pool ? surfaceBytes(pool.target) * 2 : 0), 0)
    + subtreeCompositeSurfaces.reduce((total, pool) => total + (pool ? surfaceBytes(pool.source) * 3 : 0), 0)
    + (canvasFallbackSurface ? surfaceBytes(canvasFallbackSurface.surface) : 0);
}

function admitAdditionalCompositeSurfaces(pixelWidth: number, pixelHeight: number, additionalSurfaces: number, replacingBytes = 0) {
  if (!canvas) return { accepted: false as const, reason: "invalidDimensions" as const };
  const admission = admitCompositeSurfaceBytes(
    Math.max(0, allocatedCompositeSurfaceBytes() - replacingBytes),
    pixelWidth,
    pixelHeight,
    additionalSurfaces,
  );
  if (!admission.accepted && !compositeSurfaceLimitReported) {
    diagnostics.record({ category: "renderer", code: `COMPOSITE_SURFACE_${admission.reason.toUpperCase()}`, documentRevision: revision });
    compositeSurfaceLimitReported = true;
  }
  return admission;
}

function acquireEffectSurfaces(window: Pick<CompositeSurfaceWindow, "pixelWidth" | "pixelHeight">): EffectSurfaces | undefined {
  if (!canvas) return undefined;
  if (effectSurfaces && effectSurfaces.source.width >= window.pixelWidth && effectSurfaces.source.height >= window.pixelHeight) return effectSurfaces;
  const pixelWidth = Math.max(effectSurfaces?.source.width ?? 0, window.pixelWidth);
  const pixelHeight = Math.max(effectSurfaces?.source.height ?? 0, window.pixelHeight);
  const replacedBytes = effectSurfaces ? surfaceBytes(effectSurfaces.source) * 3 : 0;
  const admission = admitAdditionalCompositeSurfaces(pixelWidth, pixelHeight, 3, replacedBytes);
  if (!admission.accepted) {
    if (!effectSurfaceLimitReported) {
      diagnostics.record({ category: "renderer", code: `EFFECT_SURFACE_${admission.reason.toUpperCase()}`, documentRevision: revision });
      effectSurfaceLimitReported = true;
    }
    return undefined;
  }
  const source = new OffscreenCanvas(pixelWidth, pixelHeight);
  const shadow = new OffscreenCanvas(pixelWidth, pixelHeight);
  const scratch = new OffscreenCanvas(pixelWidth, pixelHeight);
  const sourceContext = source.getContext("2d");
  const shadowContext = shadow.getContext("2d");
  const scratchContext = scratch.getContext("2d");
  if (!sourceContext || !shadowContext || !scratchContext) return undefined;
  effectSurfaces = { source, sourceContext, shadow, shadowContext, scratch, scratchContext };
  return effectSurfaces;
}

function acquireCanvasFallbackSurface(window: Pick<CompositeSurfaceWindow, "pixelWidth" | "pixelHeight">): CanvasFallbackSurface | undefined {
  if (!canvas) return undefined;
  const existing = canvasFallbackSurface;
  if (existing && existing.surface.width >= window.pixelWidth && existing.surface.height >= window.pixelHeight) return existing;
  const pixelWidth = Math.max(existing?.surface.width ?? 0, window.pixelWidth);
  const pixelHeight = Math.max(existing?.surface.height ?? 0, window.pixelHeight);
  const replacedBytes = existing ? surfaceBytes(existing.surface) : 0;
  if (!admitAdditionalCompositeSurfaces(pixelWidth, pixelHeight, 1, replacedBytes).accepted) return undefined;
  try {
    const surface = new OffscreenCanvas(pixelWidth, pixelHeight);
    const context = surface.getContext("2d", { alpha: true });
    if (!context) return undefined;
    canvasFallbackSurface = { surface, context };
    return canvasFallbackSurface;
  } catch {
    return undefined;
  }
}

/** Captures the destination window before painting the island. Rendering on
 * this opaque backing avoids a second alpha blend for curved edges and also
 * freezes the exact previous-islands input required by blend/background blur. */
function prepareCanvasFallbackSurface(
  acquired: CanvasFallbackSurface,
  destination: OffscreenCanvasRenderingContext2D,
  window: CompositeSurfaceWindow,
) {
  acquired.context.setTransform(1, 0, 0, 1, 0, 0);
  acquired.context.clearRect(0, 0, acquired.surface.width, acquired.surface.height);
  acquired.context.drawImage(
    destination.canvas,
    window.pixelX,
    window.pixelY,
    window.pixelWidth,
    window.pixelHeight,
    0,
    0,
    window.pixelWidth,
    window.pixelHeight,
  );
  setCompositeSurfaceTransform(acquired.context, window);
  compositeContextWindows.set(acquired.context, window);
}

function materializeCanvasIsland(
  destination: OffscreenCanvasRenderingContext2D,
  islandNodes: readonly CanvasNode[],
  dragPreviewRootIds: ReadonlySet<string>,
) {
  const window = compositeWindowForBounds(combinedWorldCompositeBounds(islandNodes));
  if (!window) return false;
  const acquired = acquireCanvasFallbackSurface(window);
  if (!acquired) return false;
  let bitmap: ImageBitmap;
  try {
    prepareCanvasFallbackSurface(acquired, destination, window);
    renderFrameClippedTree(acquired.context, islandNodes, dragPreviewRootIds);
    bitmap = acquired.surface.transferToImageBitmap();
  } catch {
    return false;
  }
  try {
    destination.save();
    try {
      destination.globalAlpha = 1;
      destination.globalCompositeOperation = "source-over";
      destination.drawImage(
        bitmap,
        0,
        0,
        window.pixelWidth,
        window.pixelHeight,
        window.x,
        window.y,
        window.width,
        window.height,
      );
    } finally {
      destination.restore();
    }
  } finally {
    bitmap.close();
  }
  return true;
}

/** Builds the spread-adjusted SourceAlpha mask used by the Canvas shadow pass.
 * This is deliberately separate from `ctx.filter`: Canvas exposes blur but no
 * morphology, while Figma spread must alter alpha before blur and offset. */
function renderSpreadAlphaMask(context: OffscreenCanvasRenderingContext2D, source: OffscreenCanvas, spread: number, window: CompositeSurfaceWindow) {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.drawImage(source, 0, 0, window.pixelWidth, window.pixelHeight, 0, 0, window.pixelWidth, window.pixelHeight);
  if (!Number.isFinite(spread) || spread === 0) {
    setCompositeSurfaceTransform(context, window);
    return;
  }
  try {
    const pixels = context.getImageData(0, 0, window.pixelWidth, window.pixelHeight);
    const alpha = new Uint8ClampedArray(window.pixelWidth * window.pixelHeight);
    for (let index = 0; index < alpha.length; index += 1) alpha[index] = pixels.data[index * 4 + 3];
    const morphed = morphAlphaChannel(alpha, window.pixelWidth, window.pixelHeight, spread);
    for (let index = 0; index < morphed.length; index += 1) {
      const pixel = index * 4;
      pixels.data[pixel] = 255;
      pixels.data[pixel + 1] = 255;
      pixels.data[pixel + 2] = 255;
      pixels.data[pixel + 3] = morphed[index];
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.putImageData(pixels, 0, 0);
    setCompositeSurfaceTransform(context, window);
  } catch {
    // Tainted or resource-constrained canvas input remains on the established
    // blur-only path; the editable document is never modified for rendering.
  }
  setCompositeSurfaceTransform(context, window);
}

/** A viewport-sized alpha buffer ends at the camera edge, which is not
 * necessarily the shape's edge. Keep simple inset shadows near their actual
 * contour so magnifying a large background cannot add a border to the view. */
function clipInnerShadowToShape(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, shadow: NonNullable<CanvasNode["dropShadow"]>, window: CompositeSurfaceWindow) {
  if ((!isFrameLike(node) && node.kind !== "rectangle") || node.assetId || node.cornerSmoothing || node.opacity !== 1 ||
      (hasVisibleStroke(node) && (node.strokeAlign ?? "inside") !== "inside") ||
      orderedEffects(node).some((effect) => effect.layerBlur?.visible || effect.backgroundBlur?.visible)) return false;
  const hasOpaqueFill = activeFills(node).some((paint) => paint.gradient
    ? paint.gradient.stops.length > 0 && paint.gradient.stops.every((stop) => stop.color.alpha === 1)
    : paint.gradientPaint
      ? paint.gradientPaint.stops.length > 0 && paint.gradientPaint.stops.every((stop) => stop.color.alpha === 1)
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
  setCompositeSurfaceTransform(ctx, window);
  return true;
}

/** Composites ordered Drop Shadows from a reusable source/shadow surface pair.
 * The source is painted once, every tinted/blurred shadow is composited behind
 * it, and the source is finally drawn exactly once to avoid alpha darkening. */
function renderNodeWithEffects(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, effects: readonly NonNullable<CanvasNode["effectStack"]>[number][]) {
  if (node.visible === false || node.kind === "group" || node.kind === "slice") return;
  const repeatedSource = isPreparingRepeatedSource(ctx);
  const window = effectSurfaceWindowForNode(node, ctx);
  if (!window) return;
  const occurrenceWindow = repeatBackgroundBlurWindow(ctx, window, effects);
  const surfaces = acquireEffectSurfaces(compositePoolDimensionsForWindows(window, occurrenceWindow));
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
  let sourceWindow = window;
  let materializedOccurrence = false;
  sourceContext.save();
  prepareCompositeSurface(sourceContext, source, window);
  withRepeatSourcePreparation(sourceContext, repeatedSource, () => renderNodePaint(sourceContext, node));
  sourceContext.restore();
  for (const effect of effects) {
    const effectWindow = sourceWindow;
    targetContext.save();
    prepareCompositeSurface(targetContext, target, effectWindow);
    if (effect.layerBlur) {
      if (!effect.layerBlur.visible || effect.layerBlur.radius <= 0) { drawCompositeSurface(targetContext, source, effectWindow); }
      else { targetContext.filter = `blur(${effect.layerBlur.radius * viewport.zoom}px)`; drawCompositeSurface(targetContext, source, effectWindow); }
    } else if (effect.dropShadow) {
      const shadow = effect.dropShadow;
      if (shadow.visible && shadow.color.alpha > 0) {
        renderSpreadAlphaMask(targetContext, source, shadow.spread * viewport.zoom * dpr, effectWindow);
        const scratch = surfaces.scratch;
        const scratchContext = surfaces.scratchContext;
        const offset = repeatOccurrenceEffectOffset(
          ctx,
          shadow.offsetX * viewport.zoom,
          shadow.offsetY * viewport.zoom,
          materializedOccurrence,
        );
        scratchContext.save();
        prepareCompositeSurface(scratchContext, scratch, effectWindow);
        scratchContext.filter = `blur(${Math.max(0, shadow.blurRadius) * viewport.zoom}px)`;
        drawCompositeSurface(scratchContext, target, effectWindow, offset.x, offset.y);
        scratchContext.filter = "none";
        scratchContext.globalCompositeOperation = "source-in";
        scratchContext.fillStyle = colorToSrgbCss(shadow.color);
        scratchContext.fillRect(effectWindow.x, effectWindow.y, effectWindow.width, effectWindow.height);
        scratchContext.restore();
        prepareCompositeSurface(targetContext, target, effectWindow);
        drawCompositeSurface(targetContext, scratch, effectWindow);
      }
      // The blurred, tinted alpha is already in `target`. Put the untouched
      // source *over* it: `destination-over` puts the source behind the
      // shadow and lets blur visible beneath the fill read as an inner shadow
      // whenever Frame clipping selects this Canvas renderer path.
      targetContext.globalCompositeOperation = "source-over";
      drawCompositeSurface(targetContext, source, effectWindow);
    } else if (effect.innerShadow) {
      const shadow = effect.innerShadow;
      if (shadow.visible && shadow.color.alpha > 0) {
        // An inset shadow shades the gap around an offset alpha mask. Positive
        // spread shrinks that mask, widening the inner edge in device pixels.
        renderSpreadAlphaMask(targetContext, source, -shadow.spread * viewport.zoom * dpr, effectWindow);
        const scratch = surfaces.scratch;
        const scratchContext = surfaces.scratchContext;
        const offset = repeatOccurrenceEffectOffset(
          ctx,
          shadow.offsetX * viewport.zoom,
          shadow.offsetY * viewport.zoom,
          materializedOccurrence,
        );
        scratchContext.save();
        prepareCompositeSurface(scratchContext, scratch, effectWindow);
        scratchContext.filter = `blur(${Math.max(0, shadow.blurRadius) * viewport.zoom}px)`;
        drawCompositeSurface(scratchContext, target, effectWindow, offset.x, offset.y);
        scratchContext.filter = "none";
        // Keep the colored complement of the shifted mask, then clip it to
        // the source. Intersecting both masks instead tints the entire opaque
        // interior (notably turning a white 1px inset into a white overlay).
        scratchContext.globalCompositeOperation = "source-out";
        scratchContext.fillStyle = colorToSrgbCss(shadow.color);
        scratchContext.fillRect(effectWindow.x, effectWindow.y, effectWindow.width, effectWindow.height);
        scratchContext.globalCompositeOperation = "destination-in";
        drawCompositeSurface(scratchContext, source, effectWindow);
        scratchContext.restore();
        // The source pool normally rests at the identity transform.
        sourceContext.save();
        setCompositeSurfaceTransform(sourceContext, effectWindow);
        const clippedToShape = clipInnerShadowToShape(sourceContext, node, shadow, effectWindow);
        compositeEffectSurface(sourceContext, scratch, effectWindow, "source-over", 1, effectWindow, recordCanvasReadbackBytes);
        if (clippedToShape) sourceContext.restore();
        sourceContext.restore();
        prepareCompositeSurface(targetContext, target, effectWindow);
      } else drawCompositeSurface(targetContext, source, effectWindow);
    }
    else if (effect.backgroundBlur) {
      const blur = effect.backgroundBlur;
      const repeatTransform = repeatScreenTransformByContext.get(ctx);
      if (blur.visible && blur.radius > 0 && renderQuality.tier === "settled" && occurrenceWindow && repeatTransform && !materializedOccurrence) {
        materializeRepeatPreparedSurface(
          surfaces.scratchContext,
          surfaces.scratch,
          source,
          sourceWindow,
          occurrenceWindow,
          repeatTransform,
        );
        prepareCompositeSurface(targetContext, target, occurrenceWindow);
        drawCompositeBacking(targetContext, ctx, occurrenceWindow);
        prepareCompositeSurface(sourceContext, source, occurrenceWindow);
        sourceContext.filter = `blur(${blur.radius * viewport.zoom}px)`;
        drawCompositeSurface(sourceContext, target, occurrenceWindow);
        sourceContext.filter = "none";
        sourceContext.globalCompositeOperation = "destination-in";
        drawCompositeSurface(sourceContext, surfaces.scratch, occurrenceWindow);
        sourceContext.globalCompositeOperation = "source-over";
        drawCompositeSurface(sourceContext, surfaces.scratch, occurrenceWindow);
        prepareCompositeSurface(targetContext, target, occurrenceWindow);
        drawCompositeSurface(targetContext, source, occurrenceWindow);
        sourceWindow = occurrenceWindow;
        materializedOccurrence = true;
      } else if (blur.visible && blur.radius > 0 && renderQuality.tier === "settled") {
        drawCompositeBacking(targetContext, ctx, effectWindow);
        const scratchContext = surfaces.scratchContext;
        scratchContext.save();
        prepareCompositeSurface(scratchContext, surfaces.scratch, effectWindow);
        scratchContext.filter = `blur(${blur.radius * viewport.zoom}px)`;
        drawCompositeSurface(scratchContext, target, effectWindow);
        scratchContext.filter = "none";
        scratchContext.globalCompositeOperation = "destination-in";
        drawCompositeSurface(scratchContext, source, effectWindow);
        scratchContext.globalCompositeOperation = "source-over";
        drawCompositeSurface(scratchContext, source, effectWindow);
        scratchContext.restore();
        prepareCompositeSurface(targetContext, target, effectWindow);
        drawCompositeSurface(targetContext, surfaces.scratch, effectWindow);
      } else {
        // Background blur samples the complete backing store. During a zoom or
        // pan gesture that full-surface filter is immediately obsolete and can
        // dominate the frame budget. Keep the source visible while interacting;
        // scheduleSettledRenderQuality restores the exact blur after 160 ms.
        drawCompositeSurface(targetContext, source, effectWindow);
      }
    }
    targetContext.restore();
    if (!effect.innerShadow || !effect.innerShadow.visible || effect.innerShadow.color.alpha <= 0) {
      [source, target] = [target, source];
      [sourceContext, targetContext] = [targetContext, sourceContext];
    }
  }
  const composited = materializedOccurrence
    ? compositeMaterializedOccurrence(ctx, source, sourceWindow, canvasCompositeMode(node.blendMode))
    : compositePreparedSurface(ctx, source, sourceWindow, canvasCompositeMode(node.blendMode));
  if (!composited)
    diagnostics.record({ category: "renderer", code: "REPEAT_BACKGROUND_BLUR_COMPOSITE_FAILED", documentRevision: revision, details: { nodeId: node.id } });
}

function acquireSubtreeCompositeSurfaces(depth: number, window: Pick<CompositeSurfaceWindow, "pixelWidth" | "pixelHeight">): SubtreeCompositeSurfaces | undefined {
  if (!canvas) return undefined;
  const existing = subtreeCompositeSurfaces[depth];
  if (existing && existing.source.width >= window.pixelWidth && existing.source.height >= window.pixelHeight) return existing;
  const pixelWidth = Math.max(existing?.source.width ?? 0, window.pixelWidth);
  const pixelHeight = Math.max(existing?.source.height ?? 0, window.pixelHeight);
  const admission = depth >= MAX_SUBTREE_COMPOSITE_NESTING
    ? { accepted: false as const, reason: "nesting" as const }
    : admitSubtreeCompositeSurfacePool(pixelWidth, pixelHeight, 0);
  if (!admission.accepted) {
    if (!subtreeCompositeLimitReported) {
      diagnostics.record({ category: "renderer", code: `SUBTREE_COMPOSITE_${admission.reason.toUpperCase()}_LIMIT`, documentRevision: revision });
      subtreeCompositeLimitReported = true;
    }
    return undefined;
  }
  const replacedBytes = existing ? surfaceBytes(existing.source) * 3 : 0;
  if (!admitAdditionalCompositeSurfaces(pixelWidth, pixelHeight, 3, replacedBytes).accepted) return undefined;
  const source = new OffscreenCanvas(pixelWidth, pixelHeight);
  const shadow = new OffscreenCanvas(pixelWidth, pixelHeight);
  const scratch = new OffscreenCanvas(pixelWidth, pixelHeight);
  const sourceContext = source.getContext("2d");
  const shadowContext = shadow.getContext("2d");
  const scratchContext = scratch.getContext("2d");
  if (!sourceContext || !shadowContext || !scratchContext) return undefined;
  const acquired = { source, sourceContext, shadow, shadowContext, scratch, scratchContext };
  subtreeCompositeSurfaces[depth] = acquired;
  return acquired;
}

/** Applies one container's ordered presentation stack to an already rendered
 * source subtree. Descendant effects have finished before this function runs,
 * so the owner opacity and blend are applied exactly once at the exit edge. */
function compositePreparedSubtree(
  destination: OffscreenCanvasRenderingContext2D,
  node: CanvasNode,
  surfaces: SubtreeCompositeSurfaces,
  window: CompositeSurfaceWindow,
  initiallyMaterializedOccurrence = false,
) {
  const ownerEffects = renderQuality.tier === "interactive"
    ? []
    : maskAlphaPreparationContexts.has(destination)
      ? activeMaskAlphaEffects(node)
      : activeNodeEffects(node);
  let source = surfaces.source;
  let sourceContext = surfaces.sourceContext;
  let target = surfaces.shadow;
  let targetContext = surfaces.shadowContext;
  let sourceWindow = window;
  let materializedOccurrence = initiallyMaterializedOccurrence;
  const occurrenceWindow = initiallyMaterializedOccurrence
    ? undefined
    : repeatBackgroundBlurWindow(destination, window, ownerEffects);
  for (const effect of ownerEffects) {
    const effectWindow = sourceWindow;
    targetContext.save();
    prepareCompositeSurface(targetContext, target, effectWindow);
    if (effect.layerBlur) {
      targetContext.filter = `blur(${effect.layerBlur.radius * viewport.zoom}px)`;
      drawCompositeSurface(targetContext, source, effectWindow);
      targetContext.filter = "none";
    } else if (effect.dropShadow) {
      const shadow = effect.dropShadow;
      renderSpreadAlphaMask(targetContext, source, shadow.spread * viewport.zoom * dpr, effectWindow);
      const scratchContext = surfaces.scratchContext;
      const offset = repeatOccurrenceEffectOffset(
        destination,
        shadow.offsetX * viewport.zoom,
        shadow.offsetY * viewport.zoom,
        materializedOccurrence,
      );
      scratchContext.save();
      prepareCompositeSurface(scratchContext, surfaces.scratch, effectWindow);
      scratchContext.filter = `blur(${Math.max(0, shadow.blurRadius) * viewport.zoom}px)`;
      drawCompositeSurface(scratchContext, target, effectWindow, offset.x, offset.y);
      scratchContext.filter = "none";
      scratchContext.globalCompositeOperation = "source-in";
      scratchContext.fillStyle = colorToSrgbCss(shadow.color);
      scratchContext.fillRect(effectWindow.x, effectWindow.y, effectWindow.width, effectWindow.height);
      scratchContext.restore();
      prepareCompositeSurface(targetContext, target, effectWindow);
      drawCompositeSurface(targetContext, surfaces.scratch, effectWindow);
      targetContext.globalCompositeOperation = "source-over";
      drawCompositeSurface(targetContext, source, effectWindow);
    } else if (effect.innerShadow) {
      const shadow = effect.innerShadow;
      renderSpreadAlphaMask(targetContext, source, -shadow.spread * viewport.zoom * dpr, effectWindow);
      const scratchContext = surfaces.scratchContext;
      const offset = repeatOccurrenceEffectOffset(
        destination,
        shadow.offsetX * viewport.zoom,
        shadow.offsetY * viewport.zoom,
        materializedOccurrence,
      );
      scratchContext.save();
      prepareCompositeSurface(scratchContext, surfaces.scratch, effectWindow);
      scratchContext.filter = `blur(${Math.max(0, shadow.blurRadius) * viewport.zoom}px)`;
      drawCompositeSurface(scratchContext, target, effectWindow, offset.x, offset.y);
      scratchContext.filter = "none";
      scratchContext.globalCompositeOperation = "source-out";
      scratchContext.fillStyle = colorToSrgbCss(shadow.color);
      scratchContext.fillRect(effectWindow.x, effectWindow.y, effectWindow.width, effectWindow.height);
      scratchContext.globalCompositeOperation = "destination-in";
      drawCompositeSurface(scratchContext, source, effectWindow);
      scratchContext.restore();
      sourceContext.save();
      setCompositeSurfaceTransform(sourceContext, effectWindow);
      compositeEffectSurface(sourceContext, surfaces.scratch, effectWindow, "source-over", 1, effectWindow, recordCanvasReadbackBytes);
      sourceContext.restore();
      prepareCompositeSurface(targetContext, target, effectWindow);
    } else if (effect.backgroundBlur) {
      const repeatTransform = repeatScreenTransformByContext.get(destination);
      if (occurrenceWindow && repeatTransform && !materializedOccurrence) {
        materializeRepeatPreparedSurface(
          surfaces.scratchContext,
          surfaces.scratch,
          source,
          sourceWindow,
          occurrenceWindow,
          repeatTransform,
        );
        prepareCompositeSurface(targetContext, target, occurrenceWindow);
        drawCompositeBacking(targetContext, destination, occurrenceWindow);
        prepareCompositeSurface(sourceContext, source, occurrenceWindow);
        sourceContext.filter = `blur(${effect.backgroundBlur.radius * viewport.zoom}px)`;
        drawCompositeSurface(sourceContext, target, occurrenceWindow);
        sourceContext.filter = "none";
        sourceContext.globalCompositeOperation = "destination-in";
        drawCompositeSurface(sourceContext, surfaces.scratch, occurrenceWindow);
        sourceContext.globalCompositeOperation = "source-over";
        drawCompositeSurface(sourceContext, surfaces.scratch, occurrenceWindow);
        prepareCompositeSurface(targetContext, target, occurrenceWindow);
        drawCompositeSurface(targetContext, source, occurrenceWindow);
        sourceWindow = occurrenceWindow;
        materializedOccurrence = true;
      } else {
        drawCompositeBacking(targetContext, destination, effectWindow);
        const scratchContext = surfaces.scratchContext;
        scratchContext.save();
        prepareCompositeSurface(scratchContext, surfaces.scratch, effectWindow);
        scratchContext.filter = `blur(${effect.backgroundBlur.radius * viewport.zoom}px)`;
        drawCompositeSurface(scratchContext, target, effectWindow);
        scratchContext.filter = "none";
        scratchContext.globalCompositeOperation = "destination-in";
        drawCompositeSurface(scratchContext, source, effectWindow);
        scratchContext.globalCompositeOperation = "source-over";
        drawCompositeSurface(scratchContext, source, effectWindow);
        scratchContext.restore();
        prepareCompositeSurface(targetContext, target, effectWindow);
        drawCompositeSurface(targetContext, surfaces.scratch, effectWindow);
      }
    }
    targetContext.restore();
    if (!effect.innerShadow) {
      [source, target] = [target, source];
      [sourceContext, targetContext] = [targetContext, sourceContext];
    }
  }
  const composited = materializedOccurrence
    ? compositeMaterializedOccurrence(destination, source, sourceWindow, surfaceCompositeMode(node.blendMode), node.opacity)
    : compositePreparedSurface(destination, source, sourceWindow, surfaceCompositeMode(node.blendMode), node.opacity);
  if (!composited)
    diagnostics.record({ category: "renderer", code: materializedOccurrence ? "REPEAT_BACKGROUND_BLUR_COMPOSITE_FAILED" : "LINEAR_BLEND_READBACK_FAILED", documentRevision: revision, details: { nodeId: node.id } });
}

type PreparedCanvasTextGlyph = Readonly<{
  surface: OffscreenCanvas;
  pose: NonNullable<ReturnType<typeof canvasTextGlyphPose>>;
}>;

function canvasTextGlyphSurfaceKey(glyph: WebGpuTextGlyph) {
  return JSON.stringify([glyph.textureKey, glyph.fill]);
}

/**
 * Resolves every surface before drawing so a failed color/resource/budget
 * check falls back for the whole TextPath instead of publishing half a word.
 * Map insertion order is the LRU; resources needed by this node are protected
 * while unrelated older entries are evicted.
 */
function prepareCanvasTextGlyphs(glyphs: readonly WebGpuTextGlyph[]): PreparedCanvasTextGlyph[] | undefined {
  const requiredKeys = new Set(glyphs.map(canvasTextGlyphSurfaceKey));
  const poses = glyphs.map((glyph) => canvasTextGlyphPose(glyph));
  if (poses.some((pose) => !pose)) return undefined;
  const missing = new Map<string, WebGpuTextGlyph>();
  glyphs.forEach((glyph) => {
    const key = canvasTextGlyphSurfaceKey(glyph);
    const cached = canvasTextGlyphSurfaces.get(key);
    if (cached?.surface.width === glyph.maskWidth && cached.surface.height === glyph.maskHeight) return;
    if (cached) {
      canvasTextGlyphSurfaces.delete(key);
      canvasTextGlyphSurfaceBytes -= cached.bytes;
    }
    missing.set(key, glyph);
  });
  const missingBytes = [...missing.values()].reduce((total, glyph) => {
    const bytes = canvasTextGlyphSurfaceByteLength(glyph);
    return bytes === undefined ? Number.POSITIVE_INFINITY : total + bytes;
  }, 0);
  while (canvasTextGlyphSurfaceBytes + missingBytes > MAX_CANVAS_TEXT_GLYPH_SURFACE_BYTES) {
    const oldest = [...canvasTextGlyphSurfaces].find(([key]) => !requiredKeys.has(key));
    if (!oldest) {
      if (!canvasTextGlyphLimitReported) {
        canvasTextGlyphLimitReported = true;
        diagnostics.record({
          category: "renderer",
          code: "CANVAS_TEXT_GLYPH_CACHE_LIMIT",
          documentRevision: revision,
          details: {
            residentBytes: canvasTextGlyphSurfaceBytes,
            requiredBytes: missingBytes,
            limitBytes: MAX_CANVAS_TEXT_GLYPH_SURFACE_BYTES,
          },
        });
      }
      return undefined;
    }
    canvasTextGlyphSurfaces.delete(oldest[0]);
    canvasTextGlyphSurfaceBytes -= oldest[1].bytes;
  }
  for (const [key, glyph] of missing) {
    const bitmap = canvasTextGlyphBitmap(glyph);
    if (!bitmap) return undefined;
    const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = surface.getContext("2d");
    if (!context) return undefined;
    const image = context.createImageData(bitmap.width, bitmap.height);
    image.data.set(bitmap.rgba);
    context.putImageData(image, 0, 0);
    const bytes = bitmap.rgba.byteLength;
    canvasTextGlyphSurfaces.set(key, { surface, bytes });
    canvasTextGlyphSurfaceBytes += bytes;
  }
  const prepared = glyphs.map((glyph, index) => {
    const key = canvasTextGlyphSurfaceKey(glyph);
    const cached = canvasTextGlyphSurfaces.get(key);
    if (!cached) return undefined;
    canvasTextGlyphSurfaces.delete(key);
    canvasTextGlyphSurfaces.set(key, cached);
    return { surface: cached.surface, pose: poses[index]! };
  });
  if (prepared.some((item) => !item)) return undefined;
  canvasTextGlyphLimitReported = false;
  return prepared as PreparedCanvasTextGlyph[];
}

function renderShapedCanvasTextPath(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode) {
  const cached = rustTextGlyphs.get(node.id);
  if (!cached || cached.revision !== revision) return false;
  const prepared = prepareCanvasTextGlyphs(cached.canvasGlyphs ?? cached.glyphs);
  if (!prepared) return false;
  prepared.forEach(({ surface, pose }) => {
    ctx.save();
    ctx.translate(pose.centerX * viewport.zoom, pose.centerY * viewport.zoom);
    ctx.rotate(pose.rotationRadians);
    ctx.globalAlpha = pose.opacity;
    ctx.drawImage(
      surface,
      -pose.width * viewport.zoom / 2,
      -pose.height * viewport.zoom / 2,
      pose.width * viewport.zoom,
      pose.height * viewport.zoom,
    );
    ctx.restore();
  });
  return true;
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
    const connectorPath = node.kind === "connector" ? connectorPathForNode(node, { nodes, defaultPageId, nodeById, worldTransformByNodeId: worldTransformById }) : undefined;
    if (connectorPath) {
      const strokeWidth = Math.max(1, node.strokeWidth * viewport.zoom);
      ctx.lineWidth = strokeWidth;
      ctx.lineCap = node.strokeCapStart === node.strokeCapEnd && (node.strokeCapStart === "round" || node.strokeCapStart === "square")
        ? node.strokeCapStart
        : "butt";
      ctx.beginPath();
      traceConnectorPath(ctx, connectorPath, viewport.zoom);
      strokePaintStack(ctx, node, Math.max(w, 1), Math.max(h, 1));
      renderConnectorEndpointDecorations(ctx, node, connectorPath, viewport.zoom, Math.max(w, 1), Math.max(h, 1));
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
        ctx.beginPath();
        outline.forEach((piece) => {
          if (piece.kind === "rect") ctx.rect(piece.x, piece.y, piece.width, piece.height);
          else ctx.arc(piece.x, piece.y, piece.radius, 0, Math.PI * 2);
        });
        fillStrokePaintStack(ctx, node, w, 1);
        renderLineEndpointPaintStack(ctx, node, w, strokeWidth);
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
        renderLineEndpointPaintStack(ctx, node, w, strokeWidth);
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
  const fallbackPaint = activeFills(node)[0];
  const paint = fallbackPaint ? paintStackStyle(ctx, fallbackPaint, w, h) : "transparent";
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
      fillStrokePaintStack(ctx, node, w, h);
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
        fillStrokePaintStack(ctx, node, w, h, "evenodd");
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
    fillPaintStack(ctx, node, w, h, fillRule);
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
      fillStrokePaintStack(ctx, node, w, h);
      ctx.beginPath(); ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      fillPaintStack(ctx, node, w, h);
    } else if (hasVisibleStroke(node) && align === "center") {
      fillPaintStack(ctx, node, w, h);
      ctx.lineWidth = Math.max(1, node.strokeWidth * viewport.zoom);
      strokePaintStack(ctx, node, w, h);
    } else if (hasVisibleStroke(node) && geometry.insideStrokeWidth > 0) {
      fillStrokePaintStack(ctx, node, w, h);
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
    const lineHeight = resolvedTextLineHeight(node.textProperties, 31) * viewport.zoom;
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
      fillStack: primaryStyle.fillStack,
      textCase: primaryStyle.textCase,
      textDecoration: primaryStyle.textDecoration,
      textDecorationStyle: primaryStyle.textDecorationStyle,
      textDecorationOffset: primaryStyle.textDecorationOffset,
      textDecorationThickness: primaryStyle.textDecorationThickness,
      textDecorationColor: primaryStyle.textDecorationColor,
      textDecorationSkipInk: primaryStyle.textDecorationSkipInk,
      leadingTrim: primaryStyle.leadingTrim,
    } : { fontSize: 31, fontWeight: canvasDesignTokens.typography.canvasText.weight, italic: false, letterSpacing: 0 };
    ctx.fillStyle = paint;
    applyCanvasTextStyle(ctx, primaryRenderStyle, fallbackFonts);
    const listMarkerGutter = textListMarkerGutterForProperties(source, node.textProperties, (value) => ctx.measureText(value).width);
    const listMarkerGap = listMarkerGutter > 0 ? Math.max(0, ctx.measureText(" ").width) : 0;
    // CSS line boxes center the font's bounding ascent/descent inside the
    // declared line-height. Canvas' `middle` baseline uses a different em-box
    // convention, which was visibly a few pixels above the textarea glyphs.
    // Draw against an explicit alphabetic baseline instead.
    ctx.textBaseline = "alphabetic";
    ctx.save();
    const hangingMarkerClip = node.textProperties?.paragraph.hangingList ? listMarkerGutter : 0;
    const hangingPunctuationClip = node.textProperties?.paragraph.hangingPunctuation ? fontSize : 0;
    ctx.beginPath();
    ctx.rect(-hangingMarkerClip - hangingPunctuationClip, 0, textMetrics.width + hangingMarkerClip + hangingPunctuationClip * 2, textMetrics.height);
    ctx.clip();
    const shapedLayout = rustTextLayoutFor(node);
    const lines = shapedLayout
      ? shapedLayout.lines.map((line) => ({ ...line, text: new TextDecoder().decode(sourceBytes.slice(line.start, line.end)) }))
      : layoutTextRanges({
        text: source,
        maxWidth: Math.max(1, textMetrics.width),
        firstLineIndent: (_index, start) => textParagraphIndentAt(node.textProperties, start) * viewport.zoom + textListMarkerBaseIndent(node.textProperties, listMarkerGutter, start),
        paragraphIndent: (_index, start) => textListIndentationOffset(source, node.textProperties, start, listMarkerGutter),
        wrapStyle: (_index, start) => textParagraphWrapStyleAt(node.textProperties, start),
        hangingPunctuation: node.textProperties?.paragraph.hangingPunctuation ?? false,
        measure: (value) => ctx.measureText(value).width,
        measureRange: (start, end) => measureStyledTextRange(ctx, source, start, end, node.textProperties, primaryRenderStyle, fallbackFonts),
      });
    const displayLines = textDisplayLines(
      source,
      lines,
      node.textProperties,
      textMetrics.height,
      (paragraphStart) => resolvedTextLineHeightAt(node.textProperties, paragraphStart, 31) * viewport.zoom,
      (previousStart, nextStart) => textParagraphGap(node.textProperties, previousStart, nextStart) * viewport.zoom,
    );
    let previousLineEnd = 0;
    let paragraphIndex = 0;
    displayLines.forEach((line, lineIndex) => {
      const skippedBeforeLine = new TextDecoder().decode(sourceBytes.slice(previousLineEnd, line.start));
      const isParagraphFirstLine = textLineStartsParagraph(lineIndex, skippedBeforeLine);
      if (lineIndex > 0 && isParagraphFirstLine) paragraphIndex += 1;
      const paragraphStart = textParagraphStartAtOffset(source, line.start);
      const listType = textParagraphListTypeAt(node.textProperties, paragraphStart);
      const nestingIndent = textListIndentationOffset(source, node.textProperties, line.start, listMarkerGutter);
      const lineIndent = nestingIndent + (isParagraphFirstLine
        ? textParagraphIndentAt(node.textProperties, paragraphStart) * viewport.zoom + textListMarkerBaseIndent(node.textProperties, listMarkerGutter, paragraphStart)
        : 0);
      const lineBoxWidth = Math.max(0, textMetrics.width - lineIndent);
      applyCanvasTextStyle(ctx, primaryRenderStyle, fallbackFonts);
      const truncated = line.truncateEnding
        ? endingEllipsis(
            line.text,
            lineBoxWidth,
            (value) => ctx.measureText(value).width,
            (_retained, retainedUtf8Bytes) => measureStyledTextRange(
              ctx,
              source,
              line.start,
              line.start + retainedUtf8Bytes,
              node.textProperties,
              primaryRenderStyle,
              fallbackFonts,
            ) + measureStyledEllipsis(ctx, source, line.start, retainedUtf8Bytes, node.textProperties, primaryRenderStyle, fallbackFonts),
          )
        : undefined;
      const displayEnd = truncated ? line.start + truncated.retainedUtf8Bytes : line.end;
      const spans = styledTextSpans(source, line.start, displayEnd, node.textProperties);
      if (truncated?.text) {
        spans.push({
          text: "…",
          start: displayEnd,
          end: displayEnd,
          style: spans.at(-1)?.style ?? primaryRenderStyle,
        });
      }
      const displayText = truncated?.text ?? line.text;
      const lineY = line.lineTop;
      if (lineY < textMetrics.height) {
        // A CSS line has one shared alphabetic baseline. Measuring each style
        // run separately made a larger CJK/emoji run jump a few pixels from
        // the Latin run when the DOM editor opened.
        applyCanvasTextStyle(ctx, primaryRenderStyle, fallbackFonts);
        const lineBaseline = textLineBox(ctx, lineY, line.lineHeight, primaryRenderStyle.leadingTrim).baseline;
        ctx.direction = line.direction;
        const alignment = node.textProperties?.paragraph.alignment ?? "left";
        if (spans.length <= 1) {
          const style = spans[0]?.style ?? primaryRenderStyle;
          applyCanvasTextStyle(ctx, style, fallbackFonts);
          const spanText = spans[0]?.text ?? displayText;
          const lineWidth = ctx.measureText(spanText).width;
          const hanging = node.textProperties?.paragraph.hangingPunctuation
            ? textHangingPunctuationOffsets(spanText, line.direction, (value) => ctx.measureText(value).width)
            : { left: 0, right: 0 };
          const contentStart = textAlignedLineLeft(lineIndent, lineBoxWidth, lineWidth, alignment, line.direction, hanging);
          if (listType && isParagraphFirstLine) {
            ctx.direction = "ltr";
            ctx.textAlign = "right";
            paintTextSpan(ctx, node, style, textListMarker(listType, paragraphIndex), contentStart - listMarkerGap, lineBaseline, w, h, activeFillLayers(node));
            ctx.direction = line.direction;
            ctx.textAlign = "left";
            paintTextSpan(ctx, node, style, spanText, contentStart, lineBaseline, w, h, activeFillLayers(node));
          } else {
            ctx.textAlign = "left";
            paintTextSpan(ctx, node, style, spanText, contentStart, lineBaseline, w, h, activeFillLayers(node));
          }
        } else {
          const shapedVisualRuns = !truncated && "visualRuns" in line && Array.isArray(line.visualRuns)
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
          applyCanvasTextStyle(ctx, primaryRenderStyle, fallbackFonts);
          const hanging = node.textProperties?.paragraph.hangingPunctuation
            ? textHangingPunctuationOffsets(displayText, line.direction, (value) => ctx.measureText(value).width)
            : { left: 0, right: 0 };
          let x = textAlignedLineLeft(lineIndent, lineBoxWidth, lineWidth, alignment, line.direction, hanging);
          if (listType && isParagraphFirstLine) {
            applyCanvasTextStyle(ctx, spans[0]?.style ?? primaryRenderStyle, fallbackFonts);
            ctx.direction = "ltr";
            ctx.textAlign = "right";
            paintTextSpan(ctx, node, spans[0]?.style ?? primaryRenderStyle, textListMarker(listType, paragraphIndex), x - listMarkerGap, lineBaseline, w, h, activeFillLayers(node));
            ctx.textAlign = "left";
          }
          drawableSpans.forEach((span, index) => {
            applyCanvasTextStyle(ctx, span.style, fallbackFonts);
            ctx.direction = span.direction;
            paintTextSpan(ctx, node, span.style, span.text, x, lineBaseline, w, h, activeFillLayers(node));
            x += measured[index];
          });
        }
      }
      previousLineEnd = line.end;
    });
    ctx.restore();
  } else if (node.kind === "textPath") {
    if (!renderShapedCanvasTextPath(ctx, node)) {
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
          const style: RenderTextStyle = {
            fontSize: node.textProperties?.runs[0]?.fontSize ?? 14,
            fontWeight: node.textProperties?.runs[0]?.fontWeight ?? 400,
            italic: node.textProperties?.runs[0]?.italic ?? false,
            letterSpacing: node.textProperties?.runs[0]?.letterSpacing ?? 0,
            textDecoration: node.textProperties?.runs[0]?.textDecoration,
            textDecorationStyle: node.textProperties?.runs[0]?.textDecorationStyle,
            textDecorationOffset: node.textProperties?.runs[0]?.textDecorationOffset,
            textDecorationThickness: node.textProperties?.runs[0]?.textDecorationThickness,
            textDecorationColor: node.textProperties?.runs[0]?.textDecorationColor,
          };
          if (style.textDecorationColor) {
            paintTextDecorationLayers(ctx, node, style, glyph.text, 0, 0, fontSize, fontSize, []);
          } else {
            paintBasicTextDecoration(ctx, style, glyph.text, 0, 0);
          }
          ctx.restore();
        });
        ctx.restore();
      }
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
      if (node.fillStack) {
        ctx.beginPath();
        ctx.rect(0, 0, w, h);
        fillPaintStack(ctx, node, w, h);
      } else {
        activeFills(node).forEach((layer) => {
          ctx.fillStyle = paintStackStyle(ctx, layer, w, h);
          ctx.fillRect(0, 0, w, h);
        });
      }
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
        fillStrokePaintStack(ctx, node, w, h);
        if (geometry.innerWidth > 0 && geometry.innerHeight > 0) {
          roundedRectPath(ctx, geometry.innerX, geometry.innerY, geometry.innerWidth, geometry.innerHeight, geometry.innerRadius, insetCornerRadii(w, h, geometry.outerRadius, node.cornerRadii, geometry.insideStrokeWidth), node.cornerSmoothing);
          fillPaintStack(ctx, node, w, h);
        }
      }
    } else if (hasVisibleStroke(node) && geometry.insideStrokeWidth > 0) {
      roundedRectPath(ctx, 0, 0, w, h, geometry.outerRadius, node.cornerRadii, node.cornerSmoothing);
      fillStrokePaintStack(ctx, node, w, h);
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
  if (node.kind === "shapeWithText") {
    renderShapeWithTextSublayer(ctx, node, width, height);
    return;
  }
  const fallback = specialNodeFallback(node, "canvas");
  const label = node.kind === "media" ? "▶ Media"
    : node.kind === "embed" ? (node.embedMetadata?.title || node.embedMetadata?.provider || "Embed preview")
      : node.kind === "linkUnfurl" ? (node.linkUnfurlMetadata?.title || node.linkUnfurlMetadata?.provider || "Link preview")
        : node.kind === "interactiveSlideElement" ? `${node.interactiveSlideElementType ?? "Slide"} interaction`
          : node.kind === "textPath" && specialNodeFallback(node, "canvas") ? node.text
            : node.kind === "sticky" || node.kind === "tableCell" ? node.text
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

/** Paints ShapeWithText's live TextSublayer from the same Canonical UTF-8 run
 * records used by ordinary Text. Shape geometry remains owned by the special
 * node path above; only the inset text box is clipped here. */
function renderShapeWithTextSublayer(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, width: number, height: number) {
  const source = node.text ?? "";
  if (!source) return;
  const inset = 10 * viewport.zoom;
  const availableWidth = Math.max(1, width - inset * 2);
  const availableHeight = Math.max(1, height - inset * 2);
  const primary = node.textProperties?.runs[0];
  const primaryStyle: RenderTextStyle = primary ? {
    font: primary.font,
    fontSize: primary.fontSize,
    fontWeight: primary.fontWeight,
    italic: primary.italic,
    letterSpacing: primary.letterSpacing,
    color: primary.color,
    fillStack: primary.fillStack,
    textCase: primary.textCase,
    textDecoration: primary.textDecoration,
    textDecorationStyle: primary.textDecorationStyle,
    textDecorationOffset: primary.textDecorationOffset,
    textDecorationThickness: primary.textDecorationThickness,
    textDecorationColor: primary.textDecorationColor,
    textDecorationSkipInk: primary.textDecorationSkipInk,
    leadingTrim: primary.leadingTrim,
  } : { fontSize: 14, fontWeight: 400, italic: false, letterSpacing: 0 };
  const fallbackFonts = node.textProperties?.fallbackFonts;
  const lineHeight = resolvedTextLineHeight(node.textProperties, 14, 20) * viewport.zoom;
  const alignment = node.textProperties?.paragraph.alignment ?? "center";
  const sourceBytes = new TextEncoder().encode(source);

  ctx.save();
  applyCanvasTextStyle(ctx, primaryStyle, fallbackFonts);
  const listMarkerGutter = textListMarkerGutterForProperties(source, node.textProperties, (value) => ctx.measureText(value).width);
  const listMarkerGap = listMarkerGutter > 0 ? Math.max(0, ctx.measureText(" ").width) : 0;
  ctx.beginPath();
  const hangingMarkerClip = node.textProperties?.paragraph.hangingList && listMarkerGutter > 0
    ? listMarkerGutter
    : 0;
  const hangingPunctuationClip = node.textProperties?.paragraph.hangingPunctuation ? primaryStyle.fontSize * viewport.zoom : 0;
  ctx.rect(inset - hangingMarkerClip - hangingPunctuationClip, inset, availableWidth + hangingMarkerClip + hangingPunctuationClip * 2, availableHeight);
  ctx.clip();
  ctx.textBaseline = "alphabetic";
  const lines = layoutTextRanges({
    text: source,
    maxWidth: availableWidth,
    firstLineIndent: (_index, start) => textParagraphIndentAt(node.textProperties, start) * viewport.zoom + textListMarkerBaseIndent(node.textProperties, listMarkerGutter, start),
    paragraphIndent: (_index, start) => textListIndentationOffset(source, node.textProperties, start, listMarkerGutter),
    wrapStyle: (_index, start) => textParagraphWrapStyleAt(node.textProperties, start),
    hangingPunctuation: node.textProperties?.paragraph.hangingPunctuation ?? false,
    measure: (value) => ctx.measureText(value).width,
    measureRange: (start, end) => measureStyledTextRange(ctx, source, start, end, node.textProperties, primaryStyle, fallbackFonts),
  });
  let paragraphGapTotal = 0;
  let previousEnd = 0;
  let previousParagraphStart = 0;
  for (const line of lines) {
    const skipped = new TextDecoder().decode(sourceBytes.slice(previousEnd, line.start));
    if (/\r\n|[\n\r\u2028\u2029]/u.test(skipped)) {
      const paragraphStart = textParagraphStartAtOffset(source, line.start);
      paragraphGapTotal += textParagraphGap(node.textProperties, previousParagraphStart, paragraphStart) * viewport.zoom;
      previousParagraphStart = paragraphStart;
    }
    previousEnd = line.end;
  }
  const lineHeights = lines.map((line) => resolvedTextLineHeightAt(
    node.textProperties,
    textParagraphStartAtOffset(source, line.start),
    14,
    20,
  ) * viewport.zoom);
  const firstLineBox = textLineBox(ctx, 0, lineHeights[0] ?? lineHeight, primaryStyle.leadingTrim);
  const lastLineBox = textLineBox(ctx, 0, lineHeights.at(-1) ?? lineHeight, primaryStyle.leadingTrim);
  const logicalHeight = Math.max(0, lineHeights.reduce((sum, value) => sum + value, 0) + paragraphGapTotal - firstLineBox.trimStart - lastLineBox.trimEnd);
  let lineTop = inset + Math.max(0, (availableHeight - logicalHeight) / 2);
  previousEnd = 0;
  previousParagraphStart = 0;
  let paragraphIndex = 0;
  for (const [lineIndex, line] of lines.entries()) {
    const skipped = new TextDecoder().decode(sourceBytes.slice(previousEnd, line.start));
    const isParagraphFirstLine = textLineStartsParagraph(lineIndex, skipped);
    const paragraphStart = textParagraphStartAtOffset(source, line.start);
    if (lineIndex > 0 && isParagraphFirstLine) {
      lineTop += textParagraphGap(node.textProperties, previousParagraphStart, paragraphStart) * viewport.zoom;
      previousParagraphStart = paragraphStart;
    }
    if (lineIndex > 0 && isParagraphFirstLine) paragraphIndex += 1;
    const listType = textParagraphListTypeAt(node.textProperties, paragraphStart);
    const spans = styledTextSpans(source, line.start, line.end, node.textProperties);
    const measured = spans.map((span) => {
      applyCanvasTextStyle(ctx, span.style, fallbackFonts);
      return ctx.measureText(span.text).width;
    });
    const lineWidth = measured.reduce((sum, value) => sum + value, 0);
    const nestingIndent = textListIndentationOffset(source, node.textProperties, line.start, listMarkerGutter);
    const lineIndent = nestingIndent + (isParagraphFirstLine
      ? textParagraphIndentAt(node.textProperties, paragraphStart) * viewport.zoom + textListMarkerBaseIndent(node.textProperties, listMarkerGutter, paragraphStart)
      : 0);
    const lineBoxWidth = Math.max(0, availableWidth - lineIndent);
    applyCanvasTextStyle(ctx, primaryStyle, fallbackFonts);
    const hanging = node.textProperties?.paragraph.hangingPunctuation
      ? textHangingPunctuationOffsets(line.text, line.direction, (value) => ctx.measureText(value).width)
      : { left: 0, right: 0 };
    let x = textAlignedLineLeft(inset + lineIndent, lineBoxWidth, lineWidth, alignment, line.direction, hanging);
    const effectiveLineHeight = lineHeights[lineIndex] ?? lineHeight;
    const baseline = textLineBox(ctx, lineTop, effectiveLineHeight, primaryStyle.leadingTrim).baseline;
    if (listType && isParagraphFirstLine) {
      applyCanvasTextStyle(ctx, spans[0]?.style ?? primaryStyle, fallbackFonts);
      ctx.direction = "ltr";
      ctx.textAlign = "right";
      paintTextSpan(ctx, node, spans[0]?.style ?? primaryStyle, textListMarker(listType, paragraphIndex), x - listMarkerGap, baseline, width, height, [{
        visible: true,
        opacity: 1,
        blendMode: "normal",
        paint: { css: "#1f2937" },
      }]);
    }
    for (const [index, span] of spans.entries()) {
      applyCanvasTextStyle(ctx, span.style, fallbackFonts);
      ctx.textAlign = "left";
      paintTextSpan(ctx, node, span.style, span.text, x, baseline, width, height, [{
        visible: true,
        opacity: 1,
        blendMode: "normal",
        paint: { css: "#1f2937" },
      }]);
      x += measured[index] ?? 0;
    }
    lineTop += effectiveLineHeight;
    previousEnd = line.end;
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
  alreadyRenderedNodeIds: ReadonlySet<string> = new Set(),
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
  const subtreeBackgroundBlur = new Map<string, boolean>();
  const canonicalById = new Map(nodes.map((node) => [node.id, node]));
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
    const descendants = children.get(node.id) ?? [];
    const isolated = descendants.length > 0 && requiresSubtreeComposition(node, true);
    let combined = isolated ? worldVisualBoundsForNode(nodes, node) : worldCompositeBoundsForNode(node);
    descendants.forEach((child) => {
      combined = combinedBounds(combined, boundsForSubtree(child));
    });
    if (node.kind === "transformGroup") {
      const canonical = canonicalById.get(node.id);
      const repeatSubtree = canonical ? transformGroupRepeatSubtree(orderedNodes, canonical, children) : undefined;
      const derived = canonical && repeatSubtree ? transformGroupRepeatDerivedBounds(nodes, canonical, repeatSubtree.sources, {
        groupWorld: worldTransformById.get(canonical.id),
        worldTransformByNodeId: worldTransformById,
        canonicalNodeById: canonicalById,
        paintNodes: orderedNodes,
        childrenByParentId: children,
      }) : undefined;
      combined = combinedBounds(combined, derived);
    }
    if (isolated) combined = expandedBounds(combined, worldEffectPaddingForNode(node, true));
    subtreeBounds.set(node.id, combined);
    return combined;
  };
  const subtreeHasBackgroundBlur = (node: CanvasNode): boolean => {
    const cached = subtreeBackgroundBlur.get(node.id);
    if (cached !== undefined) return cached;
    const result = (!node.isMask && activeNodeEffects(node).some((effect) => Boolean(effect.backgroundBlur)))
      || (children.get(node.id) ?? []).some(subtreeHasBackgroundBlur);
    subtreeBackgroundBlur.set(node.id, result);
    return result;
  };
  const subtreeBackdropRequirement = new Map<string, boolean>();
  const subtreeRequiresBackdrop = (node: CanvasNode): boolean => {
    const cached = subtreeBackdropRequirement.get(node.id);
    if (cached !== undefined) return cached;
    const result = nodePresentationRequiresBackdrop(node)
      || (children.get(node.id) ?? []).some(subtreeRequiresBackdrop);
    subtreeBackdropRequirement.set(node.id, result);
    return result;
  };
  const compositeMaskedSiblings = (destination: OffscreenCanvasRenderingContext2D, mask: CanvasNode, targets: readonly CanvasNode[], maskDepth: number, compositionDepth: number) => {
    if (!targets.length || !canvas) return;
    const repeatedSource = isPreparingRepeatedSource(destination);
    const runBounds = targets.reduce<PaintBounds | undefined>(
      (bounds, target) => combinedBounds(bounds, boundsForSubtree(target)),
      boundsForSubtree(mask),
    );
    const window = compositeWindowForBounds(runBounds, !repeatedSource);
    if (!window) return;
    const admission = admitAlphaMaskSurface(window.pixelWidth, window.pixelHeight, maskDepth);
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
    const acquired = acquireAlphaMaskSurface(maskDepth, window);
    if (!acquired) return;
    const { target, targetContext, mask: maskSurface, maskContext } = acquired;
    // The surfaces are reused for later sibling runs at this depth. Clear in
    // device coordinates before restoring the document-space transform.
    prepareCompositeSurface(targetContext, target, window);
    const needsBackdrop = targets.some(subtreeRequiresBackdrop);
    if (needsBackdrop) {
      const repeatTransform = repeatScreenTransformByContext.get(destination);
      const seeded = repeatTransform
        ? drawRepeatOccurrenceBacking(targetContext, destination, window, repeatTransform)
        : (drawCompositeBacking(targetContext, destination, window), true);
      // An unavailable occurrence window is fully clipped. Failing closed here
      // avoids rendering a backdrop-dependent target against transparency.
      if (!seeded) return;
    }
    withRepeatSourcePreparation(targetContext, repeatedSource, () => {
      renderSiblings(targets, targetContext, maskDepth + 1, compositionDepth);
    });

    // Each Paint Stack layer owns its local blend mode. Render the mask on a
    // separate transparent surface so those source-over writes cannot replace
    // the one destination-in operation applied to the combined target run.
    prepareCompositeSurface(maskContext, maskSurface, window);
    const frozenMask = compiledMaskSourceByNodeId.get(mask.id)?.node ?? mask;
    const maskDescendants = children.get(mask.id) ?? [];
    // A paint-owning container mask contributes both its own paint and the
    // recursively clipped child subtree. Clear the control flag only for this
    // root invocation so nested sibling masks retain their ordinary semantics.
    withMaskAlphaPreparation(maskContext, true, () => {
      withRepeatSourcePreparation(maskContext, repeatedSource, () => {
        renderBranchInto(maskContext, maskDepth + 1, compositionDepth)({ ...frozenMask, isMask: false });
      });
    });
    cacheRenderedMaskAlphaHit(frozenMask, maskContext, window, maskDescendants.length > 0);
    targetContext.save();
    setCompositeSurfaceTransform(targetContext, window);
    targetContext.globalCompositeOperation = "destination-in";
    drawCompositeSurface(targetContext, maskSurface, window);
    targetContext.restore();
    compositePreparedSurface(destination, target, window);
  };
  const renderSiblings = (siblings: readonly CanvasNode[], destination = ctx, maskDepth = 0, compositionDepth = 0) => {
    for (let index = 0; index < siblings.length; index += 1) {
      const node = siblings[index];
      if (node.isMask) {
        let end = index + 1;
        while (end < siblings.length && !siblings[end].isMask) end += 1;
        compositeMaskedSiblings(destination, node, siblings.slice(index + 1, end), maskDepth, compositionDepth);
        index = end - 1;
        continue;
      }
      renderBranchInto(destination, maskDepth, compositionDepth)(node);
    }
  };
  const renderWithRepeatWorldAffine = (
    destination: OffscreenCanvasRenderingContext2D,
    matrix: AffineMatrix,
    paint: () => void,
  ) => {
    destination.save();
    const screen = affineScreenMatrix(matrix, toScreen(0, 0), viewport.zoom);
    const previousTransform = repeatScreenTransformByContext.get(destination);
    repeatScreenTransformByContext.set(
      destination,
      previousTransform ? multiplyAffine(previousTransform, screen) : screen,
    );
    try {
      destination.transform(screen.a, screen.b, screen.c, screen.d, screen.e, screen.f);
      paint();
    } finally {
      if (previousTransform) repeatScreenTransformByContext.set(destination, previousTransform);
      else repeatScreenTransformByContext.delete(destination);
      destination.restore();
    }
  };
  function renderBranchInto(
    destination: OffscreenCanvasRenderingContext2D,
    maskDepth: number,
    compositionDepth: number,
    detachedPreview = false,
    suppressedOwnerId?: string,
  ) {
    return (node: CanvasNode) => {
      if (alreadyRenderedNodeIds.has(node.id)) return;
      const suppressOwnerPresentation = suppressedOwnerId === node.id;
      if (!suppressOwnerPresentation) {
        paintedNodes += 1;
        if (paintedNodes === 1 || paintedNodes % 100 === 0)
          reportProgress?.(paintedNodes, orderedNodes.length);
      }
      // A child that has been dragged completely beyond an ancestor Frame's
      // clip stays visible until pointer-up. Omit it from the clipped document
      // pass so it can be rendered once as the detached Figma-style preview.
      if (!detachedPreview && dragPreviewRootIds.has(node.id)) return;
      // A nested mask uses the same bounded offscreen composition path. The
      // destination may itself be an offscreen surface, so defer to the shared
      // sibling renderer rather than painting a mask as an ordinary node.
      if (node.isMask) return;
      const descendants = children.get(node.id) ?? [];
      const maskAlphaOnly = maskAlphaPreparationContexts.has(destination);
      const presentationEffects = maskAlphaOnly ? activeMaskAlphaEffects(node) : activeNodeEffects(node);
      if (!suppressOwnerPresentation && requiresSubtreeComposition(node, descendants.length > 0, presentationEffects)) {
        const repeatedSource = isPreparingRepeatedSource(destination);
        const window = compositeWindowForBounds(boundsForSubtree(node), !repeatedSource);
        if (!window) return;
        const repeatTransform = repeatScreenTransformByContext.get(destination);
        const materializeOccurrence = Boolean(!maskAlphaOnly && repeatTransform && subtreeHasBackgroundBlur(node));
        const occurrenceWindow = materializeOccurrence && repeatTransform
          ? transformedCompositeSurfaceWindow(window, repeatTransform, width, height)
          : repeatBackgroundBlurWindow(destination, window, presentationEffects);
        if (materializeOccurrence && !occurrenceWindow) return;
        const renderWindow = materializeOccurrence ? occurrenceWindow! : window;
        const surfaces = acquireSubtreeCompositeSurfaces(
          compositionDepth,
          compositePoolDimensionsForWindows(window, occurrenceWindow),
        );
        // Resource failure is closed: painting descendants directly would
        // expose an output that violates the document's group semantics.
        if (!surfaces) return;
        surfaces.sourceContext.save();
        prepareCompositeSurface(surfaces.sourceContext, surfaces.source, renderWindow);
        const previousBackdrop = preparedBackdropContextByContext.get(surfaces.sourceContext);
        const previousRepeatTransform = repeatScreenTransformByContext.get(surfaces.sourceContext);
        preparedBackdropContextByContext.set(surfaces.sourceContext, destination);
        if (materializeOccurrence && repeatTransform) {
          repeatScreenTransformByContext.set(surfaces.sourceContext, repeatTransform);
          surfaces.sourceContext.transform(
            repeatTransform.a,
            repeatTransform.b,
            repeatTransform.c,
            repeatTransform.d,
            repeatTransform.e,
            repeatTransform.f,
          );
        }
        try {
          withMaskAlphaPreparation(surfaces.sourceContext, maskAlphaOnly, () => {
            withRepeatSourcePreparation(surfaces.sourceContext, repeatedSource, () => {
              renderBranchInto(
                surfaces.sourceContext,
                maskDepth,
                compositionDepth + 1,
                detachedPreview,
                node.id,
              )(node);
            });
          });
        } finally {
          if (previousBackdrop) preparedBackdropContextByContext.set(surfaces.sourceContext, previousBackdrop);
          else preparedBackdropContextByContext.delete(surfaces.sourceContext);
          if (previousRepeatTransform) repeatScreenTransformByContext.set(surfaces.sourceContext, previousRepeatTransform);
          else repeatScreenTransformByContext.delete(surfaces.sourceContext);
          surfaces.sourceContext.restore();
        }
        compositePreparedSubtree(destination, node, surfaces, renderWindow, materializeOccurrence);
        return;
      }
      if (node.kind === "transformGroup") {
        const canonical = nodes.find((candidate) => candidate.id === node.id);
        const repeatSubtree = canonical ? transformGroupRepeatSubtree(orderedNodes, canonical, children) : undefined;
        const repeats = repeatSubtree ? transformGroupRepeatMatrices(nodes, canonical!) : undefined;
        // Every occurrence replays the admitted recursive subtree. Prepared
        // effects, isolated containers and mask runs retain this destination
        // transform for their final composite, so node and paint-layer blends
        // see the real backdrop at the derived position.
        renderSiblings(descendants, destination, maskDepth, compositionDepth);
        repeats?.forEach((matrix) => {
          renderWithRepeatWorldAffine(destination, matrix, () => {
            renderSiblings(descendants, destination, maskDepth, compositionDepth);
          });
        });
        return;
      }
      const sourceNode = suppressOwnerPresentation ? subtreeSourceNode(node) : node;
      const splitContainerPaint = isFrameLike(node) && descendants.length > 0 && hasVisibleStroke(sourceNode);
      renderNode(destination, splitContainerPaint ? containerFillSourceNode(sourceNode) : sourceNode);
      if (node.kind === "booleanOperation" && canonicalBooleanPath(node)) return;
      if (!descendants.length) return;
      if (
        isFrameLike(node) &&
        node.clipsContent !== false
      ) {
        clipFrameContents(destination, node);
        renderSiblings(descendants, destination, maskDepth, compositionDepth);
        destination.restore();
        if (splitContainerPaint) renderContainerStrokeOverlay(destination, sourceNode);
        return;
      }
      renderSiblings(descendants, destination, maskDepth, compositionDepth);
      if (splitContainerPaint) renderContainerStrokeOverlay(destination, sourceNode);
    };
  }
  renderSiblings(roots);
  // Draw detached preview roots last: this keeps them out of their former
  // Frame's clip and avoids a duplicate in-Frame paint. Their own descendant
  // structure (including clips they own) still uses the normal recursion.
  orderedNodes
    .filter((node) => dragPreviewRootIds.has(node.id))
    .forEach((node) => renderBranchInto(ctx, 0, 0, true)(node));
}

/** This is a presentation-only escape hatch for an active move. The durable
 * document retains its Frame clipping; only a layer fully outside an ancestor
 * Frame gets the visible detached preview expected during a Figma drag. */
function escapedFrameDragPreviewRootIds() {
  if (drag?.mode !== "move") return new Set<string>();
  return new Set([...drag.initial].filter((id) => isFullyClippedForSelection(nodes, id, boundsForNode)));
}

function acquireAlphaMaskSurface(depth: number, window: Pick<CompositeSurfaceWindow, "pixelWidth" | "pixelHeight">): AlphaMaskSurfaces | undefined {
  if (!canvas) return undefined;
  const existing = alphaMaskSurfaces[depth];
  if (existing && existing.target.width >= window.pixelWidth && existing.target.height >= window.pixelHeight) return existing;
  const pixelWidth = Math.max(existing?.target.width ?? 0, window.pixelWidth);
  const pixelHeight = Math.max(existing?.target.height ?? 0, window.pixelHeight);
  const admission = admitAlphaMaskSurface(pixelWidth, pixelHeight, depth);
  if (!admission.accepted) return undefined;
  const replacedBytes = existing ? surfaceBytes(existing.target) * 2 : 0;
  if (!admitAdditionalCompositeSurfaces(pixelWidth, pixelHeight, 2, replacedBytes).accepted) return undefined;
  const target = new OffscreenCanvas(pixelWidth, pixelHeight);
  const mask = new OffscreenCanvas(pixelWidth, pixelHeight);
  const targetContext = target.getContext("2d");
  const maskContext = mask.getContext("2d");
  if (!targetContext || !maskContext) return undefined;
  const acquired = { target, targetContext, mask, maskContext };
  alphaMaskSurfaces[depth] = acquired;
  return acquired;
}

function clipFrameContents(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode) {
  const screenTransform = ctx.getTransform();
  const frozenGeometry = compiledClipGeometryByNodeId.get(node.id);
  const point = toScreen(node.x, node.y);
  const frameWidth = (frozenGeometry?.width ?? node.width) * viewport.zoom;
  const frameHeight = (frozenGeometry?.height ?? node.height) * viewport.zoom;
  ctx.save();
  if (frozenGeometry?.geometry === "rounded-rect") {
    const world = frozenGeometry.worldTransform;
    const origin = toScreen(world.e, world.f);
    ctx.transform(world.a, world.b, world.c, world.d, origin.x, origin.y);
  } else if (!applyNativeAffine(ctx, node)) {
    ctx.translate(point.x + frameWidth / 2, point.y + frameHeight / 2);
    ctx.rotate(node.rotation * Math.PI / 180);
    ctx.translate(-frameWidth / 2, -frameHeight / 2);
  }
  roundedRectPath(
    ctx,
    0,
    0,
    frameWidth,
    frameHeight,
    Math.max(0, (frozenGeometry?.radius ?? node.radius) * viewport.zoom),
    frozenGeometry?.cornerRadii
      ? [...frozenGeometry.cornerRadii] as [number, number, number, number]
      : node.cornerRadii,
    frozenGeometry?.cornerSmoothing ?? node.cornerSmoothing,
  );
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
  fillPaintStack(ctx, node, width, height, "evenodd");
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
    fillStrokePaintStack(ctx, node, width, height);
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

function traceLineEndpoint(ctx: OffscreenCanvasRenderingContext2D, cap: CanvasNode["strokeCapStart"], x: number, direction: -1 | 1, strokeWidth: number) {
  if (!isDecorativeCap(cap)) return;
  // Canvas, hit test and SVG all consume this one mesh from the shared
  // `decorative-cap-mesh` source, so the arrowhead/diamond/dot can never drift
  // between what is drawn, what is hit and what is exported.
  const mesh = decorativeCapMesh(cap, x, direction, strokeWidth);
  mesh.triangles.forEach(([a, b, c]) => {
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.closePath();
  });
}

function renderLineEndpointPaintStack(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, width: number, strokeWidth: number) {
  ctx.beginPath();
  traceLineEndpoint(ctx, node.strokeCapStart, 0, -1, strokeWidth);
  traceLineEndpoint(ctx, node.strokeCapEnd, width, 1, strokeWidth);
  fillStrokePaintStack(ctx, node, Math.max(width, 1), Math.max(strokeWidth, 1));
}

function renderConnectorEndpointDecorations(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode, path: NonNullable<ReturnType<typeof connectorPathForNode>>, scale: number, width: number, height: number) {
  ctx.beginPath();
  connectorEndpointDecorations(node, path).forEach((decoration) => {
    scaledConnectorDecorationTriangles(decoration, node.strokeWidth, scale).forEach(([a, b, c]) => {
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.closePath();
    });
  });
  fillStrokePaintStack(ctx, node, width, height);
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
  ctx.font = `${style.italic ? "italic " : ""}${usesSmallCaps(style.textCase) ? "small-caps " : ""}${style.fontWeight} ${style.fontSize * viewport.zoom}px ${fontFamilies ? `${fontFamilies}, ` : ""}${canvasDesignTokens.typography.canvasText.family}`;
  const letterSpacingTarget = ctx as unknown as { letterSpacing?: string };
  if ("letterSpacing" in letterSpacingTarget) letterSpacingTarget.letterSpacing = `${style.letterSpacing * viewport.zoom}px`;
  // This Canvas property is not exposed in every lib.dom version. Reset it for
  // unvaried spans so a preceding Style Run cannot leak its axes into the next.
  const variationTarget = ctx as unknown as { fontVariationSettings?: string };
  if ("fontVariationSettings" in variationTarget) variationTarget.fontVariationSettings = fontVariationCss(style.font?.variationAxes);
}

/** Measures the exact presentation spans while retaining Canonical source
 * offsets. This keeps wrapping stable when text case expands glyph content
 * (for example `ß` becoming `SS`) or a line crosses style-run boundaries. */
function measureStyledTextRange(
  ctx: OffscreenCanvasRenderingContext2D,
  source: string,
  start: number,
  end: number,
  properties: CanvasNode["textProperties"],
  fallbackStyle: RenderTextStyle,
  fallbackFonts?: readonly DocumentFontReference[],
): number {
  const spans = styledTextSpans(source, start, end, properties);
  if (!spans.length) {
    applyCanvasTextStyle(ctx, fallbackStyle, fallbackFonts);
    return 0;
  }
  return spans.reduce((width, span) => {
    applyCanvasTextStyle(ctx, span.style, fallbackFonts);
    return width + ctx.measureText(span.text).width;
  }, 0);
}

function measureStyledEllipsis(
  ctx: OffscreenCanvasRenderingContext2D,
  source: string,
  start: number,
  retainedUtf8Bytes: number,
  properties: CanvasNode["textProperties"],
  fallbackStyle: RenderTextStyle,
  fallbackFonts?: readonly DocumentFontReference[],
): number {
  const spans = styledTextSpans(source, start, start + retainedUtf8Bytes, properties);
  applyCanvasTextStyle(ctx, spans.at(-1)?.style ?? fallbackStyle, fallbackFonts);
  return ctx.measureText("…").width;
}

/** Resolves the shared CSS or CAP_HEIGHT line-box edge contract. */
function textLineBox(ctx: OffscreenCanvasRenderingContext2D, lineTop: number, lineHeight: number, leadingTrim?: "capHeight") {
  const metrics = ctx.measureText("Mg");
  const capMetrics = ctx.measureText("H");
  const fallbackSize = Number.parseFloat(ctx.font.match(/(\d+(?:\.\d+)?)px/u)?.[1] ?? "16");
  return resolveLeadingTrimLineBox(lineTop, lineHeight, metrics, capMetrics, fallbackSize, leadingTrim);
}

/** Resolves Figma-style auto sizing in document coordinates before the Core
 * transaction is built. The geometry and text update therefore share one
 * revision and undo entry instead of leaving a DOM-only measurement behind. */
function withResolvedTextAutoSize(command: EditorCommand): EditorCommand {
  if (!context || (command.type !== "update" && command.type !== "create")) return command;
  const ctx = context;
  const previous = command.type === "update" ? nodes.find((node) => node.id === command.id) : undefined;
  const node = command.type === "create" ? command.node : previous ? { ...previous, ...command.patch } : undefined;
  if (!node || node.kind !== "text") return command;
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
      textCase: primary.textCase,
      textDecoration: primary.textDecoration,
      textDecorationStyle: primary.textDecorationStyle,
      textDecorationOffset: primary.textDecorationOffset,
      textDecorationThickness: primary.textDecorationThickness,
      textDecorationColor: primary.textDecorationColor,
      textDecorationSkipInk: primary.textDecorationSkipInk,
      leadingTrim: primary.leadingTrim,
  } : { fontSize: 31, fontWeight: canvasDesignTokens.typography.canvasText.weight, italic: false, letterSpacing: 0 };
  const source = node.text ?? "";
  const sourceBytes = new TextEncoder().encode(source);
  applyCanvasTextStyle(ctx, primaryStyle, properties.fallbackFonts);
  const maxWidth = properties.autoSize === "widthAndHeight" ? Number.POSITIVE_INFINITY : Math.max(1, node.width * viewport.zoom);
  const listMarkerGutter = textListMarkerGutterForProperties(
    source,
    properties,
    (value) => ctx.measureText(value).width,
  );
  const lines = layoutTextRanges({
    text: source,
    maxWidth,
    firstLineIndent: (_index, start) => textParagraphIndentAt(properties, start) * viewport.zoom
      + textListMarkerBaseIndent(properties, listMarkerGutter, start),
    paragraphIndent: (_index, start) => textListIndentationOffset(source, properties, start, listMarkerGutter),
    wrapStyle: (_index, start) => textParagraphWrapStyleAt(properties, start),
    hangingPunctuation: properties.paragraph.hangingPunctuation ?? false,
    measure: (value) => ctx.measureText(value).width,
    measureRange: (start, end) => measureStyledTextRange(ctx, source, start, end, properties, primaryStyle, properties.fallbackFonts),
  });
  let height = 0;
  let widest = 1;
  let previousEnd = 0;
  let previousParagraphStart = 0;
  lines.forEach((line, lineIndex) => {
    const skipped = new TextDecoder().decode(sourceBytes.slice(previousEnd, line.start));
    const isParagraphFirstLine = textLineStartsParagraph(lineIndex, skipped);
    const paragraphStart = textParagraphStartAtOffset(source, line.start);
    const nestingIndent = textListIndentationOffset(source, properties, line.start, listMarkerGutter);
    if (/\r\n|[\n\r\u2028\u2029]/u.test(skipped)) {
      height += textParagraphGap(properties, previousParagraphStart, paragraphStart) * viewport.zoom;
      previousParagraphStart = paragraphStart;
    }
    const spans = styledTextSpans(source, line.start, line.end, properties);
    const lineHeight = resolvedTextLineHeightAt(properties, paragraphStart, primaryStyle.fontSize) * viewport.zoom;
    height += lineHeight;
    if (spans.length <= 1) {
      applyCanvasTextStyle(ctx, spans[0]?.style ?? primaryStyle, properties.fallbackFonts);
      const displayText = spans[0]?.text ?? line.text;
      const measured = ctx.measureText(displayText).width;
      const hanging = properties.paragraph.hangingPunctuation
        ? textHangingPunctuationOffsets(displayText, line.direction, (value) => ctx.measureText(value).width)
        : { left: 0, right: 0 };
      widest = Math.max(widest, measured - hanging.left - hanging.right + nestingIndent + (isParagraphFirstLine ? textParagraphIndentAt(properties, paragraphStart) * viewport.zoom + textListMarkerBaseIndent(properties, listMarkerGutter, paragraphStart) : 0));
    } else {
      const measured = spans.reduce((total, span) => {
        applyCanvasTextStyle(ctx, span.style, properties.fallbackFonts);
        return total + ctx.measureText(span.text).width;
      }, 0);
      applyCanvasTextStyle(ctx, primaryStyle, properties.fallbackFonts);
      const hanging = properties.paragraph.hangingPunctuation
        ? textHangingPunctuationOffsets(line.text, line.direction, (value) => ctx.measureText(value).width)
        : { left: 0, right: 0 };
      widest = Math.max(widest, measured - hanging.left - hanging.right + nestingIndent + (isParagraphFirstLine ? textParagraphIndentAt(properties, paragraphStart) * viewport.zoom + textListMarkerBaseIndent(properties, listMarkerGutter, paragraphStart) : 0));
    }
    previousEnd = line.end;
  });
  if (lines.length && primaryStyle.leadingTrim === "capHeight") {
    applyCanvasTextStyle(ctx, primaryStyle, properties.fallbackFonts);
    const firstHeight = resolvedTextLineHeightAt(properties, textParagraphStartAtOffset(source, lines[0]!.start), primaryStyle.fontSize) * viewport.zoom;
    const lastHeight = resolvedTextLineHeightAt(properties, textParagraphStartAtOffset(source, lines.at(-1)!.start), primaryStyle.fontSize) * viewport.zoom;
    const firstLineBox = textLineBox(ctx, 0, firstHeight, primaryStyle.leadingTrim);
    const lastLineBox = textLineBox(ctx, 0, lastHeight, primaryStyle.leadingTrim);
    height = Math.max(0, height - firstLineBox.trimStart - lastLineBox.trimEnd);
  }
  const geometry: Partial<CanvasNode> = {
    height: Math.max(1, height / viewport.zoom),
    ...(properties.autoSize === "widthAndHeight" ? { width: Math.max(1, widest / viewport.zoom) } : {}),
  };
  return command.type === "create"
    ? { ...command, node: { ...command.node, ...geometry } }
    : { ...command, patch: { ...command.patch, ...geometry } };
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
    && canonical.kind !== "transformGroup"
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
  return resolveMultiResizeSelection(nodes, selectedIds, {
    repeatBoundsForNode: materializedRepeatResizeBounds,
  });
}

function materializedRepeatResizeBounds(node: CanvasNode): ResizeGeometry | undefined {
  const bounds = repeatSourceIdsByGroupId.has(node.id) ? nodeBoundsById.get(node.id) : undefined;
  return bounds && bounds.width > 0 && bounds.height > 0 ? bounds : undefined;
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
  if (canonical.kind === "transformGroup") {
    const bounds = nodeBoundsById.get(canonical.id);
    if (!bounds) return;
    const point = toScreen(bounds.x, bounds.y);
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = canvasDesignTokens.color.selection;
    ctx.lineWidth = canvasDesignTokens.stroke.selection.width;
    ctx.setLineDash([...canvasDesignTokens.stroke.selection.dash]);
    ctx.strokeRect(
      point.x + canvasDesignTokens.stroke.selection.pixelInset,
      point.y + canvasDesignTokens.stroke.selection.pixelInset,
      Math.max(0, bounds.width * viewport.zoom - 1),
      Math.max(0, bounds.height * viewport.zoom - 1),
    );
    ctx.restore();
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

/** Selected Frame children expose the same dotted constraint relationships as
 * Figma's canvas. The guide geometry comes from canonical transforms, while
 * the paint is screen-space so it stays crisp at every zoom level. */
function renderConstraintGuides(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode) {
  if (selectedIds.length !== 1 || selectedIds[0] !== node.id) return;
  const canonical = nodes.find((candidate) => candidate.id === node.id);
  if (!canonical) return;
  const guides = constraintGuidesForNode(nodes, canonical, worldTransformById);
  if (!guides.length) return;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = canvasDesignTokens.color.selection;
  ctx.fillStyle = canvasDesignTokens.color.selection;
  ctx.lineWidth = 1;
  for (const guide of guides) {
    const start = toScreen(guide.start.x, guide.start.y);
    const end = toScreen(guide.end.x, guide.end.y);
    ctx.setLineDash(guide.role === "scale" ? [2, 3] : [4, 3]);
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    if (Math.hypot(end.x - start.x, end.y - start.y) < 2) {
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(start.x, start.y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.setLineDash([]);
  ctx.restore();
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
    const selection = resolveMultiResizeSelection(nodes, [canonical.id], {
      repeatBoundsForNode: materializedRepeatResizeBounds,
    });
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
    const repeatBounds = canonical.kind === "transformGroup" ? nodeBoundsById.get(canonical.id) : undefined;
    if (repeatBounds) {
      const point = toScreen(repeatBounds.x, repeatBounds.y);
      return {
        left: point.x,
        top: point.y,
        right: point.x + repeatBounds.width * viewport.zoom,
        bottom: point.y + repeatBounds.height * viewport.zoom,
      };
    }
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
    ? (() => {
        const selected = selectedNodes[0];
        const bounds = selected.kind === "transformGroup" ? nodeBoundsById.get(selected.id) : undefined;
        return selectionDimensions(bounds?.width ?? selected.width, bounds?.height ?? selected.height);
      })()
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
  if (selectedNode && selectedNode.kind !== "transformGroup" && !multiSelection && renderRotatedSingleSelectionLabels(ctx, selectedNode, dimensions, labelWidth, labelHeight, horizontalInset, cornerRadius, offsetY)) {
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
    ? [currentScenePresentationKey(), nodes.length, viewport.x, viewport.y, viewport.zoom, width, height, dpr, renderQuality.tier].join(":")
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
  if (!compiledScene || compiledScene.scene.revision !== revision || compiledScene.scene.resourceGeneration !== sceneResourceGeneration) rebuildCompiledScene();
  if (!context || !canvas) return;
  const startedAt = performance.now();
  const frameRenderCost: ActiveFrameRenderCost = { canvasReadbackBytes: 0 };
  activeFrameRenderCost = frameRenderCost;
  if (reprojectCachedFrameDuringInteraction()) {
    renderPerformance.record({
      totalMs: performance.now() - startedAt,
      cullingMs: 0,
      gpuPrepareMs: 0,
      gpuIslandMs: 0,
      canvasIslandMs: 0,
      overlayMs: 0,
      imageBitmapMs: 0,
      compositeMs: 0,
      candidateNodes: 0,
      visibleNodes: 0,
      gpuUploadBytes: 0,
      canvasReadbackBytes: 0,
      gpuCoverageUpperBoundPixels: 0,
      canvasFallbackCoverageUpperBoundPixels: 0,
      compositeSurfaceBytes: allocatedCompositeSurfaceBytes(),
      rendersPerInputFrame,
    });
    activeFrameRenderCost = undefined;
    maybeSimulateGpuLoss();
    return;
  }
  // Cache eviction is presentation-only. Re-request each visible missing asset
  // so a page converges on the shared per-image proxy budget instead of
  // leaving an evicted layer on its striped placeholder indefinitely.
  new Set(activeNodes()
    .filter((node) => node.visible !== false)
    .flatMap(nodeImagePaintAssetIds)
    .filter((assetId) => !imageBitmaps.has(assetId)))
    .forEach((assetId) => void ensureImageBitmap(assetId));
  const cullingStartedAt = startedAt;
  const viewportBounds = viewportWorldBounds(viewport, width, height);
  const candidateNodes = spatialGrid.query(viewportBounds);
  // The spatial index intentionally contains every canonical node. Intersect
  // it with hierarchy visibility here so a hidden Section's descendants cannot
  // reappear merely because this render path bypasses `activeNodes()`.
  const pageVisibleNodes = activeNodes();
  const candidateIds = new Set(candidateNodes.map((node) => node.id));
  const repeatRetainedSourceIds = new Set<string>();
  candidateNodes.forEach((candidate) => repeatSourceIdsByGroupId.get(candidate.id)?.forEach((id) => {
    candidateIds.add(id);
    repeatRetainedSourceIds.add(id);
  }));
  const activeNodeOrderById = activeNodeOrderByIdCache ?? new Map(pageVisibleNodes.map((node, index) => [node.id, index]));
  const visibleNodes = [...candidateIds]
    .map((id) => nodeById.get(id))
    .filter((node): node is CanvasNode => Boolean(node
      && node.id !== editingTextNodeId
      && (repeatRetainedSourceIds.has(node.id) || boundsIntersect(nodeBoundsById.get(node.id) ?? rotatedNodeBounds(node), viewportBounds))))
    .sort((left, right) => (activeNodeOrderById.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (activeNodeOrderById.get(right.id) ?? Number.MAX_SAFE_INTEGER));
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
  if (Number(wasmDocument?.revision) === revision
    && (renderQuality.tier === "settled" || nodes.length < COMPLEX_DOCUMENT_NODE_THRESHOLD))
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
  let orderedBackendIslandsRendered = false;
  let backendIslandPaintStarted = false;
  let gpuUploadBytes = 0;
  let imageBitmapMs = 0;
  let compositeMs = 0;
  let gpuIslandMs = 0;
  let canvasIslandMs = 0;
  let gpuCoverageUpperBoundPixels = 0;
  let canvasFallbackCoverageUpperBoundPixels = 0;
  let materializedCanvasIslands = 0;
  let directCanvasIslands = 0;
  let materializedBackdropCanvasIslands = 0;
  let materializedCanvasIslandPixels = 0;
  const gpuStartedAt = performance.now();
  const pageFacts = activePageRenderFacts(pageVisibleNodes);
  const pageHasFrameChildren = pageFacts.hasFrameChildren;
  const pageHasAlphaMasks = pageFacts.hasAlphaMasks;
  const pageHasTransformGroupRepeat = pageFacts.hasTransformGroupRepeat;
  const pageParentIds = pageFacts.parentIds;
  const pageHasSubtreeComposition = pageFacts.hasSubtreeComposition;
  const useProgressiveStructuralRender =
    (fastStructuralPreview || nodes.length >= COMPLEX_DOCUMENT_NODE_THRESHOLD) &&
    pageHasFrameChildren &&
    !pageHasAlphaMasks &&
    !pageHasTransformGroupRepeat &&
    !pageHasSubtreeComposition;
  const dirtyReplayPlan: DirtyRegionReplayPlan = planDirtyRegionReplay({
    dirtyRegions: compiledScene?.dirtyRegions ?? [{ kind: "full-scene", reason: "initial" }],
    replayBounds: compiledScene?.scene.semanticNodes.flatMap((node) => {
      const bounds = node.visible && node.paintable ? node.effectBounds ?? node.worldBounds : undefined;
      return bounds ? [bounds] : [];
    }),
    viewport,
    width,
    height,
  });
  if (captureFrameHash && revision > 0) {
    const signature = `${activePageId}:${revision}:${dirtyReplayPlan.kind}:${dirtyReplayPlan.kind === "full-scene" ? dirtyReplayPlan.reason : ""}`;
    if (signature !== lastDirtyRegionPlanSignature) {
      lastDirtyRegionPlanSignature = signature;
      diagnostics.record({
        category: "renderer",
        code: dirtyReplayPlan.kind === "regions"
          ? "DIRTY_REGION_PLAN_REGIONS"
          : dirtyReplayPlan.kind === "none"
            ? "DIRTY_REGION_PLAN_NONE"
            : `DIRTY_REGION_PLAN_FULL_${dirtyReplayPlan.reason.toUpperCase().replaceAll("-", "_")}`,
        documentRevision: revision,
        details: dirtyReplayPlan.kind === "full-scene"
          ? { kind: dirtyReplayPlan.kind, reason: dirtyReplayPlan.reason }
          : { kind: dirtyReplayPlan.kind },
      });
    }
  }
  const hasTransientOverlay = selectedIds.length > 0
    || Boolean(hoveredId || drag || editingTextNodeId || hoveredAutoLayoutPadding || penDraft);
  const useDirtyRegionReplay = dirtyReplayPlan.kind === "regions"
    && rendererPreference === "canvas2d"
    && renderQuality.tier === "settled"
    && nodes.length < COMPLEX_DOCUMENT_NODE_THRESHOLD
    && !reportRemoteProgress
    && !fastStructuralPreview
    && !pageHasFrameChildren
    && !pageHasAlphaMasks
    && !pageHasTransformGroupRepeat
    && !pageHasSubtreeComposition
    && !pageVisibleNodes.some(showsPersistentCanvasLayerName)
    && !hasTransientOverlay
    && presentedScene !== undefined
    && presentedScene === compiledScenePreviousScene
    && presentedPageId === activePageId
    && presentedSurfaceWidth === canvas.width
    && presentedSurfaceHeight === canvas.height
    && presentedViewport !== undefined
    && isSameRenderedViewport(presentedViewport, viewport);
  if (captureFrameHash && dirtyReplayPlan.kind === "regions" && !useDirtyRegionReplay) {
    const blockers = [
      ...(rendererPreference !== "canvas2d" ? ["renderer"] : []),
      ...(renderQuality.tier !== "settled" ? ["quality"] : []),
      ...(nodes.length >= COMPLEX_DOCUMENT_NODE_THRESHOLD ? ["large-document"] : []),
      ...(reportRemoteProgress ? ["remote-progress"] : []),
      ...(fastStructuralPreview ? ["structural-preview"] : []),
      ...(pageHasFrameChildren ? ["frame-clip"] : []),
      ...(pageHasAlphaMasks ? ["alpha-mask"] : []),
      ...(pageHasTransformGroupRepeat ? ["transform-repeat"] : []),
      ...(pageHasSubtreeComposition ? ["subtree-composition"] : []),
      ...(pageVisibleNodes.some(showsPersistentCanvasLayerName) ? ["persistent-label"] : []),
      ...(hasTransientOverlay ? ["transient-overlay"] : []),
      ...(presentedScene === undefined ? ["no-presented-scene"] : []),
      ...(presentedScene !== compiledScenePreviousScene ? ["scene-fence"] : []),
      ...(presentedPageId !== activePageId ? ["page-fence"] : []),
      ...(presentedSurfaceWidth !== canvas.width || presentedSurfaceHeight !== canvas.height ? ["surface-fence"] : []),
      ...(presentedViewport === undefined || !isSameRenderedViewport(presentedViewport, viewport) ? ["viewport-fence"] : []),
    ];
    const signature = `${activePageId}:${revision}:${blockers.join(",")}`;
    if (signature !== lastDirtyRegionReplayBlockerSignature) {
      lastDirtyRegionReplayBlockerSignature = signature;
      diagnostics.record({
        category: "renderer",
        code: `DIRTY_REGION_REPLAY_BLOCKED_${blockers.join("_").toUpperCase().replaceAll("-", "_") || "UNKNOWN"}`,
        documentRevision: revision,
        details: { blockerCount: blockers.length },
      });
    }
  }
  const dirtyReplayRects = dirtyReplayPlan.kind === "regions" ? dirtyReplayPlan.rects : [];
  const hasReusablePresentedFrame =
    presentedPageId === activePageId &&
    presentedSurfaceWidth === canvas.width &&
    presentedSurfaceHeight === canvas.height &&
    cachedPresentedFrameSceneKey === currentScenePresentationKey() &&
    isSameRenderedViewport(cachedPresentedFrameViewport, viewport);
  const rejectCompositeFrame = (diagnosticCode: string) => {
    if (activeFrameRenderCost === frameRenderCost) activeFrameRenderCost = undefined;
    if (!compositeSurfaceLimitReported) {
      diagnostics.record({
        category: "renderer",
        code: diagnosticCode,
        documentRevision: revision,
      });
      compositeSurfaceLimitReported = true;
    }
    const retainsPresentedFrame = presentedPageId === activePageId
      && presentedSurfaceWidth === canvas!.width
      && presentedSurfaceHeight === canvas!.height;
    emit({
      type: "frame-failed",
      revision,
      pageId: activePageId,
      code: "RESOURCE_LIMIT",
      ...(retainsPresentedFrame && presentedRevision !== undefined
        ? { retainedRevision: presentedRevision }
        : {}),
    });
    emitSnapshot(undefined, false);
  };
  // Resource admission belongs to the frame, not to individual node paints.
  // Reject before clearing the transferred canvas so a failed revision cannot
  // replace the last complete presentation with a partial composite.
  const compositeSurfacePlan = structuralCompositeSurfacePlan(structuralRenderNodes);
  const effectPoolWindow = compositeSurfacePlan.effectPool ?? { pixelWidth: 1, pixelHeight: 1 };
  const compositeAdmission = admitCompositeFrame(canvas.width, canvas.height, structuralRenderNodes, compositeSurfacePlan);
  if (!compositeAdmission.accepted) {
    rejectCompositeFrame(`COMPOSITE_FRAME_${compositeAdmission.reason.toUpperCase()}`);
    return;
  }
  // Pools from an earlier scene are presentation caches. Release any capacity
  // the accepted frame no longer needs so subsequent acquisitions are charged
  // against this frame's actual simultaneous demand.
  if (!compositeAdmission.demand.effectPool) effectSurfaces = undefined;
  alphaMaskSurfaces.length = compositeAdmission.demand.alphaMaskPools;
  subtreeCompositeSurfaces.length = compositeAdmission.demand.subtreePools;
  const poolMatches = (surface: OffscreenCanvas, dimensions: CompositePoolDimensions) =>
    surface.width === dimensions.pixelWidth && surface.height === dimensions.pixelHeight;
  if (effectSurfaces && !poolMatches(effectSurfaces.source, effectPoolWindow)) effectSurfaces = undefined;
  alphaMaskSurfaces = alphaMaskSurfaces.map((pool, depth) => {
    const dimensions = compositeSurfacePlan.alphaMaskPools?.[depth] ?? { pixelWidth: 1, pixelHeight: 1 };
    return pool && poolMatches(pool.target, dimensions) ? pool : undefined;
  });
  subtreeCompositeSurfaces = subtreeCompositeSurfaces.map((pool, depth) => {
    const dimensions = compositeSurfacePlan.subtreePools?.[depth] ?? { pixelWidth: 1, pixelHeight: 1 };
    return pool && poolMatches(pool.source, dimensions) ? pool : undefined;
  });
  // Materialize every admitted pool while the last complete frame is still on
  // the transferred canvas. A browser allocation/context failure therefore
  // follows the same whole-frame contract as an explicit budget rejection.
  try {
    const effectReady = !compositeAdmission.demand.effectPool || Boolean(acquireEffectSurfaces(effectPoolWindow));
    const masksReady = Array.from({ length: compositeAdmission.demand.alphaMaskPools }, (_, depth) => depth)
      .every((depth) => Boolean(acquireAlphaMaskSurface(depth, compositeSurfacePlan.alphaMaskPools?.[depth] ?? { pixelWidth: 1, pixelHeight: 1 })));
    const subtreesReady = Array.from({ length: compositeAdmission.demand.subtreePools }, (_, depth) => depth)
      .every((depth) => Boolean(acquireSubtreeCompositeSurfaces(depth, compositeSurfacePlan.subtreePools?.[depth] ?? { pixelWidth: 1, pixelHeight: 1 })));
    if (!effectReady || !masksReady || !subtreesReady) {
      rejectCompositeFrame("COMPOSITE_FRAME_SURFACE_UNAVAILABLE");
      return;
    }
  } catch {
    rejectCompositeFrame("COMPOSITE_FRAME_SURFACE_UNAVAILABLE");
    return;
  }
  if (useDirtyRegionReplay) {
    context.save();
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.beginPath();
    dirtyReplayRects.forEach((rect) => context!.rect(rect.x, rect.y, rect.width, rect.height));
    context.clip();
    dirtyReplayRects.forEach((rect) => context!.clearRect(rect.x, rect.y, rect.width, rect.height));
    context.fillStyle = canvasDesignTokens.color.backdrop;
    dirtyReplayRects.forEach((rect) => context!.fillRect(rect.x, rect.y, rect.width, rect.height));
  } else if (!useProgressiveStructuralRender || !hasReusablePresentedFrame) {
    context.clearRect(0, 0, width, height);
    context.fillStyle = canvasDesignTokens.color.backdrop;
    context.fillRect(0, 0, width, height);
    if (useProgressiveStructuralRender) renderGrid(context);
  }
  const dragPreviewRootIds = escapedFrameDragPreviewRootIds();
  if (gpuRenderer && !useProgressiveStructuralRender) {
    try {
      // GPU stores the whole world-space document once; the camera uniform performs
      // viewport changes. Canvas-only overlays continue to use the culled list.
      const pageNodes = !editingTextNodeId && !pageFacts.hasSlices
        ? pageVisibleNodes
        : sceneNodesInPaintOrder(
            compiledScene?.scene,
            pageVisibleNodes.filter((node) => node.id !== editingTextNodeId && node.kind !== "slice"),
          );
      const pageHasRelativeTransform = pageFacts.hasRelativeTransform;
      const planKey = currentScenePresentationKey();
      let gpuPlan = gpuBackendPlanCache?.key === planKey && gpuBackendPlanCache.pageNodes === pageNodes
        ? gpuBackendPlanCache
        : undefined;
      if (!gpuPlan) {
        const decodedImageAssetIds = new Set(pageNodes
          .filter((node) => node.kind === "image" && Boolean(node.assetId) && Boolean(imageBitmaps.get(node.assetId!)))
          .map((node) => node.assetId!));
        refreshRustTextGlyphs();
        const gpuTextNodeIds = new Set([...rustTextGlyphs]
          .filter(([, cached]) => cached.revision === revision && cached.glyphs.length > 0)
          .map(([nodeId]) => nodeId));
        const plannedBackendIslands = gpuLayerIslands(pageNodes, decodedImageAssetIds, gpuTextNodeIds, (node) => {
          const parent = node.parentId ? nodeById.get(node.parentId) : undefined;
          if (node.isMask) return "mask";
          if (node.kind === "booleanOperation") return "boolean";
          if (node.kind === "transformGroup" && transformGroupRepeatMatrices(nodes, node)?.length) return "repeat";
          if (requiresSubtreeComposition(node, pageParentIds.has(node.id))) return "subtree-composition";
          if (parent && isFrameLike(parent) && parent.clipsContent !== false) return "frame-clip";
          return false;
        }, (node) => nativeAffineForNode(node)
          ? node.kind === "textPath" && gpuTextNodeIds.has(node.id) ? true : "native-affine"
          : true);
        // One renderer caches one uploaded scene. Multiple island scene keys on
        // a large page would evict each other on every zoom frame, so keep the
        // first GPU prefix stable and paint the remaining visible suffix through
        // Canvas. Small pages retain the full ordered multi-island execution.
        const backendIslands = pageNodes.length >= COMPLEX_DOCUMENT_NODE_THRESHOLD
          ? limitGpuLayerIslands(plannedBackendIslands, 1)
          : plannedBackendIslands;
        const gpuIslands = backendIslands.filter((island): island is Extract<GpuLayerIsland, { backend: "gpu" }> => island.backend === "gpu");
        const gpuNodes = gpuIslands.flatMap((island) => island.nodes);
        const gpuNodeIds = new Set(gpuNodes.map((node) => node.id));
        const gpuImageAssetIds = new Set(gpuNodes.flatMap((node) => node.kind === "image" && node.assetId ? [node.assetId] : []));
        const textGlyphs = [...rustTextGlyphs]
          .filter(([nodeId, cached]) => gpuNodeIds.has(nodeId) && cached.revision === revision)
          .flatMap(([, cached]) => cached.glyphs);
        gpuPlan = { key: planKey, pageNodes, backendIslands, gpuIslands, gpuNodes, gpuNodeIds, gpuImageAssetIds, textGlyphs };
        gpuBackendPlanCache = gpuPlan;
      }
      const { backendIslands, gpuIslands, gpuNodes, gpuNodeIds: gpuBackendNodeIds, textGlyphs } = gpuPlan;
      const visibleStructuralNodeIds = new Set(structuralRenderNodes.map((node) => node.id));
      const visibleGpuNodes = structuralRenderNodes.filter((node) => gpuBackendNodeIds.has(node.id));
      const visibleCanvasNodes = structuralRenderNodes.filter((node) => !gpuBackendNodeIds.has(node.id));
      gpuCoverageUpperBoundPixels = clippedNodeCoverageUpperBound(visibleGpuNodes);
      canvasFallbackCoverageUpperBoundPixels = clippedNodeCoverageUpperBound(visibleCanvasNodes);
      const gpuImageBitmaps = new Map<string, ImageBitmap>();
      gpuPlan.gpuImageAssetIds.forEach((assetId) => {
        const bitmap = imageBitmaps.get(assetId);
        if (bitmap) gpuImageBitmaps.set(assetId, bitmap);
      });
      const surfaceKey = `${canvas.width}x${canvas.height}:${dpr}`;
      const cachedAdmission = gpuPlan.admission?.surfaceKey === surfaceKey ? gpuPlan.admission.value : undefined;
      const frameAdmission = cachedAdmission ?? admitWebGpuSceneResources({ nodes: gpuNodes, width, height, dpr, imageBitmaps: gpuImageBitmaps, textGlyphs });
      if (!cachedAdmission) {
        gpuPlan = { ...gpuPlan, admission: { surfaceKey, value: frameAdmission } };
        gpuBackendPlanCache = gpuPlan;
      }
      if (!frameAdmission.accepted) throw new GpuSceneResourceLimitError(frameAdmission);
      const renderedNodeIds = new Set<string>();
      let lastResult: ReturnType<WebGpuSceneRenderer["render"]> | undefined;
      if (gpuNodes.length > 0) {
        for (let islandIndex = 0; islandIndex < backendIslands.length; islandIndex += 1) {
          const island = backendIslands[islandIndex]!;
          if (island.backend === "canvas") {
            const visibleIslandNodes = island.nodes.filter((node) => visibleStructuralNodeIds.has(node.id));
            if (visibleIslandNodes.length) {
              backendIslandPaintStarted = true;
              const canvasIslandStartedAt = performance.now();
              const materialized = canMaterializeCanvasIsland(island)
                && materializeCanvasIsland(context!, visibleIslandNodes, dragPreviewRootIds);
              if (materialized) {
                materializedCanvasIslands += 1;
                if (island.backdrop === "previous-islands") materializedBackdropCanvasIslands += 1;
                materializedCanvasIslandPixels = Math.min(
                  canvas.width * canvas.height,
                  materializedCanvasIslandPixels + clippedNodeCoverageUpperBound(visibleIslandNodes),
                );
              } else {
                directCanvasIslands += 1;
                renderFrameClippedTree(context!, visibleIslandNodes, dragPreviewRootIds);
              }
              canvasIslandMs += performance.now() - canvasIslandStartedAt;
            }
            continue;
          }
          const currentRustGpuScene = backendIslands.length === 1 && island.nodes.length === pageNodes.length && rustGpuScene
            && rustGpuScene.revision === revision
            && rustGpuScene.pageId === activePageId
            && rustGpuScene.transientSceneVersion === transientSceneVersion
            // A precomputed Rust instance buffer is a local acceleration only.
            // It is admissible only when it proves the same Scene IR draw order;
            // otherwise the TypeScript GPU builder receives the shared list.
            && rustGpuScene.renderedNodeIds.size === island.nodes.length
            && [...rustGpuScene.renderedNodeIds].every((nodeId, index) => island.nodes[index]?.id === nodeId)
            && !pageHasRelativeTransform
            ? { instances: rustGpuScene.instances, renderedNodeIds: rustGpuScene.renderedNodeIds }
            : undefined;
          const islandTextNodeIds = new Set(island.nodes.filter((node) => node.kind === "text" || node.kind === "textPath").map((node) => node.id));
          const islandTextGlyphs = textGlyphs.filter((glyph) => islandTextNodeIds.has(glyph.nodeId));
          const gpuIslandStartedAt = performance.now();
          const result = gpuRenderer.render({
            nodes: island.nodes,
            viewport,
            width,
            height,
            dpr,
            // The presentation key changes whenever island membership can
            // change. Avoid rebuilding a multi-megabyte NodeId string on every
            // camera-only frame of a large scene.
            sceneKey: `${currentScenePresentationKey()}:island-${islandIndex}`,
            precomputedInstances: currentRustGpuScene,
            imageBitmaps: gpuImageBitmaps,
            textGlyphs: islandTextGlyphs,
          });
          gpuIslandMs += performance.now() - gpuIslandStartedAt;
          backendIslandPaintStarted = true;
          const compositeStartedAt = performance.now();
          try {
            context.drawImage(result.bitmap, 0, 0, width, height);
            compositeMs += performance.now() - compositeStartedAt;
          } finally {
            result.bitmap.close();
          }
          result.renderedNodeIds.forEach((id) => renderedNodeIds.add(id));
          // Text atlas admission is all-or-Canvas per node. Paint any node the
          // GPU declined at this exact island boundary so it cannot jump above
          // a later Canvas subtree.
          const declinedNodes = island.nodes.filter((node) => visibleStructuralNodeIds.has(node.id) && !result.renderedNodeIds.has(node.id));
          if (declinedNodes.length) renderFrameClippedTree(context!, declinedNodes, dragPreviewRootIds);
          gpuUploadBytes += result.gpuUploadBytes;
          imageBitmapMs += result.imageBitmapMs;
          gpuEffectTextureBytes = Math.max(gpuEffectTextureBytes, result.effectTextures.bytes);
          lastResult = result;
        }
        gpuRenderedNodeIds = renderedNodeIds;
        gpuSceneBytes = frameAdmission.resourceBytes;
        orderedBackendIslandsRendered = true;
        if (captureFrameHash && gpuIslands.length > 1) diagnostics.record({
          category: "renderer",
          code: "GPU_ORDERED_ISLANDS",
          documentRevision: revision,
          details: {
            islands: backendIslands.length,
            gpuIslands: gpuIslands.length,
            canvasIslands: backendIslands.length - gpuIslands.length,
            backdropIslands: backendIslands.filter((island) => island.backdrop === "previous-islands").length,
          },
        });
        if (captureFrameHash) {
          const backdropIslands = backendIslands.filter((island) => island.backdrop === "previous-islands");
          if (backdropIslands.length) diagnostics.record({
            category: "renderer",
            code: "GPU_CANVAS_BACKDROP_DEPENDENCY",
            documentRevision: revision,
            details: {
              backdropIslands: backdropIslands.length,
              entries: backdropIslands.reduce((total, island) => total + island.nodes.length, 0),
            },
          });
          if (materializedCanvasIslands || directCanvasIslands) diagnostics.record({
            category: "renderer",
            code: "GPU_CANVAS_ISLAND_TEXTURES",
            documentRevision: revision,
            details: {
              materializedIslands: materializedCanvasIslands,
              directIslands: directCanvasIslands,
              backdropIslands: materializedBackdropCanvasIslands,
              pixels: materializedCanvasIslandPixels,
              bytes: canvasFallbackSurface ? surfaceBytes(canvasFallbackSurface.surface) : 0,
            },
          });
          const canvasReasonNodeCounts = new Map<string, number>();
          backendIslands.filter((island) => island.backend === "canvas").forEach((island) => {
            canvasReasonNodeCounts.set(island.reason, (canvasReasonNodeCounts.get(island.reason) ?? 0) + island.nodes.length);
          });
          canvasReasonNodeCounts.forEach((entries, reason) => diagnostics.record({
            category: "renderer",
            code: `GPU_CANVAS_ISLAND_${reason}`,
            documentRevision: revision,
            details: { entries },
          }));
        }
      }
      const result = lastResult;
      if (result) {
        if (captureFrameHash) {
          const nativeAffineTextPathIds = new Set(nodes
            .filter((node) => node.kind === "textPath" && Boolean(node.relativeTransform))
            .map((node) => node.id));
          const affineGlyphs = textGlyphs.filter((glyph) => glyph.quadTransform
            && nativeAffineTextPathIds.has(glyph.nodeId)
            && renderedNodeIds.has(glyph.nodeId));
          const affineNodeIds = new Set(affineGlyphs.map((glyph) => glyph.nodeId));
          const signature = `${revision}:${[...affineNodeIds].sort().join(",")}:${affineGlyphs.length}`;
          if (affineGlyphs.length && signature !== affineGpuTextStatsSignature) {
            affineGpuTextStatsSignature = signature;
            diagnostics.record({
              category: "renderer",
              code: "GPU_TEXT_AFFINE_ACTIVE",
              documentRevision: revision,
              details: { nodes: affineNodeIds.size, glyphs: affineGlyphs.length },
            });
          }
        }
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
      }
      gpuSceneWithinBudget = true;
      gpuSceneLimitReported = false;
    } catch (error) {
      // A later island can fail after earlier GPU/Canvas islands were already
      // composited. Restore a clean document surface before the ordinary
      // Canvas path below replays the complete canonical scene.
      if (backendIslandPaintStarted) {
        context.clearRect(0, 0, width, height);
        context.fillStyle = canvasDesignTokens.color.backdrop;
        context.fillRect(0, 0, width, height);
        gpuRenderedNodeIds = undefined;
        orderedBackendIslandsRendered = false;
      }
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
  const canvasFallbackStartedAt = overlayStartedAt;
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
    const needsEffectPass = renderedViewport.zoom >= 1.5 && progressiveNodes.some((node) => activeNodeEffects(node).length > 0);
    let paintingEffects = false;
    const publishStagingSurface = () => {
      if (paintGeneration !== progressivePaintGeneration || !context || !stagingContext) return;
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas!.width, canvas!.height);
      context.drawImage(stagingCanvas, 0, 0);
      context.restore();
      presentedPageId = activePageId;
      presentedRevision = revision;
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
        presentedRevision = revision;
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
      markPresentedScene();
      completedProgressivePaintKey = progressiveRequestKey;
      compositeSurfaceLimitReported = false;
      finishProgressivePaint();
      reportRemoteProgress?.("render-finalize");
      renderPerformance.record({
        totalMs: performance.now() - startedAt,
        cullingMs,
        gpuPrepareMs,
        gpuIslandMs,
        canvasIslandMs,
        overlayMs: performance.now() - overlayStartedAt,
        imageBitmapMs,
        compositeMs,
        candidateNodes: candidateNodes.length,
        visibleNodes: visibleNodes.length,
        gpuUploadBytes,
        canvasReadbackBytes: frameRenderCost.canvasReadbackBytes,
        gpuCoverageUpperBoundPixels,
        canvasFallbackCoverageUpperBoundPixels,
        compositeSurfaceBytes: allocatedCompositeSurfaceBytes(),
        rendersPerInputFrame,
      });
      if (activeFrameRenderCost === frameRenderCost) activeFrameRenderCost = undefined;
      emit({
        type: "frame-ready",
        revision,
        pageId: activePageId,
        quality: "settled",
      });
      emitFrameHashEvidence();
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
  } else if (orderedBackendIslandsRendered) {
    // The ordered island executor already painted every document layer. The
    // remaining work in this function is grid and interaction overlays.
  } else if (pageHasFrameChildren || pageHasAlphaMasks || pageHasTransformGroupRepeat || pageHasSubtreeComposition)
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
      gpuRenderedNodeIds,
    );
  else {
    const booleanOperandIds = renderedBooleanOperandIds(renderOrderedNodes);
    const dirtyBounds = useDirtyRegionReplay
      ? dirtyReplayRects.map((rect) => ({
          x: rect.worldBounds.left,
          y: rect.worldBounds.top,
          width: rect.worldBounds.right - rect.worldBounds.left,
          height: rect.worldBounds.bottom - rect.worldBounds.top,
        }))
      : undefined;
    const semanticBounds = useDirtyRegionReplay
      ? new Map(compiledScene?.scene.semanticNodes.map((node) => [node.nodeId, node.effectBounds ?? node.worldBounds]))
      : undefined;
    renderOrderedNodes.forEach((node) => {
      if (gpuRenderedNodeIds?.has(node.id) || booleanOperandIds.has(node.id)) return;
      const sceneBounds = semanticBounds?.get(node.id);
      const replayBounds = sceneBounds
        ? { x: sceneBounds.left, y: sceneBounds.top, width: sceneBounds.right - sceneBounds.left, height: sceneBounds.bottom - sceneBounds.top }
        : nodeBoundsById.get(node.id) ?? rotatedNodeBounds(node);
      if (dirtyBounds && !dirtyBounds.some((bounds) => boundsIntersect(replayBounds, bounds))) return;
      renderNode(context!, node);
    });
  }
  if (!orderedBackendIslandsRendered) {
    canvasIslandMs += performance.now() - canvasFallbackStartedAt;
    canvasFallbackCoverageUpperBoundPixels = clippedNodeCoverageUpperBound(structuralRenderNodes);
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
  const paddingOverlay = !drag || drag.mode === "auto-layout-padding"
    ? autoLayoutPaddingOverlay(nodes, selectedIds, hoveredAutoLayoutPadding, worldTransformById)
    : undefined;
  if (paddingOverlay) renderAutoLayoutPadding(context!, paddingOverlay, toScreen);
  if (selectedIds.length === 1 && visibleSelected.length === 1 && !frameDropTarget && drag?.mode !== "draw") {
    const relationship = selectionParentRelationship(nodes, selectedIds, worldTransformById);
    if (relationship) renderParentRelationship(context!, relationship, toScreen);
  }
  const multiSelection = resolveMultiResizeSelection(nodes, visibleSelected.map((node) => node.id), {
    repeatBoundsForNode: materializedRepeatResizeBounds,
  });
  const renderedMultiSelection = renderMultiResizeSelection(context!, multiSelection);
  if (!renderedMultiSelection) visibleSelected.forEach((node) => renderConstraintGuides(context!, node));
  if (!renderedMultiSelection) visibleSelected.forEach((node) => renderSelection(context!, node));
  if (!renderedMultiSelection) visibleSelected.forEach((node) => renderVectorAnchorOverlay(context!, node));
  if (visibleSelected.length) renderSelectionLabel(context, multiSelection);
  renderPenDraftPreview(context!);
  renderMarquee(context);
  // The grid is a deterministic function of the already-fenced viewport. In
  // a dirty replay this call remains inside the screen-space clip, restoring
  // exactly the cleared grid pixels without repainting the rest of the canvas.
  renderGrid(context);
  if (useDirtyRegionReplay) {
    context.restore();
    const signature = `${activePageId}:${revision}:${sceneResourceGeneration}:${dirtyReplayRects.map((rect) => `${rect.x},${rect.y},${rect.width},${rect.height}`).join(";")}`;
    if (signature !== lastDirtyRegionReplaySignature) {
      lastDirtyRegionReplaySignature = signature;
      diagnostics.record({ category: "renderer", code: "DIRTY_REGION_REPLAY", documentRevision: revision });
    }
  }
  markPresentedScene();
  cacheCurrentPresentedFrameForInteraction();
  compositeSurfaceLimitReported = false;
  renderPerformance.record({
    totalMs: performance.now() - startedAt,
    cullingMs,
    gpuPrepareMs,
    gpuIslandMs,
    canvasIslandMs,
    overlayMs: performance.now() - overlayStartedAt,
    imageBitmapMs,
    compositeMs,
    candidateNodes: candidateNodes.length,
    visibleNodes: visibleNodes.length,
    gpuUploadBytes,
    canvasReadbackBytes: frameRenderCost.canvasReadbackBytes,
    gpuCoverageUpperBoundPixels,
    canvasFallbackCoverageUpperBoundPixels,
    compositeSurfaceBytes: allocatedCompositeSurfaceBytes(),
    rendersPerInputFrame,
  });
  if (activeFrameRenderCost === frameRenderCost) activeFrameRenderCost = undefined;
  emit({
    type: "frame-ready",
    revision,
    pageId: activePageId,
    quality: "settled",
  });
  emitFrameHashEvidence();
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
  if (command.type === "update" || command.type === "resizeWithoutConstraints") command = { ...command, patch: withManualAutoLayoutSizing(nodes, command.id, command.patch) };
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
    const flattened = resolveFlattenBooleanBatch(nodes, command.id, path, createId, command.replacementId, {
      parentId: command.parentId,
      pageId: command.pageId,
      index: command.index,
    });
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
      hoveredAutoLayoutPadding = undefined;
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
    case "resizeWithoutConstraints": commit(() => { nodes = nodes.map((node) => node.id === command.id ? { ...node, ...command.patch } : node); }, appliedByWasm, appliedByWasm ? command : undefined, baseRevision, true, command); break;
    case "reposition": commit(() => {
      const positions = new Map(command.positionIds.map(({ id, positionId }) => [id, positionId]));
      nodes = nodes.map((node) => positions.has(node.id) ? { ...node, positionId: positions.get(node.id)! } : node);
    }, appliedByWasm, appliedByWasm ? { type: "reposition", positionIds: command.positionIds } : undefined, baseRevision, true, command); break;
    case "select": selectedIds = command.ids; hoveredAutoLayoutPadding = undefined; storeActivePageSelection(); render(); emitViewState(); break;
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
        void loadDocumentBridge(
          undefined,
          ephemeralBenchmarkProjection,
          seedAssets,
          command.requestId,
          command.snapshot.format === "benchmark-projection-v1"
            ? command.snapshot.benchmark
            : undefined,
        );
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
    const flattened = path && resolveFlattenBooleanBatch(nodes, command.id, path, createId, command.replacementId, {
      parentId: command.parentId,
      pageId: command.pageId,
      index: command.index,
    });
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
  const pageScopedCommands = coalesceAdjacentNodeUpdates([
    ...normalizationPatches.map(({ id, patch }) => ({ type: "update" as const, id, patch })),
    ...concreteCommands,
  ]).map((command) => {
    if (command.type === "create") return { ...command, node: { ...command.node, pageId: command.node.pageId ?? activePageId } };
    return command;
  }).map((command) => {
    const resolvedText = withResolvedTextAutoSize(command);
    if (resolvedText.type === "update" || resolvedText.type === "resizeWithoutConstraints") return { ...resolvedText, patch: withManualAutoLayoutSizing(nodes, resolvedText.id, resolvedText.patch) };
    return resolvedText;
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
    if (!drag && (hoveredId !== undefined || hoveredAutoLayoutPadding !== undefined)) {
      hoveredId = undefined;
      hoveredAutoLayoutPadding = undefined;
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
    const paddingOverlay = !event.readOnly && context
      ? autoLayoutPaddingOverlay(nodes, selectedIds, hoveredAutoLayoutPadding, worldTransformById)
      : undefined;
    if (paddingOverlay && context && isPointInAutoLayoutPaddingBadge(
      autoLayoutPaddingBadgeBounds(context, paddingOverlay, toScreen),
      { x: event.x, y: event.y },
    )) {
      const frame = nodes.find((node) => node.id === paddingOverlay.frameId);
      const layout = normalizeAutoLayout(frame?.autoLayout);
      if (frame && layout) {
        drag = {
          mode: "auto-layout-padding",
          id: frame.id,
          side: paddingOverlay.side,
          startX: event.x,
          startY: event.y,
          layout,
          before: cloneDocument(),
        };
        return;
      }
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
      drag = { mode: "resize", id: resize.node.id, handle: resize.handle, start: world, node: structuredClone(resize.node), before: cloneDocument(), ignoreConstraints: Boolean(event.ignoreConstraints), previewTransactionId: createId() };
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
      const nextPaddingHover = tool === "select"
        ? autoLayoutPaddingSideAtWorldPoint(nodes, selectedIds, world, viewport.zoom, worldTransformById)
        : undefined;
      if (nextHoveredId !== hoveredId
        || nextPaddingHover?.frameId !== hoveredAutoLayoutPadding?.frameId
        || nextPaddingHover?.side !== hoveredAutoLayoutPadding?.side) {
        hoveredId = nextHoveredId;
        hoveredAutoLayoutPadding = nextPaddingHover;
        render();
      }
    }
    return;
  }
  const activeDrag = drag;
  if (event.readOnly && activeDrag.mode !== "pan" && activeDrag.mode !== "select") {
    // A lease can expire mid-drag. Restore the pre-drag projection instead of
    // leaving an uncommitted visual move in a follower tab.
    if ((activeDrag.mode === "move" || activeDrag.mode === "resize" || activeDrag.mode === "line-resize" || activeDrag.mode === "auto-layout-padding" || activeDrag.mode === "vector-point" || activeDrag.mode === "vector-handle" || activeDrag.mode === "multi-resize" || activeDrag.mode === "rotate") && activeDrag.before) {
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
  if (activeDrag.mode === "resize") {
    activeDrag.ignoreConstraints = Boolean(event.ignoreConstraints);
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
    if (activeDrag.mode === "auto-layout-padding") {
      const delta = autoLayoutPaddingDragDelta(
        { x: activeDrag.startX, y: activeDrag.startY },
        { x: event.x, y: event.y },
      );
      const autoLayout = autoLayoutWithDraggedPadding(activeDrag.layout, activeDrag.side, delta);
      nodes = activeDrag.before.map((node) => node.id === activeDrag.id ? { ...node, autoLayout } : node);
      transientSceneVersion += 1;
      rebuildNodeIndex();
      render();
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
        nodes = coreResizePreview(activeDrag, geometry)
          ?? activeDrag.before.map((node) => node.id === activeDrag.id ? { ...node, ...geometry, ...(vectorPath ? { vectorPath } : {}) } : node);
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
    if (activeDrag.mode === "auto-layout-padding") {
      const autoLayout = nodes.find((node) => node.id === activeDrag.id)?.autoLayout;
      nodes = activeDrag.before;
      transientSceneVersion += 1;
      rebuildNodeIndex();
      if (autoLayout && JSON.stringify(autoLayout.padding) !== JSON.stringify(activeDrag.layout.padding)) {
        dispatch({ type: "update", id: activeDrag.id, patch: { autoLayout } });
      } else {
        render();
        emitViewState();
      }
    }
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
      if (geometry && (hasCommittedResize(before, geometry) || activeDrag.node.rotation !== geometry.rotation || JSON.stringify(activeDrag.node.relativeTransform) !== JSON.stringify(geometry.relativeTransform))) dispatch(activeDrag.ignoreConstraints
        ? { type: "resizeWithoutConstraints", id: activeDrag.id, patch: geometry }
        : { type: "update", id: activeDrag.id, patch: geometry });
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
    if (data.type === "init") { documentId = data.documentId ?? documentId; canvas = data.canvas; rendererPreference = data.rendererPreference; simulatedGpuLossesRequested = Math.min(2, Math.max(0, data.simulateGpuLosses)); simulateGpuLossAfterImage = data.simulateGpuLossAfterImage; simulatedGpuFault = data.simulateGpuFault; simulatedGpuFaultReported = false; captureFrameHash = data.captureFrameHash === true; captureFrameSamples = data.captureFrameSamples ?? []; capturedFrameHashKey = ""; context = canvas.getContext("2d"); setRenderSurface(data.width, data.height, data.dpr); diagnostics.record({ category: "lifecycle", code: "ENGINE_WORKER_READY" }); render(); emit({ type: "ready" }); emitSnapshot(); void loadDocumentBridge(); void probeGpuDevice(); }
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
    else if (data.type === "cancel-figma-rest-assets") cancelFigmaRestAssets(data);
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
    else if (data.type === "auto-layout-padding-hover") {
      hoveredAutoLayoutPadding = data.nodeId && data.side ? { frameId: data.nodeId, side: data.side } : undefined;
      render();
    }
    else if (data.type === "text-caret-layout") void emitRustTextCaretLayout(data);
    else if (data.type === "runtime-export-boolean-paths") emitRuntimeExportBooleanPaths(data);
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
