"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowLeft, Share2 } from "lucide-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IconButton } from "@/components/ui/icon-button";
import {
  appendLocalJournalEntry,
  appendPendingRemoteOperation,
  loadLocalDocument,
  loadPendingRemoteOperations,
  pendingOperationIsCoveredBySnapshot,
  prepareLocalStorage,
  removePendingRemoteOperation,
  removePendingRemoteOperationsCoveredBySnapshot,
  replacePendingRemoteOperation,
  replacePendingRemoteOperations,
  saveLocalDocument,
  saveViewportRecord,
} from "@/lib/local-document";
import {
  createId,
  createNode,
  DEFAULT_TEXT_LINE_HEIGHT,
  documentColorFromCssHex,
  type CanvasNode,
  type ConstraintType,
  type CoreLocalSnapshot,
  type DocumentAsset,
  type DocumentAutoLayout,
  type DocumentBooleanOperation,
  type DocumentColor,
  type DocumentDropShadow,
  type DocumentEffect,
  type DocumentFontReference,
  type DocumentLinearGradient,
  type DocumentPaint,
  type DocumentTextProperties,
  type DocumentVectorPath,
  type EditorCommand,
  type EditorInputEvent,
  type EditorSnapshot,
  type MainToWorker,
  type RendererPreference,
  type SimulatedGpuFault,
  type ToolKind,
  type WorkerToMain,
} from "@/lib/editor-protocol";
import { FontFaceRegistry, fontFamilyForAsset } from "@/lib/font-face-registry";
import { canvasDesignTokens } from "@/lib/canvas-design-tokens";
import {
  layoutTextRanges,
  segmentGraphemes,
  textParagraphRanges,
} from "@/lib/text-layout";
import { styledTextSpans } from "@/lib/text-style-runs";
import {
  patchTextStyleRuns,
  rebaseTextStyleRuns,
  unicodeScalarText,
} from "@/lib/text-style-run-edit";
import { textSelectionStyleSummary } from "@/lib/text-selection-style";
import {
  captureTextClipboard,
  decodeTextClipboard,
  encodeTextClipboard,
  pasteTextClipboard,
} from "@/lib/text-clipboard";
import {
  maintainWriterLease,
  type WriterLease,
  type WriterLeaseMode,
} from "@/lib/writer-lease";
import {
  planWorkerRecovery,
  shouldDeferWorkerRecovery,
} from "@/lib/worker-recovery";
import {
  colorToOpaqueSrgbCss,
  colorToSrgbCss,
  createDefaultLinearGradient,
} from "@/lib/color-rendering";
import {
  createInputBatchBacklogSampler,
  createInputTransferBatcher,
  type InputBatchBacklogSummary,
  type InputTransferBatcher,
} from "@/lib/input-transfer-batcher";
import {
  createFrameIntervalSampler,
  emptyMainThreadLongTaskSummary,
  recordMainThreadLongTask,
  type FrameIntervalSummary,
  type MainThreadLongTaskSummary,
} from "@/lib/main-thread-health";
import {
  createViewportCheckpointSampler,
  type ViewportCheckpointSummary,
} from "@/lib/viewport-checkpoint-performance";
import { encodeInputBatch } from "@/lib/input-transfer";
import { createEditorTransactionQueue } from "@/lib/editor-transaction-queue";
import {
  applyOptimisticUpdates,
  type OptimisticUpdate,
} from "@/lib/optimistic-projection";
import { DocumentApiTransport } from "@/lib/document-api-transport";
import { AssetApiTransport } from "@/lib/asset-api-transport";
import {
  figmaRestImportReport,
  planFigmaRestImport,
  type FigmaRestAssetRequest,
  type FigmaRestImportReport,
} from "@/lib/figma-rest-import";
import { probeAssetInWorker } from "@/lib/asset-probe-client";
import {
  decodeRasterInWorker,
  type DecodedRaster,
} from "@/lib/asset-decode-client";
import {
  formatFontVariationAxes,
  parseFontVariationAxes,
} from "@/lib/font-variation-axes";
import { PendingOperationSynchronizer } from "@/lib/pending-operation-sync";
import {
  deleteUtf16SelectionInRustLayout,
  moveUtf16CaretInRustLayout,
  replaceUtf16SelectionInRustLayout,
  snapUtf16CaretToRustLayout,
  utf16IndexAtUtf8Offset,
  utf8OffsetAtUtf16Index,
  type RustTextCaretLayout,
} from "@/lib/rust-text-caret";
import { LayerPanel } from "./layer-panel";
import {
  SelectionArrangeControls,
  type ArrangeAction,
} from "./selection-arrange-controls";
import { createZoomPerformanceFixture } from "@/lib/zoom-performance-fixture";
import phase0BasicCardFixture from "../../../fixtures/documents/phase0-basic-card.fixture.json";
import phase1TextMultilingualFixture from "../../../fixtures/documents/phase1-text-multilingual.fixture.json";
import phase1Text10kFixture from "../../../fixtures/documents/phase1-text-10k.fixture.json";
import phase1RenderCompositeFixture from "../../../fixtures/documents/phase1-render-composite.fixture.json";
import phase2CommonNodesFixture from "../../../fixtures/documents/phase2-common-nodes.fixture.json";
import { createPhase1Shape100kFixture } from "@/lib/phase1-shape-100k-fixture";
import { createPhase2GpuDropShadowFixture } from "@/lib/phase2-gpu-drop-shadow-fixture";
import { createPhase2GpuLayerBlurFixture } from "@/lib/phase2-gpu-layer-blur-fixture";
import { createPhase2ProfessionalCompositeFixture } from "@/lib/phase2-professional-composite-fixture";
import { createTestOperationsDashboardFixture } from "@/lib/test-operations-dashboard-fixture";
import {
  resolveLayerDrop,
  resolveLayerOrder,
  sortNodesByLayerOrder,
  type LayerOrderAction,
} from "@/lib/layer-order";
import {
  exportPageToSvg,
  type SvgExportResult,
  type SvgTextLayoutProjection,
} from "@/lib/svg-export";
import { withPdfRasterizationFallback } from "@/lib/export-compatibility";
import {
  buildExportManifest,
  buildPdfExportManifestSet,
  type ExportFormat,
  type ExportTarget,
} from "@/lib/export-manifest";
import { pagesInCanonicalExportOrder } from "@/lib/page-export-order";
import {
  admitSliceRasterBatch,
  pdfFromRgbaPages,
  rasterizeSvgToPdfPage,
  rasterizeSvgToPng,
  type PdfExportBackground,
  type SliceExportBackground,
  SliceExportError,
} from "@/lib/slice-export";
import {
  invertAffine,
  multiplyAffine,
  transformPoint,
  worldTransformForNode,
} from "@/lib/scene-transform";
import {
  mixedSelectionValue,
  type MixedSelectionValue,
} from "@/lib/mixed-selection";
import {
  lineSelectionAppearance,
  parseLineDashPattern,
  strokeSelectionAppearance,
} from "@/lib/line-selection-appearance";
import {
  resolvedStrokeWeights,
  strokeWeightSelection,
} from "@/lib/stroke-weight-selection";
import {
  cornerRadiusSelection,
  resolvedCornerRadii,
} from "@/lib/corner-radius-selection";
import { cornerSmoothingSelection } from "@/lib/corner-smoothing-selection";
import {
  constraintSelection,
  type ConstraintSelectionValue,
} from "@/lib/constraint-selection";
import { autoLayoutSizingKeyForAxis } from "@/lib/auto-layout-sizing";
import {
  hasActiveAutoLayoutConstraintOverride,
  hasFrameConstraintScope,
} from "@/lib/frame-constraint-scope";
import {
  mixedInspectorCapabilities,
  supportsCornerRadiusInspector,
  supportsGenericAppearanceInspector,
  supportsPaintStackInspector,
  supportsPerSideStrokeInspector,
  supportsStrokeAlignInspector,
  supportsStrokeDetailsInspector,
} from "@/lib/inspector-capabilities";
import { inspectorCapabilityAnnouncement } from "@/lib/inspector-capability-matrix";
import {
  layerKeyboardNestingTarget,
  type LayerNestingIntent,
} from "@/lib/layer-keyboard-nesting";
import { resolveMultiResizeSelection } from "@/lib/multi-selection";
import { selectionGeometryPatches } from "@/lib/selection-geometry-edit";
import { resolveCanvasObjectSelection } from "@/lib/canvas-selection";
import { ellipseArcUpdatePatch } from "@/lib/ellipse-arc";
import {
  isAlternativeUngroupShortcut,
  shouldClaimKeyboardToolEnter,
} from "@/lib/editor-key-command";
import { statusRevisionIsCurrent } from "@/lib/revision-status";
import {
  decodeNodeClipboard,
  encodeNodeClipboard,
} from "@/lib/editor-clipboard";
import { captureClipboard } from "@/lib/transaction-batch";
import {
  hasMissingRustTextGlyph,
  parseRustTextLayout,
} from "@/lib/rust-text-layout";
import { textSvgLayoutInput } from "@/lib/text-svg-layout-input";
import { FigmaCompatibleRuntime } from "@/runtime/figma-compatible-runtime";
import { RuntimeSession } from "@/runtime/runtime-session";
import {
  RuntimeWorkerBridge,
  runtimeProjectionFromEditorSnapshot,
} from "@/runtime/runtime-worker-bridge";

const tools: Array<{
  id: ToolKind;
  label: string;
  glyph: string;
  key: string;
}> = [
  { id: "select", label: "Move", glyph: "↖", key: "V" },
  { id: "hand", label: "Pan", glyph: "✋", key: "H" },
  { id: "frame", label: "Frame", glyph: "#", key: "F" },
  { id: "section", label: "Section", glyph: "§", key: "S" },
  { id: "rectangle", label: "Rectangle", glyph: "□", key: "R" },
  { id: "ellipse", label: "Ellipse", glyph: "○", key: "O" },
  { id: "polygon", label: "Polygon", glyph: "⬠", key: "" },
  { id: "star", label: "Star", glyph: "☆", key: "" },
  { id: "vector", label: "Vector", glyph: "⌁", key: "" },
  { id: "pen", label: "Pen", glyph: "✒", key: "P" },
  { id: "line", label: "Line", glyph: "／", key: "L" },
  { id: "arrow", label: "Arrow", glyph: "→", key: "A" },
  { id: "text", label: "Text", glyph: "T", key: "T" },
  { id: "slice", label: "Slice", glyph: "◇", key: "" },
];

const defaultPageId = "00000000-0000-0000-0000-000000000001";
const defaultDropShadow = (): DocumentDropShadow => ({
  offsetX: 0,
  offsetY: 4,
  blurRadius: 12,
  spread: 0,
  color: { space: "srgb", components: [0, 0, 0], alpha: 0.25 },
  visible: true,
});
const defaultAutoLayout = (): DocumentAutoLayout => ({
  mode: "vertical",
  padding: [0, 0, 0, 0],
  itemSpacing: 0,
  wrap: false,
  primaryAlignment: "start",
  counterAlignment: "start",
  primarySizing: "fixed",
  counterSizing: "fixed",
  absolute: false,
});
const blankSnapshot: EditorSnapshot = {
  documentId: "00000000-0000-0000-0000-000000000000",
  revision: 0,
  nodes: [],
  pages: [
    {
      id: defaultPageId,
      name: "Page 1",
      positionId:
        "00000000000000000000000000000001:00000000000000000000000000000000",
    },
  ],
  activePageId: defaultPageId,
  selectedIds: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  canUndo: false,
  canRedo: false,
  renderer: "Canvas 2D",
  documentCore: "Starting Rust/WASM bridge",
};
type DocumentUiState = Pick<
  EditorSnapshot,
  | "documentId"
  | "revision"
  | "documentHash"
  | "memory"
  | "resources"
  | "diagnostics"
  | "nodes"
  | "assets"
  | "pages"
  | "activePageId"
  | "canUndo"
  | "canRedo"
  | "renderer"
  | "gpu"
  | "documentCore"
  | "localSnapshot"
  | "localJournalEntry"
>;
type SelectionUiState = { selectedIds: string[] };
type ViewUiState = {
  viewport: EditorSnapshot["viewport"];
  performance?: EditorSnapshot["performance"];
};
const localDevTenantId = "00000000-0000-0000-0000-000000000002";
const localDevActorId = "00000000-0000-0000-0000-000000000007";
const documentApiUrl =
  process.env.NEXT_PUBLIC_DOCUMENT_API_URL ?? "/document-api";
const assetApiUrl = process.env.NEXT_PUBLIC_ASSET_API_URL ?? "/asset-api";
// SVG is intentionally self-contained when a raster asset is available, but a
// document can legally reference much larger source images. Keep that delivery
// artifact bounded and report any remaining image as an explicit fallback.
const MAX_SVG_EMBEDDED_IMAGE_BYTES = 16 * 1024 * 1024;
const SVG_EMBEDDABLE_RASTER_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
const MAX_SVG_EMBEDDED_FONT_BYTES = 16 * 1024 * 1024;
const SVG_EMBEDDABLE_FONT_MEDIA_TYPES = new Set([
  "font/woff2",
  "font/woff",
  "font/ttf",
  "font/otf",
]);
const MAX_FIGMA_REST_IMPORT_BYTES = 16 * 1024 * 1024;
type EditIntent = { at: number; id: string };
type PendingImagePlacement = {
  assetId: string;
  width?: number;
  height?: number;
  targetId?: string;
};
type PendingFigmaImport = {
  transactionId: string;
  report: FigmaRestImportReport;
  assetRequests: FigmaRestAssetRequest[];
};
type PendingFigmaAssetBinding = {
  transactionId: string;
  request: FigmaRestAssetRequest;
};
type CanvasTextEdit = {
  nodeId: string;
  draft: string;
  initialDraft: string;
  properties: DocumentTextProperties;
  caret: number;
  selectionAnchor: number;
  rustCaretReady: boolean;
  rustCaretLayout?: RustTextCaretLayout;
};
type TabMessage =
  | { type: "snapshot"; snapshot: CoreLocalSnapshot }
  | { type: "request-edit"; intent: EditIntent };
/** Fixture-only runtime seed. Canonical Document keeps `DocumentAsset` metadata
 * and node-level image references; bytes are transferred to the Worker after hydration. */
type FixtureAssetSeed = DocumentAsset & {
  bytesBase64: string;
  preRegistered?: true;
};

function sameFigmaAssetRequest(
  left: FigmaRestAssetRequest,
  right: FigmaRestAssetRequest,
) {
  return (
    left.sourceId === right.sourceId &&
    left.nodeId === right.nodeId &&
    left.imageRef === right.imageRef &&
    left.usage === right.usage
  );
}

function imageDataUri(mediaType: string, bytes: ArrayBuffer) {
  const source = new Uint8Array(bytes);
  if (
    !SVG_EMBEDDABLE_RASTER_MEDIA_TYPES.has(mediaType) ||
    !source.byteLength ||
    source.byteLength > MAX_SVG_EMBEDDED_IMAGE_BYTES
  )
    return undefined;
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < source.length; offset += chunkSize)
    binary += String.fromCharCode(
      ...source.subarray(offset, offset + chunkSize),
    );
  return `data:${mediaType};base64,${btoa(binary)}`;
}

function fontDataUri(mediaType: string, bytes: ArrayBuffer) {
  const source = new Uint8Array(bytes);
  if (
    !SVG_EMBEDDABLE_FONT_MEDIA_TYPES.has(mediaType) ||
    !source.byteLength ||
    source.byteLength > MAX_SVG_EMBEDDED_FONT_BYTES
  )
    return undefined;
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < source.length; offset += chunkSize)
    binary += String.fromCharCode(
      ...source.subarray(offset, offset + chunkSize),
    );
  return `data:${mediaType};base64,${btoa(binary)}`;
}

function importedImageNode(
  imageAsset: PendingImagePlacement,
  viewport: EditorSnapshot["viewport"],
) {
  const sourceWidth = imageAsset.width ?? 320;
  const sourceHeight = imageAsset.height ?? 220;
  const scale = Math.min(1, 480 / Math.max(sourceWidth, sourceHeight));
  const image = createNode(
    "image",
    -viewport.x - (sourceWidth * scale) / 2,
    -viewport.y - (sourceHeight * scale) / 2,
  );
  image.assetId = imageAsset.assetId;
  image.width = Math.max(32, sourceWidth * scale);
  image.height = Math.max(32, sourceHeight * scale);
  image.name = "Imported image";
  return image;
}

function imageFillTarget(
  nodes: readonly CanvasNode[],
  selectedIds: readonly string[],
) {
  const selected =
    selectedIds.length === 1
      ? nodes.find((node) => node.id === selectedIds[0])
      : undefined;
  return selected &&
    !selected.locked &&
    ["frame", "rectangle", "ellipse", "image"].includes(selected.kind)
    ? selected
    : undefined;
}

/** Derives export-only Boolean paths from the same Rust/WASM clipping bridge as
 * Canvas. Nothing returned here is committed to the document snapshot. */
async function deriveBooleanSvgPaths(nodes: readonly CanvasNode[]) {
  const wasm = await import("@/wasm/generated/editor_wasm");
  await wasm.default();
  const paths = new Map<string, DocumentVectorPath>();
  for (const boolean of nodes.filter(
    (node) => node.kind === "booleanOperation",
  )) {
    const operands = sortNodesByLayerOrder(
      nodes.filter((node) => node.parentId === boolean.id),
    );
    if (
      operands.length < 2 ||
      operands.some((node) => node.kind !== "vector" || !node.vectorPath)
    )
      continue;
    const booleanWorld = worldTransformForNode(nodes, boolean.id);
    const booleanInverse = booleanWorld && invertAffine(booleanWorld);
    if (!booleanInverse) continue;
    const projected = operands.map((operand) => {
      const operandWorld = worldTransformForNode(nodes, operand.id);
      const transform =
        operandWorld && multiplyAffine(booleanInverse, operandWorld);
      if (!transform || !operand.vectorPath) return undefined;
      return {
        fillRule: operand.vectorPath.fillRule,
        subpaths: operand.vectorPath.subpaths.map((subpath) => ({
          closed: subpath.closed,
          points: subpath.points.map((point) => {
            const anchor = transformPoint(transform, point);
            const transformHandle = (handle: typeof point.handleIn) => {
              if (!handle) return undefined;
              const control = transformPoint(transform, {
                x: point.x + handle.x,
                y: point.y + handle.y,
              });
              return { x: control.x - anchor.x, y: control.y - anchor.y };
            };
            return {
              id: point.id,
              x: anchor.x,
              y: anchor.y,
              handleIn: transformHandle(point.handleIn),
              handleOut: transformHandle(point.handleOut),
              pointType: point.pointType,
            };
          }),
        })),
      };
    });
    if (projected.some((path) => !path)) continue;
    try {
      const value: unknown = JSON.parse(
        wasm.boolean_vector_paths_json(
          boolean.booleanOperation ?? "union",
          JSON.stringify(projected),
          0.25,
        ),
      );
      const subpaths =
        typeof value === "object" &&
        value !== null &&
        "subpaths" in value &&
        Array.isArray((value as { subpaths?: unknown }).subpaths)
          ? (value as { subpaths: unknown[] }).subpaths.map(
              (subpath, subpathIndex) => {
                if (
                  typeof subpath !== "object" ||
                  subpath === null ||
                  (subpath as { closed?: unknown }).closed !== true ||
                  !Array.isArray((subpath as { points?: unknown }).points)
                )
                  return undefined;
                const points = (subpath as { points: unknown[] }).points.map(
                  (point, pointIndex) =>
                    Array.isArray(point) &&
                    point.length === 2 &&
                    point.every(
                      (coordinate) =>
                        typeof coordinate === "number" &&
                        Number.isFinite(coordinate),
                    )
                      ? {
                          id: `${boolean.id}:svg:${subpathIndex}:${pointIndex}`,
                          x: point[0],
                          y: point[1],
                          pointType:
                            "corner" as DocumentVectorPath["subpaths"][number]["points"][number]["pointType"],
                        }
                      : undefined,
                );
                return points.length >= 3 &&
                  points.every(
                    (
                      point,
                    ): point is DocumentVectorPath["subpaths"][number]["points"][number] =>
                      Boolean(point),
                  )
                  ? { closed: true, points }
                  : undefined;
              },
            )
          : undefined;
      if (
        subpaths?.length &&
        subpaths.every(
          (subpath): subpath is DocumentVectorPath["subpaths"][number] =>
            Boolean(subpath),
        )
      )
        paths.set(boolean.id, { fillRule: "nonZero", subpaths });
    } catch {
      // `exportPageToSvg` retains the explicit compatibility warning when a
      // malformed or over-budget Boolean cannot be derived for this export.
    }
  }
  return paths;
}

/** Freeze authored cubic Vector geometry for SVG and its PNG/PDF raster source.
 * Browsers render these handles natively at target resolution, so replacing
 * them with a document-space polyline permanently facets scalable SVG.
 * Boolean and Outline results still use bounded Rust-derived geometry. */
async function deriveVectorSvgPaths(nodes: readonly CanvasNode[]) {
  const paths = new Map<string, DocumentVectorPath>();
  for (const node of nodes) {
    if (node.kind !== "vector" || !node.vectorPath) continue;
    paths.set(node.id, structuredClone(node.vectorPath));
  }
  return paths;
}

/** Freeze the same single-face ICU4X/Rustybuzz line ranges Canvas can use.
 * Contiguous paint-only Style Runs share the same advances and therefore can
 * use this projection too; metric-changing or missing-font runs deliberately
 * remain on their existing browser/system fallback path. */
async function deriveTextSvgLayouts(
  nodes: readonly CanvasNode[],
  fontBytes: ReadonlyMap<string, ArrayBuffer>,
) {
  const wasm = await import("@/wasm/generated/editor_wasm");
  await wasm.default();
  const layouts = new Map<string, SvgTextLayoutProjection>();
  for (const node of nodes) {
    if (node.kind !== "text") continue;
    const input = textSvgLayoutInput(node, fontBytes);
    if (!input) continue;
    try {
      const payload = wasm.layout_shaped_text_with_variations_json(
        new Uint8Array(input.fontBytes),
        input.faceIndex,
        input.axes,
        input.source,
        node.width / input.fontSize,
      );
      const layout = parseRustTextLayout(payload, input.source);
      if (!layout || hasMissingRustTextGlyph(layout)) continue;
      layouts.set(node.id, {
        lines: layout.lines.map(({ start, end, direction }) => ({
          start,
          end,
          direction,
        })),
      });
    } catch {
      // Export retains its established system-font fallback without writing a
      // derived layout into the Canonical document.
    }
  }
  return layouts;
}

/** Export-only Polygon/Star outlines from the same Core bridge Canvas uses.
 * The returned points are never written to the Canonical document. */
async function deriveParametricSvgPaths(nodes: readonly CanvasNode[]) {
  const wasm = await import("@/wasm/generated/editor_wasm");
  await wasm.default();
  const paths = new Map<string, readonly { x: number; y: number }[]>();
  for (const node of nodes) {
    if (
      (node.kind !== "polygon" && node.kind !== "star") ||
      !node.parametricShape
    )
      continue;
    try {
      const value: unknown = JSON.parse(
        wasm.parametric_shape_outline_json(
          node.width,
          node.height,
          JSON.stringify(node.parametricShape),
        ),
      );
      const points =
        typeof value === "object" &&
        value !== null &&
        "points" in value &&
        Array.isArray((value as { points?: unknown }).points)
          ? (value as { points: unknown[] }).points.map((point) =>
              Array.isArray(point) &&
              point.length === 2 &&
              point.every(
                (coordinate) =>
                  typeof coordinate === "number" && Number.isFinite(coordinate),
              )
                ? { x: point[0], y: point[1] }
                : undefined,
            )
          : undefined;
      if (
        points &&
        points.length >= 3 &&
        points.every((point): point is { x: number; y: number } =>
          Boolean(point),
        )
      )
        paths.set(node.id, points);
    } catch {
      // SVG keeps its deterministic TypeScript fallback until this bridge is available.
    }
  }
  return paths;
}

function importFailureMessage(code: string) {
  if (code === "RESOURCE_LIMIT")
    return "Import failed · image exceeds the 256 MB / 256 MP import limit";
  return `Import failed · ${code.toLowerCase().replaceAll("_", " ")}`;
}

function newerEditIntent(candidate: EditIntent, current: EditIntent) {
  return (
    candidate.at > current.at ||
    (candidate.at === current.at && candidate.id > current.id)
  );
}

function sameIds(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

/** Content replacement is one atomic Canonical update. Existing UTF-8 style
 * runs are rebased so editing one span never flattens neighbouring text. */
function textReplacementProperties(
  node: CanvasNode,
  text: string,
): DocumentTextProperties {
  const properties: DocumentTextProperties = node.textProperties ?? {
    runs: [],
    paragraph: {
      alignment: "left",
      lineHeight: DEFAULT_TEXT_LINE_HEIGHT,
      paragraphSpacing: 0,
    },
    autoSize: "fixed",
    fallbackFonts: [],
  };
  return rebaseTextStyleRuns(node.text ?? "", text, properties);
}

/** Applies pending DOM edits to the last trusted canvas-text baseline before
 * consuming clipboard data. The baseline is advanced after a rich paste/cut,
 * so a following keystroke preserves the pasted Style Runs as well. */
function canvasTextDraftProperties(
  edit: CanvasTextEdit,
): DocumentTextProperties {
  return rebaseTextStyleRuns(edit.initialDraft, edit.draft, edit.properties);
}

/** The Inspector owns the initial intent, so it also supplies a deterministic
 * geometry patch for auto-sized text. The worker repeats this measurement with
 * its loaded FontFace; including it here keeps the selected dimensions responsive
 * even while that worker font is still becoming ready. */
function resolveTextAutoSizePatch(
  node: CanvasNode,
  patch: Partial<CanvasNode>,
): Partial<CanvasNode> {
  if (node.kind !== "text") return patch;
  const properties = patch.textProperties ?? node.textProperties;
  if (!properties || properties.autoSize === "fixed") return patch;
  const primary = properties.runs[0];
  const fontSize = primary?.fontSize ?? 31;
  const lineHeight =
    properties.paragraph.lineHeight ?? DEFAULT_TEXT_LINE_HEIGHT;
  const letterSpacing = primary?.letterSpacing ?? 0;
  const measure = (value: string) => {
    if (typeof document === "undefined")
      return Array.from(value).length * fontSize * 0.6;
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return Array.from(value).length * fontSize * 0.6;
    const family = primary?.font
      ? `"${fontFamilyForAsset(primary.font.assetId)}", `
      : "";
    ctx.font = `${primary?.italic ? "italic " : ""}${primary?.fontWeight ?? canvasDesignTokens.typography.canvasText.weight} ${fontSize}px ${family}${canvasDesignTokens.typography.canvasText.family}`;
    return (
      ctx.measureText(value).width +
      Math.max(0, Array.from(value).length - 1) * letterSpacing
    );
  };
  const text = patch.text ?? node.text ?? "";
  const nextWidth = patch.width ?? node.width;
  const maxWidth =
    properties.autoSize === "widthAndHeight"
      ? Number.POSITIVE_INFINITY
      : Math.max(1, nextWidth);
  const lines = layoutTextRanges({ text, maxWidth, measure });
  const paragraphBreaks = Math.max(
    0,
    (text.match(/\r\n|[\n\r\u2028\u2029]/gu) ?? []).length,
  );
  const height = Math.max(
    1,
    lines.length * lineHeight +
      paragraphBreaks * properties.paragraph.paragraphSpacing,
  );
  const width = Math.max(1, ...lines.map((line) => measure(line.text)));
  return {
    ...patch,
    height,
    ...(properties.autoSize === "widthAndHeight" ? { width } : {}),
  };
}

function textNodeContainsPoint(
  node: CanvasNode,
  point: { x: number; y: number },
) {
  if (node.kind !== "text" || node.visible === false) return false;
  const centerX = node.x + node.width / 2;
  const centerY = node.y + node.height / 2;
  const radians = (-node.rotation * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const dx = point.x - centerX;
  const dy = point.y - centerY;
  const localX = dx * cosine - dy * sine + node.width / 2;
  const localY = dx * sine + dy * cosine + node.height / 2;
  return (
    localX >= 0 && localX <= node.width && localY >= 0 && localY <= node.height
  );
}

function textLocalPoint(node: CanvasNode, point: { x: number; y: number }) {
  const centerX = node.x + node.width / 2;
  const centerY = node.y + node.height / 2;
  const radians = (-node.rotation * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const dx = point.x - centerX;
  const dy = point.y - centerY;
  return {
    x: dx * cosine - dy * sine + node.width / 2,
    y: dx * sine + dy * cosine + node.height / 2,
  };
}

/** Native textarea controls use a browser-specific internal text layout. The
 * Canvas renderer follows ordinary CSS inline line boxes, so the editable DOM
 * layer must do the same. This puts a collapsed selection at a UTF-16 offset
 * without changing the document text or adding a visual wrapper. */
function placeContentEditableCaret(editor: HTMLElement, targetOffset: number) {
  const selection = window.getSelection();
  if (!selection) return;
  const placeIn = (container: Node, offset: number) => {
    const range = document.createRange();
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    let textNode = walker.nextNode();
    while (textNode) {
      const length = textNode.textContent?.length ?? 0;
      if (remaining <= length) {
        range.setStart(textNode, remaining);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      remaining -= length;
      textNode = walker.nextNode();
    }
    range.selectNodeContents(container);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  };
  const paragraphs = [
    ...editor.querySelectorAll<HTMLElement>(":scope > .canvas-text-paragraph"),
  ];
  if (paragraphs.length) {
    let remaining = targetOffset;
    for (let index = 0; index < paragraphs.length; index += 1) {
      const paragraph = paragraphs[index];
      const length = paragraph.innerText.length;
      if (remaining <= length) {
        placeIn(paragraph, remaining);
        return;
      }
      remaining -= length;
      if (index < paragraphs.length - 1) {
        if (remaining === 0) {
          placeIn(paragraph, length);
          return;
        }
        remaining -= 1;
      }
    }
    placeIn(paragraphs[paragraphs.length - 1], Number.MAX_SAFE_INTEGER);
    return;
  }
  const range = document.createRange();
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let remaining = targetOffset;
  let textNode = walker.nextNode();
  while (textNode) {
    const length = textNode.textContent?.length ?? 0;
    if (remaining <= length) {
      range.setStart(textNode, remaining);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    remaining -= length;
    textNode = walker.nextNode();
  }
  range.selectNodeContents(editor);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function contentEditablePointAtOffset(
  editor: HTMLElement,
  targetOffset: number,
) {
  const pointIn = (container: Node, offset: number) => {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let remaining = Math.max(0, offset);
    let textNode = walker.nextNode();
    while (textNode) {
      const length = textNode.textContent?.length ?? 0;
      if (remaining <= length) return { node: textNode, offset: remaining };
      remaining -= length;
      textNode = walker.nextNode();
    }
    return { node: container, offset: container.childNodes.length };
  };
  const paragraphs = [
    ...editor.querySelectorAll<HTMLElement>(":scope > .canvas-text-paragraph"),
  ];
  if (!paragraphs.length) return pointIn(editor, targetOffset);
  let remaining = Math.max(0, targetOffset);
  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index];
    const length = paragraph.innerText.length;
    if (remaining <= length) return pointIn(paragraph, remaining);
    remaining -= length;
    if (index < paragraphs.length - 1) {
      if (remaining === 0) return pointIn(paragraph, length);
      remaining -= 1;
    }
  }
  return pointIn(paragraphs[paragraphs.length - 1], Number.MAX_SAFE_INTEGER);
}

function placeContentEditableSelection(
  editor: HTMLElement,
  anchorOffset: number,
  focusOffset: number,
) {
  const selection = window.getSelection();
  if (!selection) return;
  const anchor = contentEditablePointAtOffset(editor, anchorOffset);
  const focus = contentEditablePointAtOffset(editor, focusOffset);
  if (typeof selection.setBaseAndExtent === "function") {
    selection.setBaseAndExtent(
      anchor.node,
      anchor.offset,
      focus.node,
      focus.offset,
    );
    return;
  }
  const range = document.createRange();
  range.setStart(anchor.node, anchor.offset);
  range.setEnd(focus.node, focus.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Applies an already Rust-validated replacement directly to the editable DOM.
 * React intentionally does not reconcile contentEditable children on each
 * keystroke, so state alone would leave a cancelled beforeinput visually stale. */
function replaceContentEditableRange(
  editor: HTMLElement,
  startOffset: number,
  endOffset: number,
  replacement: string,
) {
  const start = contentEditablePointAtOffset(editor, startOffset);
  const end = contentEditablePointAtOffset(editor, endOffset);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  range.deleteContents();
  if (replacement) range.insertNode(document.createTextNode(replacement));
}

/** Reads the browser's current UTF-16 selection without treating it as a
 * durable truth. The Worker subsequently snaps it to Rust's legal UTF-8 map. */
function contentEditableCaretOffset(editor: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return editor.innerText.length;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.endContainer)) return editor.innerText.length;
  const before = range.cloneRange();
  before.selectNodeContents(editor);
  before.setEnd(range.endContainer, range.endOffset);
  return before.toString().length;
}

function contentEditableOffsetAtPoint(
  editor: HTMLElement,
  node: Node | null,
  offset: number,
) {
  if (!node || !editor.contains(node)) return editor.innerText.length;
  const before = document.createRange();
  before.selectNodeContents(editor);
  before.setEnd(node, offset);
  return before.toString().length;
}

function contentEditableSelectionOffsets(editor: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return undefined;
  return {
    anchor: contentEditableOffsetAtPoint(
      editor,
      selection.anchorNode,
      selection.anchorOffset,
    ),
    focus: contentEditableOffsetAtPoint(
      editor,
      selection.focusNode,
      selection.focusOffset,
    ),
  };
}

/** `contentEditable` can bypass beforeinput during some IME/OS commits. Keep
 * its transient DOM and React draft on the same scalar-only text contract as
 * Inspector and clipboard input. Every replacement is one UTF-16 code unit,
 * so the current DOM caret offset remains valid. */
function normalizedContentEditableText(editor: HTMLElement) {
  const source = editor.innerText;
  const normalized = unicodeScalarText(source);
  if (normalized !== source)
    replaceContentEditableRange(editor, 0, source.length, normalized);
  return normalized;
}

/** Converts a Canvas double-click into the same insertion position the text
 * editor would select if it had received that pointer event directly. */
function textCaretAtPoint(node: CanvasNode, point: { x: number; y: number }) {
  const text = node.text ?? "";
  const properties = node.textProperties;
  const primary = properties?.runs[0];
  const fontSize = primary?.fontSize ?? 31;
  const lineHeight =
    properties?.paragraph.lineHeight ?? DEFAULT_TEXT_LINE_HEIGHT;
  const letterSpacing = primary?.letterSpacing ?? 0;
  const local = textLocalPoint(node, point);
  const ctx =
    typeof document === "undefined"
      ? undefined
      : document.createElement("canvas").getContext("2d");
  const family = primary?.font
    ? `"${fontFamilyForAsset(primary.font.assetId)}", `
    : "";
  if (ctx)
    ctx.font = `${primary?.italic ? "italic " : ""}${primary?.fontWeight ?? canvasDesignTokens.typography.canvasText.weight} ${fontSize}px ${family}${canvasDesignTokens.typography.canvasText.family}`;
  const measure = (value: string) =>
    (ctx?.measureText(value).width ??
      Array.from(value).length * fontSize * 0.6) +
    Math.max(0, segmentGraphemes(value).length - 1) * letterSpacing;
  const lines = layoutTextRanges({
    text,
    maxWidth: Math.max(1, node.width),
    measure,
  });
  const bytes = new TextEncoder().encode(text);
  let lineTop = 0;
  let previousEnd = 0;
  for (const line of lines) {
    const skipped = new TextDecoder().decode(
      bytes.slice(previousEnd, line.start),
    );
    if (/\r\n|[\n\r\u2028\u2029]/u.test(skipped))
      lineTop += properties?.paragraph.paragraphSpacing ?? 0;
    const lineBottom = lineTop + lineHeight;
    if (local.y <= lineBottom) {
      const lineWidth = measure(line.text);
      const alignment = properties?.paragraph.alignment ?? "left";
      let x =
        alignment === "center"
          ? (node.width - lineWidth) / 2
          : alignment === "right"
            ? node.width - lineWidth
            : 0;
      let index = utf16IndexAtUtf8Offset(text, line.start);
      for (const grapheme of segmentGraphemes(line.text)) {
        const width = measure(grapheme);
        if (local.x <= x + width / 2) return index;
        x += width;
        index += grapheme.length;
      }
      return utf16IndexAtUtf8Offset(text, line.end);
    }
    lineTop = lineBottom;
    previousEnd = line.end;
  }
  return text.length;
}

function requestedFixtureSnapshot(
  initialFixture?: string,
): Extract<EditorCommand, { type: "hydrate" }>["snapshot"] | undefined {
  if (typeof window === "undefined") return undefined;
  const fixture =
    initialFixture ??
    new URLSearchParams(window.location.search).get("fixture");
  if (fixture === "zoom-50k") {
    const performanceFixture = createZoomPerformanceFixture();
    return {
      format: "benchmark-projection-v1",
      nodes: performanceFixture.nodes,
      viewport: performanceFixture.viewport,
    };
  }
  if (fixture === "phase1-shape-100k") {
    const performanceFixture = createPhase1Shape100kFixture();
    return {
      format: "benchmark-projection-v1",
      nodes: performanceFixture.nodes,
      viewport: performanceFixture.viewport,
    };
  }
  const requestedDocumentFixture =
    fixture === "phase0-basic-card"
      ? phase0BasicCardFixture
      : fixture === "test-operations-dashboard"
        ? createTestOperationsDashboardFixture()
        : fixture === "phase1-text-multilingual"
          ? phase1TextMultilingualFixture
          : fixture === "phase1-text-10k"
            ? phase1Text10kFixture
            : fixture === "phase1-render-composite"
              ? {
                  ...phase1RenderCompositeFixture,
                  nodes: phase1RenderCompositeFixture.nodes.filter(
                    (node) => node.kind !== "image",
                  ),
                }
              : fixture === "phase2-common-nodes"
                ? phase2CommonNodesFixture
                : fixture === "phase2-professional-composite"
                  ? createPhase2ProfessionalCompositeFixture()
                  : fixture === "phase2-gpu-drop-shadow"
                    ? createPhase2GpuDropShadowFixture()
                    : fixture === "phase2-gpu-layer-blur"
                      ? createPhase2GpuLayerBlurFixture()
                      : undefined;
  if (!requestedDocumentFixture) return undefined;
  return {
    format: "legacy-projection-v0",
    nodes: structuredClone(requestedDocumentFixture.nodes) as CanvasNode[],
    viewport: structuredClone(requestedDocumentFixture.viewport),
    ...(fixture === "phase2-professional-composite"
      ? {
          assets: structuredClone(
            createPhase2ProfessionalCompositeFixture().assets,
          ) as DocumentAsset[],
        }
      : {}),
  };
}

function requestedFixtureAssetSeeds(
  initialFixture?: string,
): FixtureAssetSeed[] {
  if (typeof window === "undefined") return [];
  const fixture =
    initialFixture ??
    new URLSearchParams(window.location.search).get("fixture");
  if (fixture === "phase1-render-composite")
    return structuredClone(
      phase1RenderCompositeFixture.assets,
    ) as FixtureAssetSeed[];
  if (fixture === "phase2-professional-composite")
    return structuredClone(
      createPhase2ProfessionalCompositeFixture().assets.filter(
        (asset): asset is FixtureAssetSeed =>
          typeof asset.bytesBase64 === "string",
      ),
    );
  return [];
}

function requestedFixtureAssetNodes(initialFixture?: string): CanvasNode[] {
  if (typeof window === "undefined") return [];
  const fixture =
    initialFixture ??
    new URLSearchParams(window.location.search).get("fixture");
  if (fixture === "phase1-render-composite")
    return structuredClone(
      phase1RenderCompositeFixture.nodes.filter(
        (node) => node.kind === "image",
      ),
    ) as CanvasNode[];
  return [];
}

function decodeFixtureAssetBytes(seed: FixtureAssetSeed): ArrayBuffer {
  const encoded = atob(seed.bytesBase64);
  const bytes = new Uint8Array(encoded.length);
  for (let index = 0; index < encoded.length; index += 1)
    bytes[index] = encoded.charCodeAt(index);
  if (bytes.byteLength !== seed.byteLength)
    throw new Error("FIXTURE_ASSET_LENGTH_MISMATCH");
  return bytes.buffer;
}

function requestedFixtureStatus(initialFixture?: string) {
  if (typeof window === "undefined") return "fixed fixture loaded";
  const fixture =
    initialFixture ??
    new URLSearchParams(window.location.search).get("fixture");
  if (fixture === "test-operations-dashboard")
    return "editable operations dashboard loaded";
  if (fixture === "phase1-shape-100k")
    return "generated Phase 1 F-SHAPE-100K fixture loaded";
  if (fixture === "phase1-text-10k")
    return "fixed Phase 1 F-TEXT-10K fixture loaded";
  if (fixture === "phase1-text-multilingual")
    return "fixed Phase 1 text fixture loaded";
  if (fixture === "phase1-render-composite")
    return "fixed Phase 1 render composite fixture loaded";
  if (fixture === "phase2-common-nodes")
    return "fixed Phase 2 common-nodes fixture loaded";
  if (fixture === "phase2-professional-composite")
    return "fixed Phase 2 professional composite fixture loaded";
  if (fixture === "phase2-gpu-drop-shadow")
    return "fixed Phase 2 GPU Drop Shadow fixture loaded";
  if (fixture === "phase2-gpu-layer-blur")
    return "fixed Phase 2 GPU Layer Blur fixture loaded";
  return "fixed Phase 0 fixture loaded";
}

function isDeterministicEvidenceCapture() {
  if (typeof window === "undefined") return false;
  const search = new URLSearchParams(window.location.search);
  return (
    search.get("fixture") === "phase0-basic-card" &&
    search.get("renderer") === "canvas2d"
  );
}

function requestedRendererPreference(): RendererPreference {
  if (typeof window === "undefined") return "auto";
  return new URLSearchParams(window.location.search).get("renderer") ===
    "canvas2d"
    ? "canvas2d"
    : "auto";
}

function isStabilityEvidenceCapture() {
  if (process.env.NODE_ENV === "production" || typeof window === "undefined")
    return false;
  return (
    new URLSearchParams(window.location.search).get("stabilityEvidence") === "1"
  );
}

function requestedStabilityAssetReadDelayMs() {
  if (!isStabilityEvidenceCapture()) return 0;
  const requested = Number(
    new URLSearchParams(window.location.search).get("simulateAssetReadDelayMs"),
  );
  return Number.isInteger(requested)
    ? Math.min(15_000, Math.max(0, requested))
    : 0;
}

function waitForStabilityAssetReadDelay(signal: AbortSignal) {
  const delayMs = requestedStabilityAssetReadDelayMs();
  if (delayMs === 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new DOMException("The asset import was cancelled.", "AbortError"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function requestedGpuLossSimulationCount(): number {
  if (process.env.NODE_ENV === "production" || typeof window === "undefined")
    return 0;
  const search = new URLSearchParams(window.location.search);
  if (
    !["phase0-basic-card", "phase1-render-composite"].includes(
      search.get("fixture") ?? "",
    ) &&
    !isStabilityEvidenceCapture()
  )
    return 0;
  const requested = Number(search.get("simulateGpuLoss"));
  return Number.isInteger(requested) ? Math.min(2, Math.max(0, requested)) : 0;
}

/** The image fixture delays development-only loss injection until its decoded
 * bitmap has been submitted once, exercising texture re-upload after recovery. */
function requestedGpuLossAfterImage() {
  if (process.env.NODE_ENV === "production" || typeof window === "undefined")
    return false;
  const search = new URLSearchParams(window.location.search);
  return (
    search.get("fixture") === "phase1-render-composite" &&
    requestedGpuLossSimulationCount() > 0
  );
}

function requestedGpuFaultSimulation(): SimulatedGpuFault | undefined {
  if (process.env.NODE_ENV === "production" || typeof window === "undefined")
    return undefined;
  const search = new URLSearchParams(window.location.search);
  if (
    !["phase0-basic-card", "phase1-render-composite"].includes(
      search.get("fixture") ?? "",
    )
  )
    return undefined;
  const fault = search.get("simulateGpuFault");
  return fault === "out-of-memory" ||
    fault === "validation" ||
    fault === "upload"
    ? fault
    : undefined;
}

function requestedEngineCrashSimulationCount(): number {
  if (process.env.NODE_ENV === "production" || typeof window === "undefined")
    return 0;
  const search = new URLSearchParams(window.location.search);
  if (
    search.get("fixture") !== "phase0-basic-card" &&
    !isStabilityEvidenceCapture()
  )
    return 0;
  const requested = Number(search.get("simulateWorkerCrash"));
  return Number.isInteger(requested) ? Math.min(2, Math.max(0, requested)) : 0;
}

function requestedEngineCrashSimulationDelayMs(): number {
  if (process.env.NODE_ENV === "production" || typeof window === "undefined")
    return 100;
  const search = new URLSearchParams(window.location.search);
  if (
    search.get("fixture") !== "phase0-basic-card" &&
    !isStabilityEvidenceCapture()
  )
    return 100;
  const requested = Number(search.get("simulateWorkerCrashDelayMs"));
  return Number.isInteger(requested)
    ? Math.min(5_000, Math.max(0, requested))
    : 100;
}

function changesDocument(command: EditorCommand) {
  return command.type !== "select" && command.type !== "select-page";
}

export function EditorShell({
  documentId,
  documentName = "Orbit card exploration",
  workspaceHref,
  remoteSync = true,
  writerLock = true,
  initialFixture,
  onRenameDocument,
  onDocumentSaved,
}: {
  documentId?: string;
  documentName?: string;
  workspaceHref?: string;
  remoteSync?: boolean;
  writerLock?: boolean;
  initialFixture?: string;
  onRenameDocument?: (name: string) => void;
  onDocumentSaved?: (revision: number) => void;
}) {
  const writerLockName = `makefigma:${documentId ?? "starter-document"}`;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // An OffscreenCanvas transfer is irreversible. Development Strict Mode and
  // Fast Refresh can re-run this component effect against the old element, so
  // replace that element before attempting to boot another worker.
  const transferredCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  /** Runtime API state is deliberately separate from the editor's React
   * projection. The Worker remains the only Canonical mutation authority. */
  const runtimeRef = useRef<FigmaCompatibleRuntime | null>(null);
  const runtimeBridgeRef = useRef<RuntimeWorkerBridge | null>(null);
  const restoredRef = useRef(false);
  const remoteBootstrapRequestedRef = useRef(false);
  const resetPendingRef = useRef(false);
  const fixtureResetPendingRef = useRef(false);
  const fixtureResetRequestIdRef = useRef<string | undefined>(undefined);
  const remoteAdoptedRevisionRef = useRef<
    { documentId: string; revision: number } | undefined
  >(undefined);
  const revisionRef = useRef(0);
  const snapshotRef = useRef<EditorSnapshot>(blankSnapshot);
  const confirmedSnapshotRef = useRef<EditorSnapshot>(blankSnapshot);
  const recoverySnapshotRef = useRef<CoreLocalSnapshot | undefined>(undefined);
  const recoveryFailuresRef = useRef(0);
  const workerRecoveryAwaitingConfirmationRef = useRef(false);
  const offlineWorkerRecoveryPendingRef = useRef(false);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const recoveryStabilityTimerRef = useRef<
    ReturnType<typeof setTimeout> | undefined
  >(undefined);
  const viewportCheckpointTimerRef = useRef<
    ReturnType<typeof setTimeout> | undefined
  >(undefined);
  const assetInputRef = useRef<HTMLInputElement>(null);
  const figmaImportInputRef = useRef<HTMLInputElement>(null);
  const figmaAssetInputRef = useRef<HTMLInputElement>(null);
  const assetUploadAbortRef = useRef<AbortController | null>(null);
  /** The DOM editor needs the same document-scoped family the Worker uses. */
  const mainFontFacesRef = useRef(new FontFaceRegistry());
  const mainFontBytesRef = useRef(new Map<string, ArrayBuffer>());
  const exportImageBytesRef = useRef(new Map<string, ArrayBuffer>());
  const pendingImagePlacementRef = useRef<PendingImagePlacement | undefined>(
    undefined,
  );
  const pendingFigmaImportRef = useRef<PendingFigmaImport | undefined>(
    undefined,
  );
  const pendingFigmaAssetBindingRef = useRef<
    PendingFigmaAssetBinding | undefined
  >(undefined);
  const persistenceQueue = useRef(Promise.resolve());
  const remoteSyncQueue = useRef(Promise.resolve());
  const writerRef = useRef(false);
  // React state is intentionally asynchronous. Keyboard shortcuts need the
  // just-selected tool synchronously so Enter cannot fall through to a stale
  // focused toolbar button.
  const activeToolRef = useRef<ToolKind>("select");
  const writerLeaseRef = useRef<WriterLease | null>(null);
  const editIntentRef = useRef<EditIntent | undefined>(undefined);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const inputBatcherRef = useRef<InputTransferBatcher | null>(null);
  const transactionQueueRef = useRef<ReturnType<
    typeof createEditorTransactionQueue
  > | null>(null);
  const optimisticUpdatesRef = useRef(new Map<string, OptimisticUpdate>());
  const simulatedWorkerCrashesRef = useRef(0);
  const fixtureBenchmarkStartedRef = useRef(false);
  const fixtureAssetsSeededRef = useRef(false);
  const fixtureAssetNodesCreatedRef = useRef(false);
  const frameIntervalSamplerRef = useRef(createFrameIntervalSampler());
  const inputBacklogSamplerRef = useRef(createInputBatchBacklogSampler());
  const viewportCheckpointSamplerRef = useRef(
    createViewportCheckpointSampler(),
  );
  const [documentState, setDocumentState] =
    useState<DocumentUiState>(blankSnapshot);
  const [documentHydrated, setDocumentHydrated] = useState(false);
  const [firstFrameReady, setFirstFrameReady] = useState(false);
  const [frameQuality, setFrameQuality] = useState<
    "pending" | "preview" | "sharp" | "settled"
  >("pending");
  const [documentLoadingState, setDocumentLoadingState] = useState<{
    label: string;
    completed?: number;
    total?: number;
  }>({ label: "正在读取设计文档…" });
  const [documentAuthorityReady, setDocumentAuthorityReady] = useState(false);
  const [reconciliationProgress, setReconciliationProgress] = useState<{
    completed: number;
    total: number;
  }>();
  const [selectionState, setSelectionState] = useState<SelectionUiState>({
    selectedIds: blankSnapshot.selectedIds,
  });
  const [viewState, setViewState] = useState<ViewUiState>({
    viewport: blankSnapshot.viewport,
  });
  const [tool, setTool] = useState<ToolKind>("select");
  const [status, setStatus] = useState("Starting engine");
  const [storageNotice, setStorageNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [assetStatus, setAssetStatus] = useState<string>();
  const [assetImporting, setAssetImporting] = useState(false);
  const [figmaImportStatus, setFigmaImportStatus] = useState<string>();
  const [figmaImportReport, setFigmaImportReport] =
    useState<FigmaRestImportReport>();
  const [pendingFigmaAssetRequests, setPendingFigmaAssetRequests] = useState<
    FigmaRestAssetRequest[]
  >([]);
  const [figmaAssetBinding, setFigmaAssetBinding] = useState(false);
  const [sliceExportScale, setSliceExportScale] = useState(1);
  const [sliceExportBackground, setSliceExportBackground] =
    useState<SliceExportBackground>("transparent");
  const [pdfExportBackground, setPdfExportBackground] =
    useState<PdfExportBackground>("transparent");
  const [writerMode, setWriterMode] = useState<WriterLeaseMode>("acquiring");
  const [accessPreference, setAccessPreference] = useState<"edit" | "view">(
    "edit",
  );
  const [canvasGeneration, setCanvasGeneration] = useState(0);
  const [workerRecoveryCount, setWorkerRecoveryCount] = useState(0);
  const [safeMode, setSafeMode] = useState(false);
  const [fixtureResetting, setFixtureResetting] = useState(false);
  const [fixtureResetGeneration, setFixtureResetGeneration] = useState(0);
  const [mainThreadLongTasks, setMainThreadLongTasks] =
    useState<MainThreadLongTaskSummary>(emptyMainThreadLongTaskSummary);
  const [frameIntervals, setFrameIntervals] = useState<FrameIntervalSummary>({
    samples: 0,
    p50Ms: 0,
    p95Ms: 0,
    maxMs: 0,
  });
  const [inputBacklog, setInputBacklog] = useState<InputBatchBacklogSummary>({
    samples: 0,
    p50Ms: 0,
    p95Ms: 0,
    maxMs: 0,
  });
  const [viewportCheckpoints, setViewportCheckpoints] =
    useState<ViewportCheckpointSummary>({
      samples: 0,
      p50Ms: 0,
      p95Ms: 0,
      maxMs: 0,
    });
  const [mainThreadMonitor, setMainThreadMonitor] = useState<
    "waiting" | "monitoring" | "unavailable"
  >("waiting");
  const [mainThreadMonitoringEnabled, setMainThreadMonitoringEnabled] =
    useState(false);
  const [canvasTextEdit, setCanvasTextEdit] = useState<CanvasTextEdit>();
  const [renameMode, setRenameMode] = useState(false);
  const [nameDraft, setNameDraft] = useState(documentName);
  const setStatusForRevision = useCallback(
    (message: string, expectedRevision: number) => {
      if (statusRevisionIsCurrent(expectedRevision, revisionRef.current))
        setStatus(message);
    },
    [],
  );
  const canvasTextCommitRef = useRef(false);
  const canvasTextIsComposingRef = useRef(false);
  const canvasTextEditorRef = useRef<HTMLDivElement>(null);
  const pendingCanvasCaretLayoutsRef = useRef(
    new Map<string, { nodeId: string; text: string; targetUtf16: number }>(),
  );
  /** A restarted Worker owns no prior layout response. Keep the DOM draft, but
   * never reuse its old caret map after that boundary. */
  const needsCanvasTextCaretRecoveryRef = useRef(false);
  const canvasTextEditNodeId = canvasTextEdit?.nodeId;
  const canvasTextCaret = canvasTextEdit?.caret;
  const canvasTextSelectionAnchor = canvasTextEdit?.selectionAnchor;
  const fixtureSnapshot = useMemo(
    () => requestedFixtureSnapshot(initialFixture),
    [initialFixture],
  );
  const fixtureAssetSeeds = useMemo(
    () => requestedFixtureAssetSeeds(initialFixture),
    [initialFixture],
  );
  const fixtureAssetNodes = useMemo(
    () => requestedFixtureAssetNodes(initialFixture),
    [initialFixture],
  );
  const fixtureStatus = useMemo(
    () => requestedFixtureStatus(initialFixture),
    [initialFixture],
  );
  // URL-only capture mode is intentionally enabled after hydration so the
  // server and the browser's first render have exactly the same DOM shape.
  const [deterministicEvidenceCapture, setDeterministicEvidenceCapture] =
    useState(false);
  const rendererPreference = useMemo(() => requestedRendererPreference(), []);
  const simulateGpuLosses = useMemo(
    () => requestedGpuLossSimulationCount(),
    [],
  );
  const simulateGpuLossAfterImage = useMemo(
    () => requestedGpuLossAfterImage(),
    [],
  );
  const simulateGpuFault = useMemo(() => requestedGpuFaultSimulation(), []);
  const simulateWorkerCrashes = useMemo(
    () => requestedEngineCrashSimulationCount(),
    [],
  );
  const simulateWorkerCrashDelayMs = useMemo(
    () => requestedEngineCrashSimulationDelayMs(),
    [],
  );
  const snapshot = useMemo(
    () =>
      ({ ...documentState, ...selectionState, ...viewState }) as EditorSnapshot,
    [documentState, selectionState, viewState],
  );
  const initialDocumentLoading = !documentHydrated || !firstFrameReady;
  const orderedPages = useMemo(
    () => pagesInCanonicalExportOrder(snapshot.pages),
    [snapshot.pages],
  );
  const activePageNodes = useMemo(
    () =>
      snapshot.nodes.filter(
        (node) =>
          (node.pageId ?? defaultPageId) === snapshot.activePageId,
      ),
    [snapshot.activePageId, snapshot.nodes],
  );
  const commitDocumentName = useCallback(() => {
    const next = nameDraft.trim();
    if (next && next.length <= 100) onRenameDocument?.(next);
    setRenameMode(false);
  }, [nameDraft, onRenameDocument]);

  useLayoutEffect(() => {
    if (
      canvasTextEditNodeId === undefined ||
      canvasTextCaret === undefined ||
      canvasTextSelectionAnchor === undefined
    )
      return;
    const editor = canvasTextEditorRef.current;
    if (!editor) return;
    editor.focus({ preventScroll: true });
    if (canvasTextSelectionAnchor === canvasTextCaret)
      placeContentEditableCaret(editor, canvasTextCaret);
    else
      placeContentEditableSelection(
        editor,
        canvasTextSelectionAnchor,
        canvasTextCaret,
      );
  }, [canvasTextCaret, canvasTextEditNodeId, canvasTextSelectionAnchor]);

  useEffect(() => {
    const task = window.setTimeout(
      () => setDeterministicEvidenceCapture(isDeterministicEvidenceCapture()),
      0,
    );
    return () => window.clearTimeout(task);
  }, []);

  const post = useCallback(
    (message: MainToWorker, transfer?: Transferable[]) =>
      workerRef.current?.postMessage(message, transfer ?? []),
    [],
  );
  const requestCanvasCaretLayout = useCallback(
    (nodeId: string, text: string, targetUtf16: number) => {
      const requestId = createId();
      pendingCanvasCaretLayoutsRef.current.set(requestId, {
        nodeId,
        text,
        targetUtf16,
      });
      post({ type: "text-caret-layout", requestId, nodeId, text });
    },
    [post],
  );
  useEffect(() => {
    if (
      !needsCanvasTextCaretRecoveryRef.current ||
      !canvasTextEdit ||
      canvasTextEdit.rustCaretReady ||
      snapshot.documentCore !== "Rust/WASM bridge ready"
    )
      return;
    const node = snapshot.nodes.find(
      (candidate) =>
        candidate.id === canvasTextEdit.nodeId &&
        candidate.kind === "text" &&
        (candidate.pageId ?? defaultPageId) === snapshot.activePageId,
    );
    needsCanvasTextCaretRecoveryRef.current = false;
    if (!node) {
      pendingCanvasCaretLayoutsRef.current.clear();
      post({ type: "editing-text" });
      queueMicrotask(() => setCanvasTextEdit(undefined));
      return;
    }
    // The draft itself is still presentation-only. The new Worker receives it
    // only to return legal stops, then resumes omitting Canvas glyph painting.
    post({ type: "editing-text", nodeId: canvasTextEdit.nodeId });
    requestCanvasCaretLayout(
      canvasTextEdit.nodeId,
      canvasTextEdit.draft,
      canvasTextEdit.caret,
    );
  }, [
    canvasTextEdit,
    post,
    requestCanvasCaretLayout,
    snapshot.activePageId,
    snapshot.documentCore,
    snapshot.nodes,
  ]);
  const postInput = useCallback((events: readonly EditorInputEvent[]) => {
    const buffer = encodeInputBatch(events);
    workerRef.current?.postMessage(
      { type: "input", buffer } satisfies MainToWorker,
      [buffer],
    );
  }, []);
  /** Registers the exact asset bytes with document.fonts before a native
   * textarea is allowed to edit that text. The Canvas Worker performs the same
   * registration with its own FontFaceSet, so neither side silently falls back
   * to a different font while an edit session is open. */
  const ensureMainFontFace = useCallback(
    async (
      documentId: string,
      asset: DocumentAsset,
      suppliedBytes?: ArrayBuffer,
    ) => {
      if (!asset.mediaType.startsWith("font/")) return undefined;
      const registry = mainFontFacesRef.current;
      const knownFamily = registry.familyFor(asset.assetId);
      if (knownFamily) return knownFamily;
      if (suppliedBytes)
        mainFontBytesRef.current.set(asset.assetId, suppliedBytes.slice(0));
      let source = mainFontBytesRef.current.get(asset.assetId);
      if (!source) {
        try {
          source = await new AssetApiTransport({
            baseUrl: assetApiUrl,
            tenantId: localDevTenantId,
            actorId: localDevActorId,
          }).download(documentId, asset.assetId);
          mainFontBytesRef.current.set(asset.assetId, source.slice(0));
        } catch {
          return undefined;
        }
      }
      const target =
        typeof document === "undefined" ? undefined : document.fonts;
      const create =
        typeof FontFace === "function"
          ? (family: string, bytes: ArrayBuffer) => new FontFace(family, bytes)
          : undefined;
      return registry.load(asset.assetId, source.slice(0), target, create);
    },
    [],
  );
  const rehydrateFromRemote = useCallback(
    async (documentId: string, requestId?: string) => {
      const snapshot = await new DocumentApiTransport({
        baseUrl: documentApiUrl,
        tenantId: localDevTenantId,
        actorId: localDevActorId,
      }).loadSnapshot(documentId);
      // Transfer the opaque bytes straight back to the Worker; TypeScript never
      // creates a second document representation while reconciling.
      post({ type: "remote-hydrate", snapshot, requestId }, [snapshot.buffer]);
    },
    [post],
  );
  const reconcilePendingOperations = useCallback(
    async (
      documentId: string,
      knownOperations?: readonly import("@/lib/editor-protocol").PendingRemoteOperation[],
    ) => {
      const [snapshot, storedOperations] = await Promise.all([
        new DocumentApiTransport({
          baseUrl: documentApiUrl,
          tenantId: localDevTenantId,
          actorId: localDevActorId,
        }).loadSnapshot(documentId),
        knownOperations
          ? Promise.resolve([...knownOperations])
          : loadPendingRemoteOperations(),
      ]);
      const normalizedDocumentId = documentId.replaceAll("-", "").toLowerCase();
      const operations = storedOperations.filter(
        (operation) =>
          operation.documentId.replaceAll("-", "").toLowerCase() ===
          normalizedDocumentId,
      );
      post({ type: "remote-reconcile", snapshot, operations }, [
        snapshot.buffer,
      ]);
    },
    [post],
  );
  const synchronizePendingOperations = useCallback(
    (
      nextOperation?: import("@/lib/editor-protocol").PendingRemoteOperation,
      reconciliation?: {
        removeOperationIds: string[];
        replacements: import("@/lib/editor-protocol").PendingRemoteOperation[];
        discardedOperationIds: string[];
        coreRejectedOperationIds: string[];
        blockedOperationIds: string[];
        rejectionDiagnostics: string[];
      },
    ) => {
      const statusRevision = revisionRef.current;
      const task = remoteSyncQueue.current
        .catch(() => undefined)
        .then(async () => {
          if (reconciliation) {
            await replacePendingRemoteOperations(
              reconciliation.removeOperationIds,
              reconciliation.replacements,
            );
            if (reconciliation.blockedOperationIds.length) {
              setStatusForRevision(
                "Engine worker online · an older pending operation needs manual recovery",
                statusRevision,
              );
              return undefined;
            }
          } else if (nextOperation)
            await appendPendingRemoteOperation(nextOperation);
          // Large Figma imports can carry megabytes of replay data. Read the
          // durable queue once and reuse that exact causal sequence for both
          // delivery and reconciliation instead of structured-cloning it from
          // IndexedDB twice before the first frame can appear.
          const pendingOperations = await loadPendingRemoteOperations();
          const synchronizer = new PendingOperationSynchronizer(
            {
              load: async () => pendingOperations,
              replace: replacePendingRemoteOperation,
              remove: removePendingRemoteOperation,
            },
            new DocumentApiTransport({
              baseUrl: documentApiUrl,
              tenantId: localDevTenantId,
              actorId: localDevActorId,
            }),
          );
          const report = await synchronizer.flush();
          if (report.reconciliationRequiredOperationIds.length) {
            setStatusForRevision(
              "Engine worker online · remote reconciliation required",
              statusRevision,
            );
            const accepted = new Set(report.acceptedOperationIds);
            const terminalResolutions = new Map(
              report.events.flatMap((event) =>
                event.resolution !== "retrying" &&
                event.resolution.kind !== "accepted"
                  ? [[event.operation.operationId, event.resolution] as const]
                  : [],
              ),
            );
            const operationsForReconciliation = pendingOperations
              .filter((operation) => !accepted.has(operation.operationId))
              .map((operation) => {
                const resolution = terminalResolutions.get(
                  operation.operationId,
                );
                return resolution
                  ? { ...operation, reconciliation: resolution }
                  : operation;
              });
            await reconcilePendingOperations(
              nextOperation?.documentId ??
                reconciliation?.replacements[0]?.documentId ??
                snapshotRef.current.documentId,
              operationsForReconciliation,
            ).catch(() =>
              setStatusForRevision(
                "Engine worker online · remote snapshot unavailable",
                statusRevision,
              ),
            );
          } else if (report.retryingOperationIds.length)
            setStatusForRevision(
              "Engine worker online · remote sync retrying",
              statusRevision,
            );
          else if (report.acceptedOperationIds.length)
            setStatusForRevision(
              "Engine worker online · remote changes saved",
              statusRevision,
            );
          else if (reconciliation)
            setStatusForRevision(
              "Engine worker online · remote document ready",
              statusRevision,
            );
          return report;
        })
        .catch(() => {
          setStatusForRevision(
            "Engine worker online · remote sync retrying",
            statusRevision,
          );
          return undefined;
        });
      remoteSyncQueue.current = task.then(() => undefined);
      return task;
    },
    [reconcilePendingOperations, setStatusForRevision],
  );
  const command = useCallback(
    (next: EditorCommand) => {
      if (safeMode) {
        setStatus("Engine worker safe mode · reload to retry");
        return;
      }
      // Fixture hydration replaces the complete Worker-owned document. Treat a
      // second reset exactly like any other input until that replacement has
      // confirmed; otherwise two async bridge loads can race and leave the
      // visible controls bound to an obsolete projection.
      if (fixtureResetPendingRef.current) {
        setStatus("Engine worker online · resetting fixture");
        return;
      }
      if (changesDocument(next) && !writerRef.current) {
        setStatus("Engine worker online · read-only tab");
        return;
      }
      if (next.type === "reset") {
        // A named fixture is a deterministic local evidence surface. Restoring
        // it must produce the exact fixture again (rather than the generic demo)
        // and must not wait for a remote-reset acknowledgement that is purposely
        // suppressed for fixtures.
        if (fixtureSnapshot) {
          const requestId = createId();
          fixtureResetPendingRef.current = true;
          fixtureResetRequestIdRef.current = requestId;
          setFixtureResetting(true);
          setFixtureResetGeneration((generation) => generation + 1);
          resetPendingRef.current = false;
          remoteAdoptedRevisionRef.current = undefined;
          setStatus("Engine worker online · resetting fixture");
          post({
            type: "command",
            command: { type: "hydrate", snapshot: fixtureSnapshot, requestId },
          });
          return;
        }
        fixtureResetPendingRef.current = false;
        resetPendingRef.current = true;
        remoteAdoptedRevisionRef.current = undefined;
        setStatus("Engine worker online · resetting demo");
      }
      // Selection is presentation state, not a document transaction. Sending it
      // directly prevents a queued remote/durable edit from delaying layer focus.
      if (!changesDocument(next)) {
        post({ type: "command", command: next });
        return;
      }
      const transactionId = transactionQueueRef.current?.enqueue([next]);
      if (transactionId && next.type === "update") {
        optimisticUpdatesRef.current.set(transactionId, next);
        const projected = applyOptimisticUpdates(
          confirmedSnapshotRef.current,
          optimisticUpdatesRef.current.values(),
        );
        snapshotRef.current = projected;
        setDocumentState(projected);
      }
    },
    [fixtureSnapshot, post, safeMode],
  );
  const reorderSelectedLayers = useCallback(
    (action: LayerOrderAction) => {
      const current = snapshotRef.current;
      const pageNodes = current.nodes.filter(
        (node) => (node.pageId ?? defaultPageId) === current.activePageId,
      );
      const resolved = resolveLayerOrder(
        pageNodes,
        current.selectedIds,
        action,
      );
      if (resolved)
        command({
          type: "reposition",
          positionIds: [...resolved.positionIds].map(([id, positionId]) => ({
            id,
            positionId,
          })),
        });
    },
    [command],
  );
  const arrangeSelectedLayers = useCallback(
    (action: ArrangeAction, tidyGap = 0, alignToPrimary = false) => {
      const ids = snapshotRef.current.selectedIds;
      if (ids.length < 2) return;
      if (action === "align-left")
        command({
          type: "arrange",
          ids,
          operation: "align",
          axis: "x",
          mode: "min",
          reference: alignToPrimary ? "primaryNode" : "selectionBounds",
        });
      else if (action === "align-center-x")
        command({
          type: "arrange",
          ids,
          operation: "align",
          axis: "x",
          mode: "center",
          reference: alignToPrimary ? "primaryNode" : "selectionBounds",
        });
      else if (action === "align-right")
        command({
          type: "arrange",
          ids,
          operation: "align",
          axis: "x",
          mode: "max",
          reference: alignToPrimary ? "primaryNode" : "selectionBounds",
        });
      else if (action === "align-top")
        command({
          type: "arrange",
          ids,
          operation: "align",
          axis: "y",
          mode: "min",
          reference: alignToPrimary ? "primaryNode" : "selectionBounds",
        });
      else if (action === "align-center-y")
        command({
          type: "arrange",
          ids,
          operation: "align",
          axis: "y",
          mode: "center",
          reference: alignToPrimary ? "primaryNode" : "selectionBounds",
        });
      else if (action === "align-bottom")
        command({
          type: "arrange",
          ids,
          operation: "align",
          axis: "y",
          mode: "max",
          reference: alignToPrimary ? "primaryNode" : "selectionBounds",
        });
      else if (action === "distribute-x")
        command({
          type: "arrange",
          ids,
          operation: "distribute",
          axis: "x",
          mode: "edgeGap",
        });
      else if (action === "distribute-centers-x")
        command({
          type: "arrange",
          ids,
          operation: "distribute",
          axis: "x",
          mode: "centerGap",
        });
      else if (action === "distribute-y")
        command({
          type: "arrange",
          ids,
          operation: "distribute",
          axis: "y",
          mode: "edgeGap",
        });
      else if (action === "distribute-centers-y")
        command({
          type: "arrange",
          ids,
          operation: "distribute",
          axis: "y",
          mode: "centerGap",
        });
      else
        command({
          type: "arrange",
          ids,
          operation: "tidyUp",
          axis:
            action === "tidy-auto" ? "auto" : action === "tidy-x" ? "x" : "y",
          gap: tidyGap,
          anchor: "selectionBounds",
        });
    },
    [command],
  );
  const recoverWorker = useCallback((reason: "error" | "message-error") => {
    if (recoveryStabilityTimerRef.current)
      clearTimeout(recoveryStabilityTimerRef.current);
    if (shouldDeferWorkerRecovery(navigator.onLine)) {
      // An offline Worker can fail while its module or WASM dependency is being
      // fetched. Preserve the confirmed Core snapshot, but do not classify this
      // transport condition as a second engine crash and enter safe mode.
      transactionQueueRef.current?.reset();
      optimisticUpdatesRef.current.clear();
      recoverySnapshotRef.current ??= snapshotRef.current.localSnapshot;
      canvasTextIsComposingRef.current = false;
      pendingCanvasCaretLayoutsRef.current.clear();
      needsCanvasTextCaretRecoveryRef.current = true;
      workerRef.current?.terminate();
      workerRef.current = null;
      offlineWorkerRecoveryPendingRef.current = true;
      setError(undefined);
      setStatus(
        "Engine worker offline · recovery resumes when network returns",
      );
      return;
    }
    const plan = planWorkerRecovery(recoveryFailuresRef.current);
    if (plan.mode === "safe-mode") {
      transactionQueueRef.current?.reset();
      optimisticUpdatesRef.current.clear();
      workerRef.current?.terminate();
      workerRef.current = null;
      setSafeMode(true);
      setError(
        "Engine Worker 连续异常，已进入安全模式；已确认的本地快照保持不变，请刷新后重试。",
      );
      setStatus("Engine worker safe mode");
      return;
    }
    recoveryFailuresRef.current = plan.nextFailures;
    workerRecoveryAwaitingConfirmationRef.current = true;
    transactionQueueRef.current?.reset();
    optimisticUpdatesRef.current.clear();
    recoverySnapshotRef.current ??= snapshotRef.current.localSnapshot;
    canvasTextIsComposingRef.current = false;
    pendingCanvasCaretLayoutsRef.current.clear();
    needsCanvasTextCaretRecoveryRef.current = true;
    setCanvasTextEdit((current) =>
      current
        ? { ...current, rustCaretReady: false, rustCaretLayout: undefined }
        : current,
    );
    workerRef.current?.terminate();
    workerRef.current = null;
    setError(undefined);
    setStatus(`Engine worker recovering after ${reason}`);
    recoveryTimerRef.current = setTimeout(
      () => setCanvasGeneration((generation) => generation + 1),
      150,
    );
  }, []);

  useEffect(
    () => () => {
      if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
      if (recoveryStabilityTimerRef.current)
        clearTimeout(recoveryStabilityTimerRef.current);
      if (viewportCheckpointTimerRef.current)
        clearTimeout(viewportCheckpointTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    const retry = () => {
      if (offlineWorkerRecoveryPendingRef.current) {
        offlineWorkerRecoveryPendingRef.current = false;
        workerRecoveryAwaitingConfirmationRef.current = true;
        setStatus("Engine worker recovering after network restored");
        setCanvasGeneration((generation) => generation + 1);
      }
      if (remoteSync) void synchronizePendingOperations();
    };
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [remoteSync, synchronizePendingOperations]);

  useEffect(() => {
    const queue = createEditorTransactionQueue({
      createId,
      currentRevision: () => revisionRef.current,
      send: (transaction) => {
        const worker = workerRef.current;
        if (!worker) return false;
        worker.postMessage({
          type: "transaction",
          transaction,
        } satisfies MainToWorker);
        return true;
      },
    });
    transactionQueueRef.current = queue;
    return () => {
      queue.reset();
      if (transactionQueueRef.current === queue)
        transactionQueueRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mainThreadMonitoringEnabled) return;
    if (!("PerformanceObserver" in globalThis)) {
      const unavailable = setTimeout(
        () => setMainThreadMonitor("unavailable"),
        0,
      );
      return () => clearTimeout(unavailable);
    }
    try {
      const observer = new PerformanceObserver((entries) => {
        setMainThreadLongTasks((current) =>
          entries
            .getEntries()
            .reduce(
              (summary, entry) =>
                recordMainThreadLongTask(summary, entry.duration),
              current,
            ),
        );
      });
      observer.observe({ type: "longtask" });
      return () => observer.disconnect();
    } catch {
      const unavailable = setTimeout(
        () => setMainThreadMonitor("unavailable"),
        0,
      );
      return () => clearTimeout(unavailable);
    }
  }, [mainThreadMonitoringEnabled]);

  useEffect(() => {
    if (!mainThreadMonitoringEnabled) return;
    const sampler = frameIntervalSamplerRef.current;
    sampler.reset();
    let frame = 0;
    let lastPublished = 0;
    const observe = (timestamp: number) => {
      sampler.record(timestamp);
      if (timestamp - lastPublished >= 250) {
        lastPublished = timestamp;
        setFrameIntervals(sampler.summary());
      }
      frame = requestAnimationFrame(observe);
    };
    frame = requestAnimationFrame(observe);
    return () => cancelAnimationFrame(frame);
  }, [mainThreadMonitoringEnabled]);

  useEffect(() => {
    const batcher = createInputTransferBatcher(
      (events) => postInput(events),
      undefined,
      (durationMs) => {
        inputBacklogSamplerRef.current.record(durationMs);
        setInputBacklog(inputBacklogSamplerRef.current.summary());
      },
    );
    inputBatcherRef.current = batcher;
    return () => {
      batcher.dispose();
      if (inputBatcherRef.current === batcher) inputBatcherRef.current = null;
    };
  }, [postInput]);

  useEffect(() => {
    if (!writerLock) {
      let active = true;
      queueMicrotask(() => {
        if (!active) return;
        writerRef.current = accessPreference === "edit";
        setWriterMode(accessPreference === "edit" ? "owner" : "read-only");
        setStatus(
          accessPreference === "edit"
            ? "Engine worker online · server conflict protection active"
            : "Engine worker online · view-only mode",
        );
      });
      return () => {
        active = false;
        writerRef.current = false;
      };
    }
    const channel = new BroadcastChannel(writerLockName);
    const optimisticUpdates = optimisticUpdatesRef.current;
    editIntentRef.current ??= { at: Date.now(), id: createId() };
    channelRef.current = channel;
    channel.onmessage = ({ data }: MessageEvent<TabMessage>) => {
      if (data.type === "snapshot" && !writerRef.current) {
        post({
          type: "command",
          command: { type: "hydrate", snapshot: data.snapshot },
        });
        setStatus("Engine worker online · read-only copy updated");
      }
      if (
        data.type === "request-edit" &&
        writerRef.current &&
        newerEditIntent(data.intent, editIntentRef.current!)
      ) {
        writerRef.current = false;
        transactionQueueRef.current?.reset();
        optimisticUpdates.clear();
        writerLeaseRef.current?.stop();
        writerLeaseRef.current = null;
        setWriterMode("read-only");
        setAccessPreference("view");
        setStatus("Engine worker online · editing handed to another tab");
      }
    };
    if (accessPreference === "view") {
      writerRef.current = false;
      transactionQueueRef.current?.reset();
      optimisticUpdates.clear();
      return () => {
        channel.close();
        if (channelRef.current === channel) channelRef.current = null;
      };
    }
    if (!navigator.locks) {
      queueMicrotask(() => {
        writerRef.current = true;
        setWriterMode("owner");
        setStatus(
          "Engine worker online · local editing (Web Locks unavailable)",
        );
      });
      return () => {
        writerRef.current = false;
        channel.close();
        if (channelRef.current === channel) channelRef.current = null;
      };
    }
    const lease = maintainWriterLease({
      name: writerLockName,
      request: async (name, callback) => {
        await navigator.locks!.request(
          name,
          { ifAvailable: true },
          async (lock) => callback(lock),
        );
      },
      onMode: (mode) => {
        writerRef.current = mode === "owner";
        setWriterMode(mode);
        if (mode === "owner")
          setStatus("Engine worker online · writer lease acquired");
        if (mode === "read-only") {
          setStatus("Engine worker online · requesting edit handoff");
          channel.postMessage({
            type: "request-edit",
            intent: editIntentRef.current!,
          } satisfies TabMessage);
        }
      },
    });
    writerLeaseRef.current = lease;
    return () => {
      writerRef.current = false;
      transactionQueueRef.current?.reset();
      optimisticUpdates.clear();
      // Release synchronously. Waiting for a prior page's persistence promise
      // during refresh can retain the Web Lock indefinitely and strand the new
      // page in read-only mode. Confirmed writes remain atomic individually.
      lease.stop();
      if (writerLeaseRef.current === lease) writerLeaseRef.current = null;
      channel.close();
      if (channelRef.current === channel) channelRef.current = null;
    };
  }, [accessPreference, post, writerLock, writerLockName]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setDocumentHydrated(false);
    setFirstFrameReady(false);
    setFrameQuality("pending");
    setDocumentLoadingState({ label: "正在读取设计文档…" });
    setDocumentAuthorityReady(false);
    setReconciliationProgress(undefined);
    if (transferredCanvasRef.current === canvas) {
      setCanvasGeneration((generation) => generation + 1);
      return;
    }
    if (!("transferControlToOffscreen" in canvas)) {
      setError("此浏览器不支持 OffscreenCanvas，无法启动独立画布引擎。");
      return;
    }
    fixtureAssetsSeededRef.current = false;
    fixtureAssetNodesCreatedRef.current = false;
    remoteBootstrapRequestedRef.current = false;
    const worker = new Worker(
      new URL("../../workers/editor.worker.ts", import.meta.url),
      { type: "module" },
    );
    workerRef.current = worker;
    runtimeRef.current = null;
    const runtimeBridge = new RuntimeWorkerBridge((message) =>
      worker.postMessage(message),
    );
    runtimeBridgeRef.current = runtimeBridge;
    let runtimeGeneration = 0;
    const createRuntime = (snapshot: EditorSnapshot) =>
      new FigmaCompatibleRuntime(
        new RuntimeSession({
          sessionId: `editor:${snapshot.documentId}:${canvasGeneration}:${runtimeGeneration++}`,
          projection: runtimeProjectionFromEditorSnapshot(snapshot),
          currentPageId: snapshot.activePageId,
          transport: runtimeBridge,
          onError: (error) =>
            setError(
              error instanceof Error
                ? error.message
                : "Runtime transaction failed",
            ),
        }),
      );
    let disposed = false;
    let authorityHydrationRequestId: string | undefined;
    let authorityHydrationKind: "local" | "remote" | undefined;
    let awaitingAuthoritySnapshot = false;
    let awaitingRemoteReconciliation = false;
    let authorityConfirmed = false;
    let hasLocalAuthority = false;
    let crashSimulationTimer: ReturnType<typeof setTimeout> | undefined;
    let remoteBootstrapRetryTimer: ReturnType<typeof setTimeout> | undefined;
    const retryRemoteBootstrap = () => {
      remoteBootstrapRequestedRef.current = false;
      if (remoteBootstrapRetryTimer) clearTimeout(remoteBootstrapRetryTimer);
      remoteBootstrapRetryTimer = setTimeout(() => {
        remoteBootstrapRetryTimer = undefined;
        if (!disposed) post({ type: "remote-bootstrap" });
      }, 1_500);
    };
    const resize = () =>
      post({
        type: "resize",
        width: canvas.clientWidth,
        height: canvas.clientHeight,
        dpr: window.devicePixelRatio || 1,
      });
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    const syncWorkerVisibility = () =>
      post({ type: "visibility", visible: document.visibilityState === "visible" });
    document.addEventListener("visibilitychange", syncWorkerVisibility);
    worker.onmessage = async ({ data }: MessageEvent<WorkerToMain>) => {
      runtimeBridge.observe(data);
      if (data.type === "ready") {
        setStatus("Engine worker online");
        setMainThreadLongTasks(emptyMainThreadLongTaskSummary());
        setMainThreadMonitor("monitoring");
        setMainThreadMonitoringEnabled(true);
        void prepareLocalStorage()
          .then((health) => {
            if (health.lowSpace) setStorageNotice("local storage space low");
            else if (!health.persistentStorageGranted)
              setStorageNotice("browser may evict local data");
            else if (!health.opfsAvailable)
              setStorageNotice("IndexedDB snapshot fallback");
          })
          .catch(() => setStorageNotice("local storage status unavailable"));
        try {
          const recoverySnapshot = recoverySnapshotRef.current;
          const local =
            recoverySnapshot ??
            fixtureSnapshot ??
            (await loadLocalDocument(documentId));
          if (local) {
            hasLocalAuthority = true;
            authorityHydrationRequestId = createId();
            authorityHydrationKind = "local";
            awaitingAuthoritySnapshot = !remoteSync;
            if (recoverySnapshot)
              setStatus("Engine worker online · recovered confirmed snapshot");
            else if (fixtureSnapshot)
              setStatus(`Engine worker online · ${fixtureStatus}`);
            else if (
              "recoveredFromPrevious" in local &&
              local.recoveredFromPrevious
            )
              setStatus(
                "Engine worker online · restored previous local snapshot",
              );
            post({
              type: "command",
              command: {
                type: "hydrate",
                snapshot: local,
                requestId: authorityHydrationRequestId,
              },
            });
          }
        } catch {
          setStatus("Engine worker online · local save unavailable");
        }
        restoredRef.current = true;
        // Hydration starts an async WASM bridge load. Post on the next task so
        // the worker has registered that load before it records the bootstrap
        // request; the worker then emits only the final canonical state.
        if (!fixtureSnapshot && remoteSync)
          setTimeout(() => {
            if (!disposed) post({ type: "remote-bootstrap" });
          }, 0);
      }
      if (data.type === "remote-bootstrap") {
        if (!remoteSync || resetPendingRef.current) return;
        if (
          !restoredRef.current ||
          fixtureSnapshot ||
          remoteBootstrapRequestedRef.current
        )
          return;
        remoteBootstrapRequestedRef.current = true;
        const transport = new DocumentApiTransport({
          baseUrl: documentApiUrl,
          tenantId: localDevTenantId,
          actorId: localDevActorId,
        });
        const synchronizeThenHydrate = async (
          knownRemoteSnapshot?: Uint8Array,
        ) => {
          const report = await synchronizePendingOperations();
          if (disposed) return;
          if (!report || report.retryingOperationIds.length) {
            if (hasLocalAuthority) {
              authorityConfirmed = true;
              setDocumentHydrated(true);
              setDocumentAuthorityReady(true);
            }
            retryRemoteBootstrap();
            return;
          }
          // The reconciliation request already transfers the authoritative
          // snapshot and replays valid local pending intents in the Worker. A
          // second plain hydrate here would immediately overwrite that replay.
          if (report.reconciliationRequiredOperationIds.length) {
            // `synchronizePendingOperations` has already posted a
            // `remote-reconcile` command. Treat the snapshot emitted by that
            // command as the pending authority boundary; otherwise a browser
            // with an old IndexedDB operation can render the full document
            // underneath a loading veil forever.
            authorityHydrationRequestId = undefined;
            authorityHydrationKind = "remote";
            awaitingAuthoritySnapshot = false;
            awaitingRemoteReconciliation = true;
            setStatus("Engine worker online · reconciling remote document");
            return;
          }
          const changedRemote =
            report.acceptedOperationIds.length > 0 ||
            report.reconciliationRequiredOperationIds.length > 0;
          const remoteSnapshot =
            changedRemote || !knownRemoteSnapshot
              ? await transport.loadSnapshot(data.documentId)
              : knownRemoteSnapshot;
          if (!disposed) {
            authorityHydrationRequestId = createId();
            authorityHydrationKind = "remote";
            awaitingAuthoritySnapshot = true;
            post(
              {
                type: "remote-hydrate",
                snapshot: remoteSnapshot,
                requestId: authorityHydrationRequestId,
              },
              [remoteSnapshot.buffer],
            );
            setStatus(
              report.reconciliationRequiredOperationIds.length
                ? "Engine worker online · remote reconciliation required"
                : "Engine worker online · remote document loaded",
            );
          }
        };
        try {
          // A normal restart must not intentionally trigger a 409 just to learn
          // that the durable root already exists. Pending local operations must
          // reach the service before its older snapshot can replace local state.
          const remoteSnapshot = await transport.loadSnapshot(data.documentId);
          if (!disposed) await synchronizeThenHydrate(remoteSnapshot);
        } catch (reason) {
          if (
            reason instanceof Error &&
            reason.message === "REMOTE_DOCUMENT_MISSING"
          ) {
            try {
              const result = await transport.createDocument(
                data.documentId,
                data.snapshot,
              );
              if (!disposed) {
                if (result === "created") {
                  // The adopted root already contains every local operation up
                  // through this canonical snapshot revision.
                  remoteAdoptedRevisionRef.current = {
                    documentId: data.documentId,
                    revision: data.revision,
                  };
                  await removePendingRemoteOperationsCoveredBySnapshot(
                    data.documentId,
                    data.revision,
                  );
                }
                setStatus(
                  result === "created"
                    ? "Engine worker online · remote document created"
                    : "Engine worker online · remote document verified",
                );
                await synchronizeThenHydrate(
                  result === "created" ? data.snapshot : undefined,
                );
              }
            } catch (createReason) {
              if (
                !disposed &&
                createReason instanceof Error &&
                createReason.message === "REMOTE_DOCUMENT_CONFLICT"
              ) {
                setStatus(
                  "Engine worker online · remote reconciliation required",
                );
                authorityHydrationRequestId = createId();
                authorityHydrationKind = "remote";
                awaitingAuthoritySnapshot = true;
                void rehydrateFromRemote(
                  data.documentId,
                  authorityHydrationRequestId,
                )
                  .then(() =>
                    setStatus("Engine worker online · remote snapshot applied"),
                  )
                  .catch(() =>
                    setStatus(
                      "Engine worker online · remote snapshot unavailable",
                    ),
                  );
              } else if (!disposed) {
                setStatus("Engine worker online · remote document unavailable");
                authorityConfirmed = true;
                setDocumentHydrated(true);
                setDocumentAuthorityReady(true);
                retryRemoteBootstrap();
              }
            }
          } else if (
            !disposed &&
            reason instanceof Error &&
            reason.message === "REMOTE_DOCUMENT_CONFLICT"
          ) {
            setStatus("Engine worker online · remote reconciliation required");
            authorityHydrationRequestId = createId();
            authorityHydrationKind = "remote";
            awaitingAuthoritySnapshot = true;
            void rehydrateFromRemote(
              data.documentId,
              authorityHydrationRequestId,
            )
              .then(() =>
                setStatus("Engine worker online · remote snapshot applied"),
              )
              .catch(() =>
                setStatus("Engine worker online · remote snapshot unavailable"),
              );
          } else if (!disposed) {
            setStatus("Engine worker online · remote document unavailable");
            authorityConfirmed = true;
            setDocumentHydrated(true);
            setDocumentAuthorityReady(true);
            retryRemoteBootstrap();
          }
        }
      }
      if (data.type === "frame-ready" && !disposed) {
        setFirstFrameReady(true);
        setFrameQuality(data.quality);
        setStatus((current) => {
          if (data.quality === "preview")
            return "Engine worker online · preview ready · refining details";
          if (data.quality === "sharp")
            return "Engine worker online · sharp frame ready · refining effects";
          return current.includes("finalizing first frame") ||
            current.includes("refining details") || current.includes("refining effects")
            ? awaitingRemoteReconciliation
              ? "Engine worker online · recovering local changes"
              : "Engine worker online · remote document ready"
            : current;
        });
      }
      if (data.type === "remote-load-progress") {
        if (
          data.stage !== "render-nodes" &&
          data.stage !== "render-finalize"
        ) {
          setFirstFrameReady(false);
          setFrameQuality("pending");
        }
        setDocumentLoadingState({
          label:
            data.stage === "decode"
              ? "正在读取文档数据…"
              : data.stage === "project"
                ? "正在构建图层结构…"
                : data.stage === "render"
                  ? "正在计算可见图层…"
                  : data.stage === "render-paint"
                    ? "正在准备图层样式…"
                    : data.stage === "render-nodes"
                      ? `正在绘制图层 ${data.completed ?? 0}/${data.total ?? 0}`
                      : data.stage === "render-overlay"
                        ? "正在生成清晰画面…"
                        : "正在完成画布…",
          ...(data.completed !== undefined
            ? { completed: data.completed }
            : {}),
          ...(data.total !== undefined ? { total: data.total } : {}),
        });
        setStatus(
          data.stage === "decode"
            ? "Engine worker online · loading remote document"
            : data.stage === "project"
              ? "Engine worker online · preparing complex layers"
              : data.stage === "render"
                ? "Engine worker online · calculating visible layers"
                : data.stage === "render-paint"
                  ? "Engine worker online · preparing layer paints"
                : data.stage === "render-nodes"
                  ? `Engine worker online · painting layers ${data.completed ?? 0}/${data.total ?? 0}`
                : data.stage === "render-overlay"
                  ? "Engine worker online · painting complex layers"
                  : "Engine worker online · finalizing first frame",
        );
      }
      if (
        data.type === "remote-reset" &&
        !disposed &&
        !fixtureSnapshot &&
        remoteSync
      ) {
        const resetStatusRevision = data.revision;
        const resetTask = remoteSyncQueue.current
          .catch(() => undefined)
          .then(async () => {
            setStatusForRevision(
              "Engine worker online · saving canonical replacement",
              resetStatusRevision,
            );
            const transport = new DocumentApiTransport({
              baseUrl: documentApiUrl,
              tenantId: localDevTenantId,
              actorId: localDevActorId,
            });
            await transport.resetDocument(data.documentId, data.snapshot);
            const pending = await loadPendingRemoteOperations();
            const normalizedDocumentId = data.documentId
              .replaceAll("-", "")
              .toLowerCase();
            await replacePendingRemoteOperations(
              pending
                .filter(
                  (operation) =>
                    operation.documentId.replaceAll("-", "").toLowerCase() ===
                    normalizedDocumentId,
                )
                .map((operation) => operation.operationId),
              [],
            );
            remoteAdoptedRevisionRef.current = {
              documentId: data.documentId,
              revision: data.revision,
            };
            resetPendingRef.current = false;
            setStatusForRevision(
              "Engine worker online · canonical replacement saved",
              resetStatusRevision,
            );
          })
          .catch(async () => {
            resetPendingRef.current = false;
            setStatusForRevision(
              "Engine worker online · canonical replacement could not be saved",
              resetStatusRevision,
            );
            await rehydrateFromRemote(data.documentId).catch(() =>
              setStatusForRevision(
                "Engine worker online · remote snapshot unavailable",
                resetStatusRevision,
              ),
            );
          });
        remoteSyncQueue.current = resetTask.then(() => undefined);
      }
      if (data.type === "remote-operation") {
        // A named fixture is a deterministic local evidence surface. Its fixed
        // document id may already refer to a different service-side run, so
        // submitting fixture edits would intentionally create a 409 and make
        // an otherwise isolated render check report a browser error. Normal
        // documents retain the durable, ordered remote reconciliation path.
        const adopted = remoteAdoptedRevisionRef.current;
        const alreadyRepresented =
          adopted &&
          pendingOperationIsCoveredBySnapshot(
            data.operation,
            adopted.documentId,
            adopted.revision,
          );
        if (!disposed && remoteSync && !fixtureSnapshot && !alreadyRepresented)
          void synchronizePendingOperations(data.operation);
      }
      if (
        data.type === "remote-reconciled" &&
        !disposed &&
        remoteSync &&
        !fixtureSnapshot
      ) {
        // Reconciliation rebuilds the Core from the service-owned snapshot and
        // then replays only intents accepted by Rust. At this point the current
        // projection is authoritative and safe to expose, even when there are
        // rejected or blocked legacy operations to report separately.
        authorityHydrationRequestId = undefined;
        authorityHydrationKind = undefined;
        awaitingAuthoritySnapshot = false;
        awaitingRemoteReconciliation = false;
        authorityConfirmed = true;
        setDocumentHydrated(true);
        setDocumentAuthorityReady(true);
        setReconciliationProgress(undefined);
        if (data.coreRejectedOperationIds.length)
          setStatus(
            "Engine worker online · local operations conflict with the remote document",
          );
        else if (data.discardedOperationIds.length)
          setStatus(
            `Engine worker online · ${data.rejectionDiagnostics[0] ?? "invalid local operations were discarded during reconciliation"}`,
          );
        else if (data.blockedOperationIds.length)
          setStatus(
            "Engine worker online · an older pending operation needs manual recovery",
          );
        else setStatus("Engine worker online · remote document ready");
        void synchronizePendingOperations(undefined, data);
      }
      if (data.type === "remote-reconciliation-progress" && !disposed) {
        setReconciliationProgress({ completed: data.completed, total: data.total });
        setStatus("Engine worker online · recovering local changes");
      }
      if (data.type === "text-caret-layout") {
        const pending = pendingCanvasCaretLayoutsRef.current.get(
          data.requestId,
        );
        pendingCanvasCaretLayoutsRef.current.delete(data.requestId);
        if (
          !disposed &&
          pending &&
          data.layout &&
          pending.nodeId === data.nodeId &&
          pending.text === data.text
        ) {
          const layout: RustTextCaretLayout = data.layout;
          setCanvasTextEdit((current) => {
            if (
              !current ||
              current.nodeId !== pending.nodeId ||
              current.draft !== pending.text
            )
              return current;
            const caret = snapUtf16CaretToRustLayout(
              current.draft,
              pending.targetUtf16,
              layout,
            );
            return {
              ...current,
              caret,
              selectionAnchor: caret,
              rustCaretReady: true,
              rustCaretLayout: layout,
            };
          });
        }
      }
      if (data.type === "snapshot") {
        const completedLocalHydration =
          data.snapshot.documentCore === "Rust/WASM bridge ready" &&
          authorityHydrationKind === "local" &&
          authorityHydrationRequestId !== undefined &&
          data.snapshot.hydrationRequestId === authorityHydrationRequestId &&
          (data.snapshot.nodes.length > 0 ||
            data.snapshot.pages.some(
              (page) =>
                page.id !== "00000000-0000-0000-0000-000000000001" ||
                page.name !== "Page 1",
            ));
        if (completedLocalHydration) {
          // Rendering a Rust-validated local snapshot is safe while the remote
          // authority check continues. Keep mutations disabled until that
          // check completes, but never hide an already usable canvas behind
          // the synchronization state.
          setDocumentHydrated(true);
        }
        if (
          awaitingRemoteReconciliation &&
          data.snapshot.documentCore === "Rust/WASM bridge ready" &&
          data.snapshot.nodes.length > 0
        )
          setDocumentHydrated(true);
        if (
          data.snapshot.documentCore === "Rust/WASM bridge ready" &&
          ((authorityHydrationRequestId !== undefined &&
            (authorityHydrationKind === "remote" || !remoteSync) &&
            data.snapshot.hydrationRequestId ===
              authorityHydrationRequestId) ||
            awaitingAuthoritySnapshot ||
            (!remoteSync &&
              !fixtureSnapshot &&
              authorityHydrationRequestId === undefined))
        ) {
          const completedRemoteHydration = authorityHydrationKind === "remote";
          authorityHydrationRequestId = undefined;
          authorityHydrationKind = undefined;
          awaitingAuthoritySnapshot = false;
          authorityConfirmed = true;
          setDocumentHydrated(true);
          setDocumentAuthorityReady(true);
          if (completedRemoteHydration)
            setStatus("Engine worker online · remote document ready");
        }
        const runtime = runtimeRef.current;
        if (
          !runtime &&
          data.snapshot.documentCore === "Rust/WASM bridge ready" &&
          data.snapshot.pages.some(
            (page) => page.id === data.snapshot.activePageId,
          )
        ) {
          runtimeRef.current = createRuntime(data.snapshot);
        } else if (runtime && !runtimeBridge.hasPendingTransactions) {
          const projection = runtimeProjectionFromEditorSnapshot(data.snapshot);
          if (projection.revision < runtime.session.confirmedRevision) {
            // Remote hydration/reconciliation replaces the authoritative Core
            // snapshot and may start a new, lower revision stream. A Runtime
            // session deliberately rejects revision regression, so start a new
            // session at that authority boundary instead of treating it as an
            // ordinary incremental projection.
            void runtime.session.closeAsync().catch(() => undefined);
            runtimeRef.current = createRuntime(data.snapshot);
          } else {
            runtime.session.applyConfirmedProjection(projection);
          }
        }
        if (
          fixtureAssetSeeds.length &&
          !fixtureAssetsSeededRef.current &&
          // Resource registration is a Canonical Core operation. The root
          // prototype view may deliberately run without that bridge, where a
          // registration would emit a transient worker error instead of a
          // usable fixture image.
          data.snapshot.documentCore === "Rust/WASM bridge ready"
        ) {
          fixtureAssetsSeededRef.current = true;
          try {
            for (const seed of fixtureAssetSeeds) {
              const asset: DocumentAsset = {
                assetId: seed.assetId,
                contentHash: seed.contentHash,
                mediaType: seed.mediaType,
                byteLength: seed.byteLength,
                pixelWidth: seed.pixelWidth,
                pixelHeight: seed.pixelHeight,
              };
              if (!seed.preRegistered)
                post({
                  type: "register-asset",
                  transactionId: createId(),
                  asset,
                });
              const bytes = decodeFixtureAssetBytes(seed);
              if (
                SVG_EMBEDDABLE_RASTER_MEDIA_TYPES.has(asset.mediaType) ||
                SVG_EMBEDDABLE_FONT_MEDIA_TYPES.has(asset.mediaType)
              )
                exportImageBytesRef.current.set(asset.assetId, bytes.slice(0));
              if (asset.mediaType.startsWith("font/"))
                void ensureMainFontFace(
                  data.snapshot.documentId,
                  asset,
                  bytes.slice(0),
                );
              post(
                {
                  type: "asset-bytes",
                  assetId: asset.assetId,
                  mediaType: asset.mediaType,
                  bytes,
                },
                [bytes],
              );
            }
          } catch {
            setStatus("Engine worker online · fixture asset unavailable");
          }
        }
        if (
          fixtureAssetNodes.length &&
          fixtureAssetsSeededRef.current &&
          !fixtureAssetNodesCreatedRef.current &&
          fixtureAssetSeeds.every((asset) =>
            data.snapshot.assets?.some(
              (candidate) => candidate.assetId === asset.assetId,
            ),
          )
        ) {
          fixtureAssetNodesCreatedRef.current = true;
          post({
            type: "transaction",
            transaction: {
              id: createId(),
              baseRevision: data.snapshot.revision,
              commands: fixtureAssetNodes.map((node) => ({
                type: "create" as const,
                node,
              })),
            },
          });
        }
        // Fixture hydration is intentionally expensive and excluded from the
        // interaction window. Begin main-thread evidence after the 50K projection
        // has been confirmed, matching the benchmark contract.
        if (fixtureSnapshot && data.snapshot.nodes.length >= 50_000) {
          fixtureBenchmarkStartedRef.current = false;
          setMainThreadLongTasks(emptyMainThreadLongTaskSummary());
          frameIntervalSamplerRef.current.reset();
          setFrameIntervals({ samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 });
          inputBacklogSamplerRef.current.reset();
          setInputBacklog({ samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 });
        }
        revisionRef.current = data.snapshot.revision;
        confirmedSnapshotRef.current = data.snapshot;
        const projectedSnapshot = applyOptimisticUpdates(
          data.snapshot,
          optimisticUpdatesRef.current.values(),
        );
        snapshotRef.current = projectedSnapshot;
        const pendingImage = pendingImagePlacementRef.current;
        if (
          pendingImage &&
          data.snapshot.assets?.some(
            (asset) =>
              asset.assetId.replaceAll("-", "") ===
              pendingImage.assetId.replaceAll("-", ""),
          )
        ) {
          pendingImagePlacementRef.current = undefined;
          const target = pendingImage.targetId
            ? data.snapshot.nodes.find(
                (node) =>
                  node.id === pendingImage.targetId &&
                  !node.locked &&
                  ["frame", "rectangle", "ellipse", "image"].includes(
                    node.kind,
                  ),
              )
            : undefined;
          transactionQueueRef.current?.enqueue([
            target
              ? {
                  type: "update",
                  id: target.id,
                  patch: { assetId: pendingImage.assetId },
                }
              : {
                  type: "create",
                  node: importedImageNode(pendingImage, data.snapshot.viewport),
                },
          ]);
          setAssetStatus(target ? "Image applied as fill" : "Image added");
        }
        if (data.snapshot.localSnapshot) {
          recoverySnapshotRef.current = data.snapshot.localSnapshot;
          setSafeMode(false);
          if (workerRecoveryAwaitingConfirmationRef.current) {
            workerRecoveryAwaitingConfirmationRef.current = false;
            setWorkerRecoveryCount((count) => count + 1);
          }
          if (recoveryFailuresRef.current > 0) {
            if (recoveryStabilityTimerRef.current)
              clearTimeout(recoveryStabilityTimerRef.current);
            recoveryStabilityTimerRef.current = setTimeout(() => {
              recoveryFailuresRef.current = 0;
            }, 5_000);
          }
        }
        setDocumentState(projectedSnapshot);
        if (
          fixtureResetPendingRef.current &&
          data.snapshot.hydrationRequestId ===
            fixtureResetRequestIdRef.current &&
          data.snapshot.documentCore === "Rust/WASM bridge ready"
        ) {
          fixtureResetPendingRef.current = false;
          fixtureResetRequestIdRef.current = undefined;
          setFixtureResetting(false);
          setStatus(`Engine worker online · ${fixtureStatus}`);
        }
        // Fixed fixtures are deliberately isolated snapshots. Their local
        // edits must never write catalogue display metadata: doing so both
        // mutates the shared test workspace and can emit an unrelated 409 from
        // optimistic catalogue concurrency during otherwise valid UI evidence.
        if (documentId && !fixtureSnapshot && data.snapshot.revision > 0)
          onDocumentSaved?.(data.snapshot.revision);
        setSelectionState({ selectedIds: projectedSnapshot.selectedIds });
        setViewState({
          viewport: projectedSnapshot.viewport,
          performance: projectedSnapshot.performance,
        });
        if (
          data.snapshot.localSnapshot &&
          simulatedWorkerCrashesRef.current < simulateWorkerCrashes &&
          !crashSimulationTimer
        ) {
          simulatedWorkerCrashesRef.current += 1;
          crashSimulationTimer = setTimeout(() => {
            if (!disposed && workerRef.current === worker)
              worker.postMessage({
                type: "simulate-crash",
              } satisfies MainToWorker);
          }, simulateWorkerCrashDelayMs);
        }
        if (
          restoredRef.current &&
          writerRef.current &&
          !fixtureSnapshot &&
          authorityConfirmed &&
          data.snapshot.localSnapshot
        ) {
          const { localJournalEntry, localSnapshot } = data.snapshot;
          const persistenceStatusRevision = data.snapshot.revision;
          persistenceQueue.current = persistenceQueue.current
            .catch(() => undefined)
            .then(async () => {
              if (localJournalEntry)
                await appendLocalJournalEntry(localJournalEntry, documentId);
              await saveLocalDocument(localSnapshot, documentId);
              channelRef.current?.postMessage({
                type: "snapshot",
                snapshot: localSnapshot,
              } satisfies TabMessage);
            })
            .catch((reason: unknown) =>
              setStatusForRevision(
                reason instanceof Error &&
                  reason.message === "LOCAL_STORAGE_QUOTA_EXCEEDED"
                  ? "Engine worker online · local storage is full"
                  : "Engine worker online · save paused",
                persistenceStatusRevision,
              ),
            );
        }
      }
      if (data.type === "view-state") {
        if (fixtureSnapshot && !fixtureBenchmarkStartedRef.current) {
          fixtureBenchmarkStartedRef.current = true;
          setMainThreadLongTasks(emptyMainThreadLongTaskSummary());
          frameIntervalSamplerRef.current.reset();
          setFrameIntervals({ samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 });
          inputBacklogSamplerRef.current.reset();
          setInputBacklog({ samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 });
        }
        // Viewport input is deliberately not a document update: it must not create
        // a 50K-node optimistic projection or cause the LayerPanel to reconcile.
        setSelectionState((current) =>
          sameIds(current.selectedIds, data.selectedIds)
            ? current
            : { selectedIds: data.selectedIds },
        );
        setViewState({
          viewport: data.viewport,
          performance: data.performance,
        });
        setDocumentState((current) =>
          current.activePageId === data.activePageId
            ? current
            : { ...current, activePageId: data.activePageId },
        );
        snapshotRef.current = {
          ...snapshotRef.current,
          viewport: data.viewport,
          selectedIds: data.selectedIds,
          activePageId: data.activePageId,
          performance: data.performance,
        };
        if (
          data.viewportChanged &&
          restoredRef.current &&
          writerRef.current &&
          !fixtureSnapshot
        ) {
          if (viewportCheckpointTimerRef.current)
            clearTimeout(viewportCheckpointTimerRef.current);
          viewportCheckpointTimerRef.current = setTimeout(() => {
            viewportCheckpointTimerRef.current = undefined;
            if (writerRef.current) post({ type: "checkpoint" });
          }, 500);
        }
      }
      if (
        data.type === "viewport-checkpoint" &&
        restoredRef.current &&
        writerRef.current &&
        !fixtureSnapshot
      ) {
        const checkpointStatusRevision = data.coreRevision;
        persistenceQueue.current = persistenceQueue.current
          .catch(() => undefined)
          .then(async () => {
            const startedAt = performance.now();
            await saveViewportRecord(
              {
                format: "viewport-record-v1",
                viewport: data.viewport,
                activePageId: data.activePageId,
                pageViewports: data.pageViewports,
                documentHash: data.documentHash,
                coreRevision: data.coreRevision,
              },
              documentId,
            );
            viewportCheckpointSamplerRef.current.record(
              performance.now() - startedAt,
            );
            setViewportCheckpoints(
              viewportCheckpointSamplerRef.current.summary(),
            );
          })
          .catch(() =>
            setStatusForRevision(
              "Engine worker online · viewport save paused",
              checkpointStatusRevision,
            ),
          );
      }
      if (data.type === "ack") {
        if (data.acceptedRevision !== undefined)
          revisionRef.current = data.acceptedRevision;
        const figmaImport = pendingFigmaImportRef.current;
        if (figmaImport?.transactionId === data.transactionId) {
          pendingFigmaImportRef.current = undefined;
          if (data.errorCode) {
            setFigmaImportStatus(
              `Import failed · ${data.errorCode.toLowerCase().replaceAll("_", " ")}`,
            );
            setPendingFigmaAssetRequests([]);
          } else {
            const { summary } = figmaImport.report;
            setPendingFigmaAssetRequests(figmaImport.assetRequests);
            setFigmaImportStatus(
              `Imported ${summary.pageCount} page${summary.pageCount === 1 ? "" : "s"} · ${summary.nodeCount} layer${summary.nodeCount === 1 ? "" : "s"}${summary.assetRequestCount ? ` · ${summary.assetRequestCount} image${summary.assetRequestCount === 1 ? "" : "s"} need authorization` : ""}${summary.rejectedCount || summary.omittedCount || summary.preservedExtensionCount ? " · report ready" : ""}`,
            );
          }
        }
        const figmaAssetBinding = pendingFigmaAssetBindingRef.current;
        if (figmaAssetBinding?.transactionId === data.transactionId) {
          pendingFigmaAssetBindingRef.current = undefined;
          setFigmaAssetBinding(false);
          if (data.errorCode)
            setFigmaImportStatus(
              `Image binding failed · ${data.errorCode.toLowerCase().replaceAll("_", " ")}`,
            );
          else {
            const completed = figmaAssetBinding.request;
            setPendingFigmaAssetRequests((current) =>
              current.filter(
                (request) => !sameFigmaAssetRequest(request, completed),
              ),
            );
            setFigmaImportStatus("Figma image bound to its imported layer");
          }
        }
        const acknowledgement = transactionQueueRef.current?.acknowledge(data);
        if (acknowledgement?.handled && !acknowledgement.retried) {
          optimisticUpdatesRef.current.delete(data.transactionId);
          const projected = applyOptimisticUpdates(
            confirmedSnapshotRef.current,
            optimisticUpdatesRef.current.values(),
          );
          snapshotRef.current = projected;
          setDocumentState(projected);
          setSelectionState({ selectedIds: projected.selectedIds });
          setViewState({
            viewport: projected.viewport,
            performance: projected.performance,
          });
        }
        if (data.errorCode)
          setStatus(
            `Engine worker online · ${data.errorCode.toLowerCase().replaceAll("_", " ")}`,
          );
      }
      if (data.type === "tool") {
        activeToolRef.current = data.tool;
        setTool(data.tool);
      }
      if (data.type === "error") {
        revisionRef.current = data.documentRevision;
        setError(data.safeMessage);
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      if (!disposed) recoverWorker("error");
    };
    worker.onmessageerror = () => {
      if (!disposed) recoverWorker("message-error");
    };
    const offscreen = canvas.transferControlToOffscreen();
    transferredCanvasRef.current = canvas;
    post(
      {
        type: "init",
        canvas: offscreen,
        width: canvas.clientWidth,
        height: canvas.clientHeight,
        dpr: window.devicePixelRatio || 1,
        documentId,
        rendererPreference,
        simulateGpuLosses,
        simulateGpuLossAfterImage,
        simulateGpuFault,
      },
      [offscreen],
    );
    syncWorkerVisibility();
    return () => {
      disposed = true;
      if (crashSimulationTimer) clearTimeout(crashSimulationTimer);
      if (remoteBootstrapRetryTimer) clearTimeout(remoteBootstrapRetryTimer);
      observer.disconnect();
      document.removeEventListener("visibilitychange", syncWorkerVisibility);
      runtimeBridge.close();
      if (runtimeBridgeRef.current === runtimeBridge)
        runtimeBridgeRef.current = null;
      if (workerRef.current === worker) {
        runtimeRef.current = null;
        workerRef.current = null;
      }
      worker.terminate();
    };
  }, [
    canvasGeneration,
    documentId,
    ensureMainFontFace,
    fixtureAssetNodes,
    fixtureAssetSeeds,
    fixtureSnapshot,
    fixtureStatus,
    onDocumentSaved,
    post,
    recoverWorker,
    rehydrateFromRemote,
    remoteSync,
    rendererPreference,
    setStatusForRevision,
    simulateGpuFault,
    simulateGpuLossAfterImage,
    simulateGpuLosses,
    simulateWorkerCrashDelayMs,
    simulateWorkerCrashes,
    synchronizePendingOperations,
  ]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const input: EditorInputEvent = {
        type: "wheel",
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        ctrlKey: event.ctrlKey || event.metaKey,
        occurredAt: Date.now(),
      };
      const batcher = inputBatcherRef.current;
      // Trackpads commonly deliver wheel samples faster than the display can
      // present them. Queue the ordered samples until the next animation frame;
      // the Worker applies the whole batch to the camera and renders once. This
      // preserves exact pan/zoom anchoring without wasting several full scene
      // paints inside one visible frame.
      if (batcher) batcher.enqueue(input);
      else postInput([input]);
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => canvas.removeEventListener("wheel", wheel);
  }, [canvasGeneration, postInput]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        (event.target as HTMLElement).matches(
          'input, textarea, select, [contenteditable="true"]',
        )
      )
        return;
      // Roving focus in Layers owns its arrow keys. Canvas nudging remains
      // available whenever focus is on the canvas or the surrounding chrome.
      if (
        (event.target as HTMLElement).closest(".layer-list") &&
        [
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "Home",
          "End",
        ].includes(event.key)
      )
        return;
      if (safeMode) return;
      const modifier = event.metaKey || event.ctrlKey;
      const shortcutKey = event.key.toLowerCase();
      if (modifier && shortcutKey === "a") {
        // Selection is presentation state, but claiming Select All here keeps
        // the browser from selecting the surrounding editor chrome when focus
        // is on a toolbar or Inspector control.
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const current = snapshotRef.current;
        command({
          type: "select",
          ids: current.nodes
            .filter(
              (node) => (node.pageId ?? defaultPageId) === current.activePageId,
            )
            .map((node) => node.id),
        });
        return;
      }
      // Figma's Shift+A turns a selected Frame into an Auto Layout container.
      // Handle it before the `A` Arrow tool shortcut.
      if (
        writerRef.current &&
        !modifier &&
        event.shiftKey &&
        shortcutKey === "a"
      ) {
        const current = snapshotRef.current;
        const frame =
          current.selectedIds.length === 1
            ? current.nodes.find(
                (node) =>
                  node.id === current.selectedIds[0] && node.kind === "frame",
              )
            : undefined;
        event.preventDefault();
        event.stopPropagation();
        if (frame) {
          command({
            type: "update",
            id: frame.id,
            patch: {
              autoLayout: {
                ...(frame.autoLayout ?? defaultAutoLayout()),
                mode: "vertical",
                absolute: false,
              },
            },
          });
        } else if (current.selectedIds.length >= 2) {
          // Figma wraps a multi-layer selection in a Frame and makes that
          // Frame an Auto Layout container. Hug keeps the wrapper responsive
          // as its newly created flow children or nested layouts change.
          command({
            type: "group",
            ids: current.selectedIds,
            autoLayout: {
              ...defaultAutoLayout(),
              primarySizing: "hug",
              counterSizing: "hug",
            },
          });
        } else
          setStatus(
            "Select one Frame or two or more layers to add Auto layout",
          );
        return;
      }
      const match = tools.find(
        (entry) => entry.key.toLowerCase() === event.key.toLowerCase(),
      );
      if (match && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        if (writerRef.current || match.id === "select" || match.id === "hand") {
          activeToolRef.current = match.id;
          setTool(match.id);
          post({ type: "tool", tool: match.id });
        } else setStatus("Engine worker online · read-only tab");
      }
      const isMac = navigator.platform.includes("Mac");
      const alternativeUngroup = isAlternativeUngroupShortcut({
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        isMac,
      });
      if (
        writerRef.current &&
        shouldClaimKeyboardToolEnter({
          key: event.key,
          modifier,
          shiftKey: event.shiftKey,
          tool: activeToolRef.current,
        })
      ) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      }
      if (
        writerRef.current &&
        snapshotRef.current.selectedIds.length &&
        !modifier &&
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
      ) {
        // The Engine Worker resolves the delta in world space. Claim this here
        // so the page never scrolls while a canvas selection is being nudged.
        event.preventDefault();
      }
      if (
        (modifier &&
          ["z", "y", "d", "g", "c", "x", "v"].includes(shortcutKey)) ||
        alternativeUngroup
      ) {
        // Claim editor-owned document shortcuts during the capture phase. In
        // particular, ⌘Z / ⌘G can otherwise reach browser-level shortcuts when
        // a Layer-panel button has focus, which produced unrelated browser
        // undo/navigation behavior instead of editing the document.
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      }
      if (modifier && ["c", "x", "v"].includes(shortcutKey)) {
        if (!writerRef.current) return;
        const current = snapshotRef.current;
        if (shortcutKey === "c" || shortcutKey === "x") {
          void (async () => {
            const captured = captureClipboard(
              current.nodes,
              current.selectedIds,
              19,
            );
            const payload = captured
              ? await encodeNodeClipboard(
                  captured,
                  {
                    documentId: current.documentId,
                    pageId: current.activePageId,
                  },
                  current.assets ?? [],
                )
              : undefined;
            if (!payload) {
              setStatus("无法复制当前选择");
              return;
            }
            let copied = false;
            try {
              if (!navigator.clipboard)
                throw new Error("SYSTEM_CLIPBOARD_UNAVAILABLE");
              await navigator.clipboard.writeText(payload);
              copied = true;
            } catch {
              /* A serializable same-origin fallback is attempted below. */
            }
            // Browser clipboard read permissions are independently gated from
            // write permissions. Keep the byte-free envelope as a same-origin
            // fallback even after a successful system write, so a destination
            // tab can paste deterministically when `readText()` is denied.
            try {
              window.localStorage.setItem(
                "makefigma-node-clipboard-v1",
                payload,
              );
              copied = true;
            } catch {
              /* a failed copy must never turn Cut into Delete */
            }
            if (!copied) {
              setStatus("无法写入剪贴板");
              return;
            }
            post({
              type: "command",
              command:
                shortcutKey === "c"
                  ? { type: "copy", ids: current.selectedIds }
                  : { type: "cut", ids: current.selectedIds },
            });
          })();
          return;
        }
        void (async () => {
          let payload: string | null = null;
          try {
            payload = navigator.clipboard
              ? await navigator.clipboard.readText()
              : null;
          } catch {
            /* Serializable fallback is checked below. */
          }
          if (!payload) {
            try {
              payload = window.localStorage.getItem(
                "makefigma-node-clipboard-v1",
              );
            } catch {
              /* Worker fast path remains available. */
            }
          }
          const decoded = payload
            ? await decodeNodeClipboard(payload, 19)
            : undefined;
          if (decoded)
            post({
              type: "set-clipboard",
              clipboard: decoded.clipboard,
              sourceDocumentId: decoded.sourceDocumentId,
            });
          post({ type: "command", command: { type: "paste" } });
        })();
        return;
      }
      if (modifier && shortcutKey === "g") {
        // Use the same queued command path as the Layer-panel Group button.
        // Sending this through the low-level Worker key channel could race the
        // most recent one-layer selection update, leaving it empty when ⌘G was
        // pressed immediately after choosing a layer.
        const current = snapshotRef.current;
        if (event.shiftKey) {
          const selected =
            current.selectedIds.length === 1
              ? current.nodes.find((node) => node.id === current.selectedIds[0])
              : undefined;
          if (selected?.kind === "group")
            command({ type: "ungroup", id: selected.id });
        } else if (current.selectedIds.length) {
          command({ type: "group", ids: current.selectedIds });
        }
        return;
      }
      if (modifier && shortcutKey === "d") {
        // Duplicate must use the same queued path as the Inspector button.
        // The Worker key channel can otherwise observe the prior selection
        // when the shortcut follows a Layer-panel click without a frame gap.
        const current = snapshotRef.current;
        if (writerRef.current && current.selectedIds.length) {
          command({ type: "duplicate", ids: current.selectedIds });
        }
        return;
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        ["[", "]"].includes(event.key) &&
        writerRef.current
      ) {
        event.preventDefault();
        const direction: LayerOrderAction =
          event.key === "]"
            ? event.shiftKey
              ? "front"
              : "forward"
            : event.shiftKey
              ? "back"
              : "backward";
        reorderSelectedLayers(direction);
        return;
      }
      if (writerRef.current) {
        post({
          type: "key",
          key: event.key,
          metaKey: modifier,
          shiftKey: event.shiftKey,
          alternativeUngroup,
        });
      }
    };
    // Capture before focused controls in the Layers panel and before any
    // browser-integrated shortcut handlers get a chance to observe this event.
    window.addEventListener("keydown", listener, { capture: true });
    return () =>
      window.removeEventListener("keydown", listener, { capture: true });
  }, [command, post, reorderSelectedLayers, safeMode]);

  // Viewport updates replace `snapshot`, but keep the document and selection
  // references stable. Depending on the whole snapshot made every zoom frame
  // linearly scan all 50K nodes just to rediscover that nothing is selected.
  const selectedNodes = useMemo(() => {
    const ids = new Set(snapshot.selectedIds);
    return snapshot.nodes.filter((node) => ids.has(node.id));
  }, [snapshot.nodes, snapshot.selectedIds]);
  const selected = selectedNodes.length === 1 ? selectedNodes[0] : undefined;
  const selectedBooleanFlattenable = Boolean(
    selected?.kind === "booleanOperation" &&
    snapshot.nodes.filter((node) => node.parentId === selected.id).length >=
      2 &&
    snapshot.nodes
      .filter((node) => node.parentId === selected.id)
      .every((node) => node.kind === "vector" && Boolean(node.vectorPath)),
  );
  const selectedVectorOutlineable = Boolean(
    selected &&
    selected.strokeWidth > 0 &&
    ((selected.kind === "line" &&
      (!selected.strokeDashPattern?.length
        ? [
            "none",
            "round",
            "square",
            "arrowLines",
            "arrowEquilateral",
            "triangleFilled",
            "diamondFilled",
            "circleFilled",
          ].includes(selected.strokeCapStart ?? "none") &&
          [
            "none",
            "round",
            "square",
            "arrowLines",
            "arrowEquilateral",
            "triangleFilled",
            "diamondFilled",
            "circleFilled",
          ].includes(selected.strokeCapEnd ?? "none")
        : selected.strokeCapStart === selected.strokeCapEnd &&
          ["none", "round", "square"].includes(
            selected.strokeCapStart ?? "none",
          ))) ||
      (selected.kind === "vector" &&
        Boolean(selected.vectorPath) &&
        selected.strokeCapStart === selected.strokeCapEnd &&
        ["none", "round", "square"].includes(
          selected.strokeCapStart ?? "none",
        ))),
  );
  const selectedParametricConvertible = Boolean(
    (selected?.kind === "polygon" || selected?.kind === "star") &&
    selected.parametricShape,
  );
  const canEdit =
    documentHydrated &&
    documentAuthorityReady &&
    accessPreference === "edit" &&
    writerMode === "owner" &&
    !safeMode &&
    !fixtureResetting;
  const accessLabel = !documentHydrated
    ? "加载中"
    : !documentAuthorityReady
      ? reconciliationProgress
        ? `正在恢复本地更改 ${reconciliationProgress.completed}/${reconciliationProgress.total}`
        : "正在同步"
    : safeMode
    ? "安全模式"
    : accessPreference === "view"
      ? "只读"
      : writerMode === "owner"
        ? "可编辑"
        : "申请编辑中";
  const renderEvidence = deterministicEvidenceCapture
    ? "collecting render evidence"
    : snapshot.performance?.samples
      ? `render P95 ${snapshot.performance.p95Ms.toFixed(1)}ms · ${snapshot.diagnostics?.total ?? 0} diagnostics`
      : "collecting render evidence";
  const renderPerformanceEvidence = snapshot.performance
    ? JSON.stringify(snapshot.performance)
    : undefined;
  const mainThreadEvidence =
    mainThreadMonitor === "waiting"
      ? "main task monitor starting"
      : mainThreadMonitor === "unavailable"
        ? "main-task monitor unavailable"
        : mainThreadLongTasks.count
          ? `main ${mainThreadLongTasks.count} long tasks · worst ${mainThreadLongTasks.maxDurationMs.toFixed(0)}ms`
          : "main 0 long tasks";
  const frameEvidence = frameIntervals.samples
    ? `frame P95 ${frameIntervals.p95Ms.toFixed(1)}ms`
    : "collecting frame intervals";
  const inputBacklogEvidence = snapshot.performance?.inputToRenderSamples
    ? `input→render P95 ${snapshot.performance.inputToRenderP95Ms.toFixed(1)}ms · backlog P95 ${inputBacklog.p95Ms.toFixed(1)}ms`
    : inputBacklog.samples
      ? `collecting input→render · backlog P95 ${inputBacklog.p95Ms.toFixed(1)}ms`
      : "collecting input latency";
  const viewportCheckpointEvidence = viewportCheckpoints.samples
    ? `viewport checkpoint P95 ${viewportCheckpoints.p95Ms.toFixed(1)}ms`
    : "collecting viewport checkpoints";
  const resourceEvidence = snapshot.resources
    ? `${snapshot.assets?.length ?? 0} assets · ${snapshot.resources.documentNodes}/${snapshot.resources.maxDocumentNodes} nodes · ${(snapshot.resources.documentBytes / 1024 / 1024).toFixed(1)}/${(snapshot.resources.maxDocumentBytes / 1024 / 1024).toFixed(0)} MB document · ${(snapshot.resources.wasmHeapBytes / 1024 / 1024).toFixed(1)}/${(snapshot.resources.maxWasmHeapBytes / 1024 / 1024).toFixed(0)} MB WASM · ${(snapshot.resources.renderSurfaceBytes / 1024 / 1024).toFixed(1)}/${(snapshot.resources.maxRenderSurfaceBytes / 1024 / 1024).toFixed(0)} MB surface · ${(snapshot.resources.gpuSceneBytes / 1024 / 1024).toFixed(1)}/${(snapshot.resources.maxGpuSceneBytes / 1024 / 1024).toFixed(0)} MB GPU scene · ${(snapshot.resources.gpuEffectTextureBytes / 1024 / 1024).toFixed(1)}/${(snapshot.resources.maxGpuEffectTextureBytes / 1024 / 1024).toFixed(0)} MB GPU effects${snapshot.resources.gpuSceneWithinBudget ? "" : " (Canvas fallback)"}`
    : "collecting resource evidence";
  const setActiveTool = useCallback(
    (next: ToolKind) => {
      if (safeMode) return;
      if (!writerRef.current && next !== "select" && next !== "hand") {
        setStatus("Engine worker online · read-only tab");
        return;
      }
      activeToolRef.current = next;
      setTool(next);
      post({ type: "tool", tool: next });
    },
    [post, safeMode],
  );
  const pointer = (
    event: React.PointerEvent<HTMLCanvasElement>,
    type: "down" | "move" | "up" | "leave",
  ) => {
    if (safeMode) return;
    const readOnly = !writerRef.current;
    if (readOnly && tool !== "select" && tool !== "hand") {
      setStatus("Engine worker online · read-only tab");
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const packet: EditorInputEvent = {
      type: "pointer",
      event: type,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      button: event.button,
      occurredAt: Date.now(),
      ...(event.metaKey || event.ctrlKey ? { deepSelect: true } : {}),
      ...(readOnly ? { readOnly: true } : {}),
    };
    if (type === "move") {
      const batcher = inputBatcherRef.current;
      if (batcher) batcher.enqueue(packet);
      else postInput([packet]);
      return;
    }
    const batcher = inputBatcherRef.current;
    if (batcher) batcher.flushWith(packet);
    else postInput([packet]);
  };
  const drillDownAtCanvasPoint = (
    event: React.MouseEvent<HTMLCanvasElement>,
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const readOnly = !writerRef.current;
    const base = {
      type: "pointer" as const,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      button: event.button,
      occurredAt: Date.now(),
      ...(event.metaKey || event.ctrlKey ? { deepSelect: true as const } : {}),
      ...(readOnly ? { readOnly: true as const } : {}),
    };
    // PointerEvent does not reliably carry a click count. The browser's native
    // double-click event is the authoritative boundary, so replay a no-motion
    // press/release pair. The Worker first offers the repeated press to a
    // selected Vector segment, then retains the existing Group drill-down path.
    postInput([
      { ...base, event: "down", drillDown: true, splitVectorSegment: true },
      { ...base, event: "up" },
    ]);
  };
  const startCanvasTextEdit = async (
    event: React.MouseEvent<HTMLCanvasElement>,
  ) => {
    if (!canEdit) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point = {
      x:
        (event.clientX - rect.left - rect.width / 2) / snapshot.viewport.zoom -
        snapshot.viewport.x,
      y:
        (event.clientY - rect.top - rect.height / 2) / snapshot.viewport.zoom -
        snapshot.viewport.y,
    };
    const target = [...snapshot.nodes]
      .reverse()
      .find((node) => textNodeContainsPoint(node, point));
    if (!target) return;
    const fontAssetId = target.textProperties?.runs[0]?.font?.assetId;
    if (fontAssetId) {
      const fontAsset = snapshot.assets?.find(
        (asset) => asset.assetId === fontAssetId,
      );
      if (
        !fontAsset ||
        !(await ensureMainFontFace(snapshot.documentId, fontAsset))
      ) {
        setStatus("Engine worker online · text font unavailable");
        return;
      }
    }
    command({ type: "select", ids: [target.id] });
    canvasTextCommitRef.current = false;
    post({ type: "editing-text", nodeId: target.id });
    const text = target.text ?? "";
    const caret = textCaretAtPoint(target, point);
    setCanvasTextEdit({
      nodeId: target.id,
      draft: text,
      initialDraft: text,
      properties: textReplacementProperties(target, text),
      caret,
      selectionAnchor: caret,
      rustCaretReady: false,
    });
    requestCanvasCaretLayout(target.id, text, caret);
  };
  const commitCanvasTextEdit = (domDraft?: string) => {
    if (
      !canvasTextEdit ||
      canvasTextCommitRef.current ||
      canvasTextIsComposingRef.current
    )
      return;
    canvasTextCommitRef.current = true;
    const node = snapshot.nodes.find(
      (candidate) => candidate.id === canvasTextEdit.nodeId,
    );
    const draft = unicodeScalarText(domDraft ?? canvasTextEdit.draft);
    if (node && draft !== (node.text ?? "")) {
      const properties =
        draft === canvasTextEdit.draft
          ? canvasTextDraftProperties(canvasTextEdit)
          : rebaseTextStyleRuns(
              canvasTextEdit.initialDraft,
              draft,
              canvasTextEdit.properties,
            );
      command({
        type: "update",
        id: node.id,
        patch: { text: draft, textProperties: properties },
      });
    }
    post({ type: "editing-text" });
    setCanvasTextEdit(undefined);
  };
  const cancelCanvasTextEdit = () => {
    canvasTextCommitRef.current = true;
    canvasTextIsComposingRef.current = false;
    pendingCanvasCaretLayoutsRef.current.clear();
    post({ type: "editing-text" });
    setCanvasTextEdit(undefined);
  };
  const handleCanvasTextBeforeInput = useCallback(
    (editor: HTMLDivElement, input: InputEvent) => {
      const edit = canvasTextEdit;
      if (
        !edit ||
        canvasTextIsComposingRef.current ||
        !edit.rustCaretReady ||
        !edit.rustCaretLayout
      )
        return;
      const selection = contentEditableSelectionOffsets(editor);
      if (!selection) return;
      let replacement = "";
      let next:
        ReturnType<typeof replaceUtf16SelectionInRustLayout> | undefined;
      switch (input.inputType) {
        case "deleteContentBackward":
          next = deleteUtf16SelectionInRustLayout(
            edit.draft,
            selection.anchor,
            selection.focus,
            -1,
            edit.rustCaretLayout,
          );
          break;
        case "deleteContentForward":
          next = deleteUtf16SelectionInRustLayout(
            edit.draft,
            selection.anchor,
            selection.focus,
            1,
            edit.rustCaretLayout,
          );
          break;
        case "insertText":
        case "insertReplacementText":
          if (input.data !== null) {
            replacement = unicodeScalarText(input.data);
            next = replaceUtf16SelectionInRustLayout(
              edit.draft,
              selection.anchor,
              selection.focus,
              replacement,
              edit.rustCaretLayout,
            );
          }
          break;
        case "insertLineBreak":
        case "insertParagraph":
          replacement = "\n";
          next = replaceUtf16SelectionInRustLayout(
            edit.draft,
            selection.anchor,
            selection.focus,
            replacement,
            edit.rustCaretLayout,
          );
          break;
        default:
          return;
      }
      if (!next) return;
      input.preventDefault();
      replaceContentEditableRange(
        editor,
        next.replacedStart,
        next.replacedEnd,
        replacement,
      );
      setCanvasTextEdit((current) =>
        current &&
        current.nodeId === edit.nodeId &&
        current.draft === edit.draft
          ? {
              ...current,
              draft: next.draft,
              caret: next.caret,
              selectionAnchor: next.selectionAnchor,
              rustCaretReady: false,
              rustCaretLayout: undefined,
            }
          : current,
      );
      requestCanvasCaretLayout(edit.nodeId, next.draft, next.caret);
    },
    [canvasTextEdit, requestCanvasCaretLayout],
  );
  const canvasTextNode = canvasTextEdit
    ? snapshot.nodes.find(
        (node) => node.id === canvasTextEdit.nodeId && node.kind === "text",
      )
    : undefined;
  useEffect(() => {
    const editor = canvasTextEditorRef.current;
    if (!editor || !canvasTextEdit) return;
    const listener = (event: InputEvent) =>
      handleCanvasTextBeforeInput(editor, event);
    editor.addEventListener("beforeinput", listener);
    return () => editor.removeEventListener("beforeinput", listener);
  }, [canvasTextEdit, handleCanvasTextBeforeInput]);
  useEffect(() => {
    const editor = canvasTextEditorRef.current;
    if (!editor) return;
    // Native target listeners run before React's delegated contentEditable
    // handlers, including composition commits that did not emit beforeinput.
    // That lets the existing caret/layout update consume the normalized draft.
    const normalize = () => {
      normalizedContentEditableText(editor);
    };
    editor.addEventListener("input", normalize);
    editor.addEventListener("compositionend", normalize);
    return () => {
      editor.removeEventListener("input", normalize);
      editor.removeEventListener("compositionend", normalize);
    };
  }, [canvasTextEdit?.nodeId]);
  const canvasTextStyle = canvasTextNode
    ? (() => {
        const primary = canvasTextEdit?.properties.runs[0];
        const fontFamily = primary?.font
          ? `"${fontFamilyForAsset(primary.font.assetId)}", `
          : "";
        const fontSize = primary?.fontSize ?? 31;
        const lineHeight =
          canvasTextEdit?.properties.paragraph.lineHeight ??
          DEFAULT_TEXT_LINE_HEIGHT;
        return {
          left: `calc(50% + ${(canvasTextNode.x + snapshot.viewport.x) * snapshot.viewport.zoom}px)`,
          top: `calc(50% + ${(canvasTextNode.y + snapshot.viewport.y) * snapshot.viewport.zoom}px)`,
          width: `${Math.max(1, canvasTextNode.width * snapshot.viewport.zoom)}px`,
          height: `${Math.max(1, canvasTextNode.height * snapshot.viewport.zoom)}px`,
          fontSize: `${fontSize * snapshot.viewport.zoom}px`,
          lineHeight: `${lineHeight * snapshot.viewport.zoom}px`,
          fontFamily: `${fontFamily}${canvasDesignTokens.typography.canvasText.family}`,
          fontWeight:
            primary?.fontWeight ??
            canvasDesignTokens.typography.canvasText.weight,
          fontStyle: primary?.italic ? "italic" : "normal",
          fontSynthesis: "none",
          letterSpacing: `${(primary?.letterSpacing ?? 0) * snapshot.viewport.zoom}px`,
          color: canvasTextNode.fill,
          textAlign:
            canvasTextEdit?.properties.paragraph.alignment === "justify"
              ? "left"
              : (canvasTextEdit?.properties.paragraph.alignment ?? "left"),
          transform: `rotate(${canvasTextNode.rotation}deg)`,
          transformOrigin: "center center",
        } as const;
      })()
    : undefined;
  const canvasTextEditParagraphs =
    canvasTextNode && canvasTextEdit
      ? textParagraphRanges(canvasTextEdit.initialDraft).map((paragraph) => ({
          ...paragraph,
          spans: styledTextSpans(
            canvasTextEdit.initialDraft,
            paragraph.start,
            paragraph.end,
            canvasTextEdit.properties,
          ),
        }))
      : [];
  const update = (patch: Partial<CanvasNode>) => {
    if (
      patch.strokeWidth !== undefined &&
      (!Number.isFinite(patch.strokeWidth) || patch.strokeWidth < 0)
    )
      return;
    if (patch.rotation !== undefined && !Number.isFinite(patch.rotation))
      return;
    if (selected)
      command({
        type: "update",
        id: selected.id,
        patch: resolveTextAutoSizePatch(selected, patch),
      });
  };
  const moveVectorPoint = (
    id: string,
    pointId: string,
    x: number,
    y: number,
  ) => {
    if (
      safeMode ||
      !writerRef.current ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    )
      return;
    transactionQueueRef.current?.enqueue([
      { type: "moveVectorPoint", id, pointId, x, y },
    ]);
  };
  const setVectorSubpathClosed = (
    id: string,
    subpathIndex: number,
    closed: boolean,
  ) => {
    if (safeMode || !writerRef.current) return;
    transactionQueueRef.current?.enqueue([
      { type: "setVectorSubpathClosed", id, subpathIndex, closed },
    ]);
  };
  const insertVectorPoint = (
    id: string,
    subpathIndex: number,
    afterPointId: string | undefined,
    point: NonNullable<
      CanvasNode["vectorPath"]
    >["subpaths"][number]["points"][number],
  ) => {
    if (safeMode || !writerRef.current) return;
    transactionQueueRef.current?.enqueue([
      { type: "insertVectorPoint", id, subpathIndex, afterPointId, point },
    ]);
  };
  const splitVectorSegment = (
    id: string,
    subpathIndex: number,
    afterPointId: string,
    t: number,
    pointId: string,
  ) => {
    if (safeMode || !writerRef.current) return;
    transactionQueueRef.current?.enqueue([
      {
        type: "splitVectorSegment",
        id,
        subpathIndex,
        afterPointId,
        t,
        pointId,
      },
    ]);
  };
  const setMask = (id: string, enabled: boolean) => {
    if (safeMode || !writerRef.current) return;
    transactionQueueRef.current?.enqueue([{ type: "setMask", id, enabled }]);
  };
  const deleteVectorPoint = (id: string, pointId: string) => {
    if (safeMode || !writerRef.current) return;
    transactionQueueRef.current?.enqueue([
      { type: "deleteVectorPoint", id, pointId },
    ]);
  };
  const setVectorPointHandles = (
    id: string,
    pointId: string,
    handleIn: { x: number; y: number } | undefined,
    handleOut: { x: number; y: number } | undefined,
    pointType: NonNullable<
      CanvasNode["vectorPath"]
    >["subpaths"][number]["points"][number]["pointType"],
  ) => {
    if (safeMode || !writerRef.current) return;
    transactionQueueRef.current?.enqueue([
      {
        type: "setVectorPointHandles",
        id,
        pointId,
        handleIn,
        handleOut,
        pointType,
      },
    ]);
  };
  const updateSelection = (patch: Partial<CanvasNode>) => {
    if (
      patch.strokeWidth !== undefined &&
      (!Number.isFinite(patch.strokeWidth) || patch.strokeWidth < 0)
    )
      return;
    if (patch.rotation !== undefined && !Number.isFinite(patch.rotation))
      return;
    if (selectedNodes.length === 1) {
      update(patch);
      return;
    }
    if (safeMode || !writerRef.current || selectedNodes.length < 2) return;
    // The queue resolves this array as one Core batch, so a multi-select edit
    // has one revision and one Undo item. Each node gets its own text-safe
    // projection rather than borrowing a value from the first selected node.
    transactionQueueRef.current?.enqueue(
      selectedNodes.map((node) => ({
        type: "update" as const,
        id: node.id,
        patch: resolveTextAutoSizePatch(node, patch),
      })),
    );
  };
  const updateSelectionGeometry = (
    patch: Partial<Pick<CanvasNode, "x" | "y" | "width" | "height">>,
  ) => {
    if (safeMode || !writerRef.current || selectedNodes.length < 2) return;
    const current = snapshotRef.current;
    const resolved = selectionGeometryPatches(
      current.nodes,
      current.selectedIds,
      patch,
    );
    if (!resolved) return;
    transactionQueueRef.current?.enqueue(
      resolved.selection.ids.map((id) => ({
        type: "update" as const,
        id,
        patch: resolved.patches.get(id)!,
      })),
    );
  };
  const updateSelectionStrokeWeight = (index: number, value: number) => {
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      safeMode ||
      !writerRef.current ||
      selectedNodes.length < 2 ||
      !selectedNodes.every(
        (node) => node.kind === "frame" || node.kind === "rectangle",
      )
    )
      return;
    transactionQueueRef.current?.enqueue(
      selectedNodes.map((node) => {
        const weights = [...resolvedStrokeWeights(node)] as [
          number,
          number,
          number,
          number,
        ];
        weights[index] = value;
        return {
          type: "update" as const,
          id: node.id,
          patch: { strokeWeights: weights },
        };
      }),
    );
  };
  const useSelectionUniformStrokeWeights = () => {
    if (
      safeMode ||
      !writerRef.current ||
      selectedNodes.length < 2 ||
      !selectedNodes.every(
        (node) => node.kind === "frame" || node.kind === "rectangle",
      )
    )
      return;
    transactionQueueRef.current?.enqueue(
      selectedNodes.map((node) => ({
        type: "update" as const,
        id: node.id,
        patch: { strokeWeights: undefined },
      })),
    );
  };
  const updateSelectionCornerRadius = (index: number, value: number) => {
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      safeMode ||
      !writerRef.current ||
      selectedNodes.length < 2 ||
      !selectedNodes.every(
        (node) =>
          node.kind === "frame" ||
          node.kind === "rectangle" ||
          node.kind === "section",
      )
    )
      return;
    transactionQueueRef.current?.enqueue(
      selectedNodes.map((node) => {
        const radii = [...resolvedCornerRadii(node)] as [
          number,
          number,
          number,
          number,
        ];
        radii[index] = value;
        return {
          type: "update" as const,
          id: node.id,
          patch: { cornerRadii: radii },
        };
      }),
    );
  };
  const useSelectionUniformCornerRadius = () => {
    if (
      safeMode ||
      !writerRef.current ||
      selectedNodes.length < 2 ||
      !selectedNodes.every(
        (node) =>
          node.kind === "frame" ||
          node.kind === "rectangle" ||
          node.kind === "section",
      )
    )
      return;
    transactionQueueRef.current?.enqueue(
      selectedNodes.map((node) => ({
        type: "update" as const,
        id: node.id,
        patch: { cornerRadii: undefined },
      })),
    );
  };
  const updateSelectionConstraint = (
    axis: "horizontal" | "vertical",
    value: ConstraintType,
  ) => {
    if (
      safeMode ||
      !writerRef.current ||
      selectedNodes.length < 2 ||
      !selectedNodes.every(
        (node) =>
          hasFrameConstraintScope(snapshotRef.current.nodes, node) &&
          !hasActiveAutoLayoutConstraintOverride(
            snapshotRef.current.nodes,
            node,
          ),
      )
    )
      return;
    transactionQueueRef.current?.enqueue(
      selectedNodes.map((node) => ({
        type: "update" as const,
        id: node.id,
        patch: {
          constraints: {
            ...(node.constraints ?? {
              horizontal: "min" as const,
              vertical: "min" as const,
            }),
            [axis]: value,
          },
        },
      })),
    );
  };
  const removeSelectionConstraints = () => {
    if (
      safeMode ||
      !writerRef.current ||
      selectedNodes.length < 2 ||
      !selectedNodes.every(
        (node) =>
          hasFrameConstraintScope(snapshotRef.current.nodes, node) &&
          !hasActiveAutoLayoutConstraintOverride(
            snapshotRef.current.nodes,
            node,
          ),
      )
    )
      return;
    transactionQueueRef.current?.enqueue(
      selectedNodes.map((node) => ({
        type: "update" as const,
        id: node.id,
        patch: { constraints: undefined },
      })),
    );
  };
  const selectCreationTool = useCallback(
    (kind: Exclude<ToolKind, "select" | "hand" | "pen" | "arrow">) =>
      setActiveTool(kind),
    [setActiveTool],
  );
  const selectLayer = useCallback(
    (id: string, options?: { additive?: boolean }) => {
      const selected = snapshotRef.current.selectedIds;
      command({
        type: "select",
        ids: resolveCanvasObjectSelection(
          selected,
          id,
          Boolean(options?.additive),
        ),
      });
    },
    [command],
  );
  const dropLayer = useCallback(
    (draggedId: string, target?: { beforeId?: string; parentId?: string }) => {
      const current = snapshotRef.current;
      const pageNodes = current.nodes.filter(
        (node) => (node.pageId ?? defaultPageId) === current.activePageId,
      );
      const moving = current.selectedIds.includes(draggedId)
        ? current.selectedIds
        : [draggedId];
      if (target?.parentId) {
        command({ type: "reparent", ids: moving, parentId: target.parentId });
        return;
      }
      const resolved = resolveLayerDrop(pageNodes, moving, target?.beforeId);
      if (resolved)
        command({
          type: "reposition",
          positionIds: [...resolved.positionIds].map(([id, positionId]) => ({
            id,
            positionId,
          })),
        });
    },
    [command],
  );
  const nestLayer = useCallback(
    (id: string, intent: LayerNestingIntent) => {
      const current = snapshotRef.current;
      const pageNodes = current.nodes.filter(
        (node) => (node.pageId ?? defaultPageId) === current.activePageId,
      );
      const target = layerKeyboardNestingTarget(pageNodes, id, intent);
      if (target)
        command({
          type: "reparent",
          ids: [target.id],
          parentId: target.parentId,
        });
    },
    [command],
  );
  const renameLayer = useCallback(
    (id: string, name: string) => {
      const next = name.trim();
      if (next) command({ type: "update", id, patch: { name: next } });
    },
    [command],
  );
  const createFrame = useCallback(
    () => selectCreationTool("frame"),
    [selectCreationTool],
  );
  const createRectangle = useCallback(
    () => selectCreationTool("rectangle"),
    [selectCreationTool],
  );
  const createText = useCallback(
    () => selectCreationTool("text"),
    [selectCreationTool],
  );
  const groupSelected = useCallback(
    () => command({ type: "group", ids: snapshotRef.current.selectedIds }),
    [command],
  );
  const booleanSelected = useCallback(
    (operation: DocumentBooleanOperation) =>
      command({
        type: "boolean",
        ids: snapshotRef.current.selectedIds,
        operation,
      }),
    [command],
  );
  const ungroupSelected = useCallback(() => {
    const current = snapshotRef.current;
    const group =
      current.selectedIds.length === 1
        ? current.nodes.find((node) => node.id === current.selectedIds[0])
        : undefined;
    if (group?.kind === "group") command({ type: "ungroup", id: group.id });
  }, [command]);
  const openAssetPicker = useCallback(() => {
    const input = assetInputRef.current;
    if (!input) return;
    // Some embedded browser surfaces do not honor a synthetic click on an
    // invisible input. Prefer the user-activation-preserving picker API, while
    // retaining the click fallback for browsers that do not implement it.
    try {
      input.showPicker();
    } catch {
      input.click();
    }
  }, []);
  const openFigmaImportPicker = useCallback(() => {
    const input = figmaImportInputRef.current;
    if (!input) return;
    try {
      input.showPicker();
    } catch {
      input.click();
    }
  }, []);
  const importFigmaRestJson = useCallback(
    async (file: File) => {
      if (!canEdit) return;
      if (file.size <= 0 || file.size > MAX_FIGMA_REST_IMPORT_BYTES) {
        setFigmaImportStatus(
          `Import failed · JSON must be between 1 byte and ${MAX_FIGMA_REST_IMPORT_BYTES / (1024 * 1024)} MB`,
        );
        return;
      }
      try {
        setFigmaImportStatus("Reading Figma JSON");
        const source = JSON.parse(await file.text()) as unknown;
        const plan = planFigmaRestImport(source, {
          allocateNodeId: () => createId(),
          allocatePageId: () => createId(),
        });
        const report = figmaRestImportReport(plan);
        setFigmaImportReport(report);
        if (!plan.pages.length) {
          setFigmaImportStatus(
            "Import failed · no valid Figma Pages were found · report ready",
          );
          return;
        }
        const transactionId = createId();
        pendingFigmaImportRef.current = {
          transactionId,
          report,
          assetRequests: plan.assetRequests.filter(
            (request) => request.usage === "fill" || request.usage === "node",
          ),
        };
        post({
          type: "import-figma-rest-plan",
          transactionId,
          baseRevision: revisionRef.current,
          plan,
        });
        setFigmaImportStatus(
          `Importing ${report.summary.pageCount} page${report.summary.pageCount === 1 ? "" : "s"} · ${report.summary.nodeCount} layer${report.summary.nodeCount === 1 ? "" : "s"}`,
        );
      } catch {
        setFigmaImportStatus("Import failed · invalid JSON");
      }
    },
    [canEdit, post],
  );
  const downloadFigmaImportReport = useCallback(() => {
    if (!figmaImportReport) return;
    downloadBlob(
      new Blob([JSON.stringify(figmaImportReport, null, 2)], {
        type: "application/json;charset=utf-8",
      }),
      "makefigma-figma-import-report.json",
    );
  }, [figmaImportReport]);
  const openFigmaAssetPicker = useCallback(() => {
    const input = figmaAssetInputRef.current;
    if (!input) return;
    try {
      input.showPicker();
    } catch {
      input.click();
    }
  }, []);
  const bindLocalFigmaImage = useCallback(
    async (file: File) => {
      const request = pendingFigmaAssetRequests[0];
      if (!canEdit || !request || figmaAssetBinding) return;
      setFigmaAssetBinding(true);
      let decodedRaster: DecodedRaster | undefined;
      try {
        setFigmaImportStatus("Checking Figma image");
        const bytes = new Uint8Array(await file.arrayBuffer());
        const probe = await probeAssetInWorker(
          "raster-image",
          file.type,
          bytes,
        );
        if (!probe.admission.accepted)
          throw new Error(`ASSET_REJECTED_${probe.admission.reason}`);
        if (!probe.rasterDimensions)
          throw new Error("ASSET_REJECTED_CORRUPT_DATA");
        decodedRaster = await decodeRasterInWorker(
          probe.admission.mime,
          bytes,
          probe.rasterDimensions,
        );
        const assetDocumentId = documentId ?? snapshotRef.current.documentId;
        const transport = new AssetApiTransport({
          baseUrl: assetApiUrl,
          tenantId: localDevTenantId,
          actorId: localDevActorId,
        });
        setFigmaImportStatus("Uploading Figma image");
        const uploaded = await transport.upload({
          sessionId: createId(),
          kind: "raster-image",
          mediaType: probe.admission.mime,
          bytes,
        });
        await transport.grantDocumentWriter(assetDocumentId);
        await transport.attachToDocument(assetDocumentId, uploaded.assetId);
        const asset: DocumentAsset = {
          assetId: uploaded.assetId,
          contentHash: uploaded.contentHash,
          mediaType: uploaded.mediaType,
          byteLength: uploaded.byteLength,
          pixelWidth: probe.rasterDimensions.width,
          pixelHeight: probe.rasterDimensions.height,
        };
        exportImageBytesRef.current.set(asset.assetId, bytes.slice().buffer);
        if (decodedRaster) {
          post(
            {
              type: "asset-bytes",
              assetId: asset.assetId,
              mediaType: asset.mediaType,
              bytes: bytes.buffer,
              decodedBitmap: decodedRaster.bitmap,
            },
            [bytes.buffer, decodedRaster.bitmap],
          );
          decodedRaster = undefined;
        } else
          post(
            {
              type: "asset-bytes",
              assetId: asset.assetId,
              mediaType: asset.mediaType,
              bytes: bytes.buffer,
            },
            [bytes.buffer],
          );
        const transactionId = createId();
        pendingFigmaAssetBindingRef.current = { transactionId, request };
        post({
          type: "bind-figma-rest-assets",
          transactionId,
          baseRevision: revisionRef.current,
          authorized: [{ request, asset }],
        });
        setFigmaImportStatus("Binding Figma image to its layer");
      } catch (reason) {
        const code =
          reason instanceof Error
            ? reason.message.replace(/^ASSET_REJECTED_/, "")
            : "UPLOAD_FAILED";
        setFigmaAssetBinding(false);
        setFigmaImportStatus(importFailureMessage(code));
      } finally {
        decodedRaster?.bitmap.close();
      }
    },
    [canEdit, documentId, figmaAssetBinding, pendingFigmaAssetRequests, post],
  );
  const selectPage = useCallback(
    (id: string) => {
      // A page switch cannot preserve a DOM host that is no longer on the active
      // canvas. Discard its uncommitted presentation draft rather than allowing
      // a stale selection to be committed into another page.
      canvasTextCommitRef.current = true;
      canvasTextIsComposingRef.current = false;
      pendingCanvasCaretLayoutsRef.current.clear();
      needsCanvasTextCaretRecoveryRef.current = false;
      setCanvasTextEdit(undefined);
      command({ type: "select-page", id });
    },
    [command],
  );
  const createPage = useCallback(
    () =>
      command({
        type: "create-page",
        id: createId(),
        name: `Page ${snapshot.pages.length + 1}`,
      }),
    [command, snapshot.pages.length],
  );
  const exportAssetDataUris = useCallback(
    async (current: EditorSnapshot, nodes: readonly CanvasNode[]) => {
      const images = new Map<string, string>();
      const fonts = new Map<string, string>();
      const fontBytes = new Map<string, ArrayBuffer>();
      const assets = new Map(
        (current.assets ?? []).map((asset) => [asset.assetId, asset]),
      );
      const requested = [
        ...new Set(
          nodes.flatMap((node) => [
            ...(node.assetId ? [node.assetId] : []),
            ...(node.textProperties?.runs.flatMap((run) =>
              run.font ? [run.font.assetId] : [],
            ) ?? []),
            ...(node.textProperties?.fallbackFonts?.map(
              (font) => font.assetId,
            ) ?? []),
          ]),
        ),
      ];
      const transport = new AssetApiTransport({
        baseUrl: assetApiUrl,
        tenantId: localDevTenantId,
        actorId: localDevActorId,
      });
      for (const assetId of requested) {
        const asset = assets.get(assetId);
        const isImage = Boolean(
          asset &&
          SVG_EMBEDDABLE_RASTER_MEDIA_TYPES.has(asset.mediaType) &&
          asset.byteLength <= MAX_SVG_EMBEDDED_IMAGE_BYTES,
        );
        const isFont = Boolean(
          asset &&
          SVG_EMBEDDABLE_FONT_MEDIA_TYPES.has(asset.mediaType) &&
          asset.byteLength <= MAX_SVG_EMBEDDED_FONT_BYTES,
        );
        if (!asset || (!isImage && !isFont)) continue;
        let bytes = exportImageBytesRef.current.get(assetId);
        // Fixed fixtures deliberately include one missing-image case. Its
        // fallback is evidence, not a reason to issue a failing network request
        // during every deterministic export; normal documents still obtain a
        // fresh document-scoped grant when the byte cache is cold.
        if (!bytes && current.documentId && !fixtureSnapshot) {
          try {
            const downloaded = await transport.download(
              current.documentId,
              assetId,
            );
            if (downloaded.byteLength !== asset.byteLength) continue;
            bytes = downloaded;
            exportImageBytesRef.current.set(assetId, downloaded.slice(0));
          } catch {
            continue;
          }
        }
        if (!bytes || bytes.byteLength !== asset.byteLength) continue;
        if (isImage) {
          const uri = imageDataUri(asset.mediaType, bytes);
          if (uri) images.set(assetId, uri);
        }
        if (isFont) {
          const uri = fontDataUri(asset.mediaType, bytes);
          if (uri) {
            fonts.set(assetId, uri);
            fontBytes.set(assetId, bytes.slice(0));
          }
        }
      }
      return { images, fonts, fontBytes };
    },
    [fixtureSnapshot],
  );
  const exportActivePageAsSvg = useCallback(async () => {
    const current = snapshotRef.current;
    const nodes = structuredClone(current.nodes);
    const [booleanPaths, vectorPaths, parametricShapePaths, assets] =
      await Promise.all([
        deriveBooleanSvgPaths(nodes).catch(
          () => new Map<string, DocumentVectorPath>(),
        ),
        deriveVectorSvgPaths(nodes).catch(
          () => new Map<string, DocumentVectorPath>(),
        ),
        deriveParametricSvgPaths(nodes).catch(
          () => new Map<string, readonly { x: number; y: number }[]>(),
        ),
        exportAssetDataUris(current, nodes),
      ]);
    const textLayouts = await deriveTextSvgLayouts(
      nodes,
      assets.fontBytes,
    ).catch(() => new Map<string, SvgTextLayoutProjection>());
    const selectedSlices = current.selectedIds
      .map((id) => nodes.find((node) => node.id === id))
      .filter((node): node is CanvasNode =>
        Boolean(
          node &&
          node.kind === "slice" &&
          (node.pageId ?? defaultPageId) === current.activePageId,
        ),
      );
    const slicesOnly =
      selectedSlices.length > 0 &&
      selectedSlices.length === current.selectedIds.length;
    const selectedLayers = current.selectedIds
      .map((id) => nodes.find((node) => node.id === id))
      .filter((node): node is CanvasNode =>
        Boolean(
          node &&
          node.kind !== "slice" &&
          (node.pageId ?? defaultPageId) === current.activePageId,
        ),
      );
    const layersOnly =
      selectedLayers.length > 0 &&
      selectedLayers.length === current.selectedIds.length;
    if (slicesOnly) {
      const results = selectedSlices.map((slice) => ({
        slice,
        result: exportPageToSvg(nodes, {
          pageId: current.activePageId,
          defaultPageId,
          sourceRevision: current.revision,
          booleanPaths,
          vectorPaths,
          parametricShapePaths,
          imageDataUris: assets.images,
          fontDataUris: assets.fonts,
          textLayouts,
          sliceId: slice.id,
        }),
      }));
      for (const { slice, result } of results) {
        const stem = svgFileStem(slice.name);
        downloadBlob(
          new Blob([result.svg], { type: "image/svg+xml;charset=utf-8" }),
          `${stem}.svg`,
        );
        downloadCompatibilityReport(stem, result, {
          target: { pageId: current.activePageId, sliceId: slice.id },
          formatRequested: "svg",
        });
      }
      const warningCount = results.reduce(
        (total, entry) => total + entry.result.warnings.length,
        0,
      );
      setStatus(
        warningCount
          ? `${results.length} Slice SVG exports · ${warningCount} compatibility fallback${warningCount === 1 ? "" : "s"}`
          : `${results.length} Slice SVG export${results.length === 1 ? "" : "s"}`,
      );
      return;
    }
    const result = exportPageToSvg(nodes, {
      pageId: current.activePageId,
      defaultPageId,
      sourceRevision: current.revision,
      booleanPaths,
      vectorPaths,
      parametricShapePaths,
      imageDataUris: assets.images,
      fontDataUris: assets.fonts,
      textLayouts,
      ...(layersOnly ? { nodeIds: selectedLayers.map((node) => node.id) } : {}),
    });
    const page = current.pages.find(
      (candidate) => candidate.id === current.activePageId,
    );
    const stem = svgFileStem(
      layersOnly
        ? selectedLayers.length === 1
          ? selectedLayers[0].name
          : "selection"
        : (page?.name ?? "page"),
    );
    downloadBlob(
      new Blob([result.svg], { type: "image/svg+xml;charset=utf-8" }),
      `${stem}.svg`,
    );
    downloadCompatibilityReport(stem, result, {
      target: {
        pageId: current.activePageId,
        ...(layersOnly
          ? { nodeIds: selectedLayers.map((node) => node.id) }
          : {}),
      },
      formatRequested: "svg",
    });
    const targetLabel = layersOnly
      ? `${selectedLayers.length} selected layer${selectedLayers.length === 1 ? "" : "s"}`
      : "Page";
    setStatus(
      result.warnings.length
        ? `${targetLabel} SVG export · ${result.warnings.length} compatibility fallback${result.warnings.length === 1 ? "" : "s"}`
        : `${targetLabel} SVG exported`,
    );
  }, [exportAssetDataUris]);
  const exportSelectedSliceRaster = useCallback(
    async (format: "png" | "pdf") => {
      const current = snapshotRef.current;
      const selectedSlices = current.selectedIds
        .map((id) => current.nodes.find((node) => node.id === id))
        .filter((node): node is CanvasNode =>
          Boolean(
            node &&
            node.kind === "slice" &&
            (node.pageId ?? defaultPageId) === current.activePageId,
          ),
        );
      const slicesOnly =
        selectedSlices.length > 0 &&
        selectedSlices.length === current.selectedIds.length;
      const selectedLayers = current.selectedIds
        .map((id) => current.nodes.find((node) => node.id === id))
        .filter((node): node is CanvasNode =>
          Boolean(
            node &&
            node.kind !== "slice" &&
            (node.pageId ?? defaultPageId) === current.activePageId,
          ),
        );
      const layersOnly =
        selectedLayers.length > 0 &&
        selectedLayers.length === current.selectedIds.length;
      const nodes = structuredClone(current.nodes);
      const [booleanPaths, vectorPaths, parametricShapePaths, assets] =
        await Promise.all([
          deriveBooleanSvgPaths(nodes).catch(
            () => new Map<string, DocumentVectorPath>(),
          ),
          deriveVectorSvgPaths(nodes).catch(
            () => new Map<string, DocumentVectorPath>(),
          ),
          deriveParametricSvgPaths(nodes).catch(
            () => new Map<string, readonly { x: number; y: number }[]>(),
          ),
          exportAssetDataUris(current, nodes),
        ]);
      const textLayouts = await deriveTextSvgLayouts(
        nodes,
        assets.fontBytes,
      ).catch(() => new Map<string, SvgTextLayoutProjection>());
      const activePage = current.pages.find(
        (page) => page.id === current.activePageId,
      );
      const exports = slicesOnly
        ? selectedSlices.map((slice) => ({
            name: slice.name,
            targetId: slice.id,
            target: {
              pageId: current.activePageId,
              sliceId: slice.id,
            } satisfies ExportTarget,
            result: exportPageToSvg(nodes, {
              pageId: current.activePageId,
              defaultPageId,
              sourceRevision: current.revision,
              booleanPaths,
              vectorPaths,
              parametricShapePaths,
              imageDataUris: assets.images,
              fontDataUris: assets.fonts,
              textLayouts,
              sliceId: slice.id,
            }),
          }))
        : layersOnly
          ? [
              {
                name:
                  selectedLayers.length === 1
                    ? selectedLayers[0].name
                    : "selection",
                targetId:
                  selectedLayers.length === 1
                    ? selectedLayers[0].id
                    : current.activePageId,
                target: {
                  pageId: current.activePageId,
                  nodeIds: selectedLayers.map((node) => node.id),
                } satisfies ExportTarget,
                result: exportPageToSvg(nodes, {
                  pageId: current.activePageId,
                  defaultPageId,
                  sourceRevision: current.revision,
                  booleanPaths,
                  vectorPaths,
                  parametricShapePaths,
                  imageDataUris: assets.images,
                  fontDataUris: assets.fonts,
                  textLayouts,
                  nodeIds: selectedLayers.map((node) => node.id),
                }),
              },
            ]
          : [
              {
                name: activePage?.name ?? "page",
                targetId: current.activePageId,
                target: { pageId: current.activePageId } satisfies ExportTarget,
                result: exportPageToSvg(nodes, {
                  pageId: current.activePageId,
                  defaultPageId,
                  sourceRevision: current.revision,
                  booleanPaths,
                  vectorPaths,
                  parametricShapePaths,
                  imageDataUris: assets.images,
                  fontDataUris: assets.fonts,
                  textLayouts,
                }),
              },
            ];
      const targetLabel = slicesOnly
        ? "Slice"
        : layersOnly
          ? "Selection"
          : "Page";
      const admission = admitSliceRasterBatch(
        exports.map(({ result }) => ({
          width: result.width,
          height: result.height,
          scale: sliceExportScale,
        })),
      );
      if (!admission.accepted) {
        setStatus(
          admission.reason === "RESOURCE_LIMIT"
            ? `${targetLabel} export exceeds the 32 target / 64 MP / 256 MB raster budget`
            : `${targetLabel} export has invalid bounds`,
        );
        return;
      }
      try {
        if (format === "png") {
          for (const { name, target, result } of exports) {
            const stem = svgFileStem(name);
            const artifactStem = `${stem}${sliceExportScale === 1 ? "" : `@${sliceExportScale}x`}`;
            downloadBlob(
              await rasterizeSvgToPng(
                result.svg,
                result.width,
                result.height,
                sliceExportScale,
                sliceExportBackground,
              ),
              `${artifactStem}.png`,
            );
            downloadCompatibilityReport(artifactStem, result, {
              target,
              formatRequested: "png",
              background: sliceExportBackground,
            });
          }
        } else {
          const pages = [] as Array<
            Awaited<ReturnType<typeof rasterizeSvgToPdfPage>>
          >;
          for (const { result } of exports) {
            pages.push(
              await rasterizeSvgToPdfPage(
                result.svg,
                result.width,
                result.height,
                sliceExportScale,
                pdfExportBackground,
              ),
            );
          }
          downloadBlob(
            await pdfFromRgbaPages(pages),
            `${exports.length === 1 ? svgFileStem(exports[0].name) : "makefigma-slices"}.pdf`,
          );
          const pdfResults = exports.map(
            ({ name, targetId, target, result }) => ({
              id: targetId,
              name,
              target,
              result: withPdfRasterizationFallback(
                result,
                targetId,
                pdfExportBackground,
              ),
            }),
          );
          if (pdfResults.length === 1) {
            const [entry] = pdfResults;
            downloadCompatibilityReport(svgFileStem(entry.name), entry.result, {
              target: entry.target,
              formatRequested: "pdf",
              background: pdfExportBackground,
            });
          } else {
            // One multi-page PDF is one delivery artifact. Its sidecar must keep
            // each Slice target, in artifact-page order, rather than creating a
            // misleading collection of independent single-page reports.
            downloadCompatibilityReportSet(
              "makefigma-slices",
              pdfResults,
              pdfExportBackground,
            );
          }
        }
        const label = format.toUpperCase();
        const warningCount =
          exports.reduce(
            (total, entry) => total + entry.result.warnings.length,
            0,
          ) + (format === "pdf" ? exports.length : 0);
        setStatus(
          warningCount
            ? `${exports.length} ${targetLabel} ${label} export${exports.length === 1 ? "" : "s"} · ${warningCount} compatibility fallback${warningCount === 1 ? "" : "s"}`
            : `${exports.length} ${targetLabel} ${label} export${exports.length === 1 ? "" : "s"}`,
        );
      } catch (error) {
        const code =
          error instanceof SliceExportError
            ? error.code
            : "RASTERIZATION_FAILED";
        setStatus(
          code === "RESOURCE_LIMIT"
            ? `${targetLabel} export exceeds the 64 MP / 256 MB raster budget`
            : `${targetLabel} ${format.toUpperCase()} export failed · ${code.toLowerCase().replaceAll("_", " ")}`,
        );
      }
    },
    [
      exportAssetDataUris,
      pdfExportBackground,
      sliceExportBackground,
      sliceExportScale,
    ],
  );
  const exportAllPagesAsPdf = useCallback(async () => {
    const current = snapshotRef.current;
    const orderedPages = pagesInCanonicalExportOrder(current.pages);
    if (!orderedPages.length) {
      setStatus("No Pages are available for PDF export");
      return;
    }
    const nodes = structuredClone(current.nodes);
    const [booleanPaths, vectorPaths, parametricShapePaths, assets] =
      await Promise.all([
        deriveBooleanSvgPaths(nodes).catch(
          () => new Map<string, DocumentVectorPath>(),
        ),
        deriveVectorSvgPaths(nodes).catch(
          () => new Map<string, DocumentVectorPath>(),
        ),
        deriveParametricSvgPaths(nodes).catch(
          () => new Map<string, readonly { x: number; y: number }[]>(),
        ),
        exportAssetDataUris(current, nodes),
      ]);
    const textLayouts = await deriveTextSvgLayouts(
      nodes,
      assets.fontBytes,
    ).catch(() => new Map<string, SvgTextLayoutProjection>());
    const exports = orderedPages.map((page) => ({
      page,
      result: exportPageToSvg(nodes, {
        pageId: page.id,
        defaultPageId,
        sourceRevision: current.revision,
        booleanPaths,
        vectorPaths,
        parametricShapePaths,
        imageDataUris: assets.images,
        fontDataUris: assets.fonts,
        textLayouts,
      }),
    }));
    const admission = admitSliceRasterBatch(
      exports.map(({ result }) => ({
        width: result.width,
        height: result.height,
        scale: sliceExportScale,
      })),
    );
    if (!admission.accepted) {
      setStatus(
        admission.reason === "RESOURCE_LIMIT"
          ? "All Pages PDF exceeds the 32 page / 64 MP / 256 MB raster budget"
          : "All Pages PDF has invalid bounds",
      );
      return;
    }
    try {
      const pdfPages = [] as Array<
        Awaited<ReturnType<typeof rasterizeSvgToPdfPage>>
      >;
      for (const { result } of exports) {
        pdfPages.push(
          await rasterizeSvgToPdfPage(
            result.svg,
            result.width,
            result.height,
            sliceExportScale,
            pdfExportBackground,
          ),
        );
      }
      downloadBlob(await pdfFromRgbaPages(pdfPages), "makefigma-pages.pdf");
      downloadCompatibilityReportSet(
        "makefigma-pages",
        exports.map(({ page, result }) => ({
          id: page.id,
          name: page.name,
          target: { pageId: page.id },
          result: withPdfRasterizationFallback(
            result,
            page.id,
            pdfExportBackground,
          ),
        })),
        pdfExportBackground,
      );
      const warningCount =
        exports.reduce(
          (total, entry) => total + entry.result.warnings.length,
          0,
        ) + exports.length;
      setStatus(
        `${exports.length} Page PDF export${exports.length === 1 ? "" : "s"} · ${warningCount} compatibility fallback${warningCount === 1 ? "" : "s"}`,
      );
    } catch (error) {
      const code =
        error instanceof SliceExportError ? error.code : "RASTERIZATION_FAILED";
      setStatus(
        code === "RESOURCE_LIMIT"
          ? "All Pages PDF exceeds the 64 MP / 256 MB raster budget"
          : `All Pages PDF export failed · ${code.toLowerCase().replaceAll("_", " ")}`,
      );
    }
  }, [exportAssetDataUris, pdfExportBackground, sliceExportScale]);
  const importAsset = useCallback(
    async (file: File) => {
      if (!canEdit) return;
      // Fixture hydration may briefly expose its internal placeholder ID in the
      // rendered snapshot. Resource authorization must always use the document
      // this shell was opened for, otherwise a later cross-document paste cannot
      // prove that the source document attached the asset.
      const assetDocumentId = documentId ?? snapshotRef.current.documentId;
      assetUploadAbortRef.current?.abort();
      const controller = new AbortController();
      assetUploadAbortRef.current = controller;
      setAssetImporting(true);
      const kind =
        file.type.startsWith("font/") ||
        /\.(?:woff2?|ttf|otf)$/i.test(file.name)
          ? "font"
          : ("raster-image" as const);
      let decodedRaster: DecodedRaster | undefined;
      try {
        setAssetStatus("Checking file");
        await waitForStabilityAssetReadDelay(controller.signal);
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (controller.signal.aborted)
          throw new DOMException(
            "The asset import was cancelled.",
            "AbortError",
          );
        const probe = await probeAssetInWorker(kind, file.type, bytes, {
          signal: controller.signal,
        });
        if (controller.signal.aborted)
          throw new DOMException(
            "The asset import was cancelled.",
            "AbortError",
          );
        if (!probe.admission.accepted)
          throw new Error(`ASSET_REJECTED_${probe.admission.reason}`);
        if (kind === "raster-image") {
          if (!probe.rasterDimensions)
            throw new Error("ASSET_REJECTED_CORRUPT_DATA");
          setAssetStatus("Decoding image");
          decodedRaster = await decodeRasterInWorker(
            probe.admission.mime,
            bytes,
            probe.rasterDimensions,
            { signal: controller.signal },
          );
        }
        const transport = new AssetApiTransport({
          baseUrl: assetApiUrl,
          tenantId: localDevTenantId,
          actorId: localDevActorId,
        });
        setAssetStatus("Uploading asset");
        const uploaded = await transport.upload({
          sessionId: createId(),
          kind,
          mediaType: probe.admission.mime,
          bytes,
          signal: controller.signal,
        });
        if (controller.signal.aborted)
          throw new DOMException(
            "The asset import was cancelled.",
            "AbortError",
          );
        await transport.grantDocumentWriter(assetDocumentId);
        await transport.attachToDocument(assetDocumentId, uploaded.assetId);
        if (
          snapshot.assets?.some(
            (asset) =>
              asset.assetId.replaceAll("-", "") ===
              uploaded.assetId.replaceAll("-", ""),
          )
        ) {
          const existing = snapshot.assets.find(
            (asset) =>
              asset.assetId.replaceAll("-", "") ===
              uploaded.assetId.replaceAll("-", ""),
          );
          if (
            kind === "font" &&
            (!existing ||
              !(await ensureMainFontFace(assetDocumentId, existing)))
          )
            throw new Error("FONT_LOAD_FAILED");
          setAssetStatus(
            `${kind === "font" ? "Font" : "Image"} already available`,
          );
          setStatus("Engine worker online · resource already registered");
          if (kind === "raster-image") {
            const placement = {
              assetId: uploaded.assetId,
              width: decodedRaster?.metadata.decoded.width,
              height: decodedRaster?.metadata.decoded.height,
            };
            const target = imageFillTarget(
              snapshotRef.current.nodes,
              snapshotRef.current.selectedIds,
            );
            transactionQueueRef.current?.enqueue([
              target
                ? {
                    type: "update",
                    id: target.id,
                    patch: { assetId: placement.assetId },
                  }
                : {
                    type: "create",
                    node: importedImageNode(
                      placement,
                      snapshotRef.current.viewport,
                    ),
                  },
            ]);
            setAssetStatus(target ? "Image applied as fill" : "Image added");
          }
          decodedRaster?.bitmap.close();
          decodedRaster = undefined;
          return;
        }
        if (kind === "raster-image")
          pendingImagePlacementRef.current = {
            assetId: uploaded.assetId,
            width: decodedRaster?.metadata.decoded.width,
            height: decodedRaster?.metadata.decoded.height,
            targetId: imageFillTarget(snapshot.nodes, snapshot.selectedIds)?.id,
          };
        const asset: DocumentAsset = {
          assetId: uploaded.assetId,
          contentHash: uploaded.contentHash,
          mediaType: uploaded.mediaType,
          byteLength: uploaded.byteLength,
          ...(probe.rasterDimensions
            ? {
                pixelWidth: probe.rasterDimensions.width,
                pixelHeight: probe.rasterDimensions.height,
              }
            : {}),
        };
        if (kind === "raster-image")
          exportImageBytesRef.current.set(
            uploaded.assetId,
            bytes.slice().buffer,
          );
        if (kind === "font") {
          setAssetStatus("Loading font");
          const mainBytes = new Uint8Array(bytes).buffer;
          if (!(await ensureMainFontFace(assetDocumentId, asset, mainBytes)))
            throw new Error("FONT_LOAD_FAILED");
          exportImageBytesRef.current.set(uploaded.assetId, mainBytes.slice(0));
        }
        post({ type: "register-asset", transactionId: createId(), asset });
        if (decodedRaster) {
          post(
            {
              type: "asset-bytes",
              assetId: uploaded.assetId,
              mediaType: uploaded.mediaType,
              bytes: bytes.buffer,
              decodedBitmap: decodedRaster.bitmap,
            },
            [bytes.buffer, decodedRaster.bitmap],
          );
          decodedRaster = undefined;
        } else {
          post(
            {
              type: "asset-bytes",
              assetId: uploaded.assetId,
              mediaType: uploaded.mediaType,
              bytes: bytes.buffer,
            },
            [bytes.buffer],
          );
        }
        setAssetStatus(`${kind === "font" ? "Font" : "Image"} added`);
        setStatus("Engine worker online · resource registration queued");
      } catch (reason) {
        if (reason instanceof DOMException && reason.name === "AbortError") {
          setAssetStatus("Import canceled");
          setStatus("Engine worker online · resource import canceled");
          return;
        }
        const code =
          reason instanceof Error
            ? reason.message.replace(/^ASSET_REJECTED_/, "")
            : "UPLOAD_FAILED";
        setAssetStatus(importFailureMessage(code));
      } finally {
        decodedRaster?.bitmap.close();
        if (assetUploadAbortRef.current === controller)
          assetUploadAbortRef.current = null;
        setAssetImporting(false);
      }
    },
    [
      canEdit,
      documentId,
      ensureMainFontFace,
      post,
      snapshot.assets,
      snapshot.nodes,
      snapshot.selectedIds,
    ],
  );
  const setAccessMode = (next: "edit" | "view") => {
    if (next === accessPreference) return;
    if (next === "view") {
      writerRef.current = false;
      transactionQueueRef.current?.reset();
      optimisticUpdatesRef.current.clear();
      writerLeaseRef.current?.stop();
      writerLeaseRef.current = null;
      setWriterMode("read-only");
      setStatus("Engine worker online · view-only mode");
    } else {
      editIntentRef.current = { at: Date.now(), id: createId() };
      setWriterMode("acquiring");
      setStatus("Engine worker online · requesting edit handoff");
    }
    setAccessPreference(next);
  };

  return (
    <main className="grid h-svh min-h-[580px] grid-cols-[52px_248px_minmax(420px,1fr)_288px] grid-rows-[52px_minmax(0,1fr)] bg-background text-foreground">
      <header className="col-span-full flex min-w-0 items-center gap-3 overflow-x-auto border-b bg-background px-3">
        {workspaceHref ? (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => window.location.assign(workspaceHref)}
            aria-label="返回工作区"
          >
            <ArrowLeft />
            返回工作区
          </Button>
        ) : (
          <div className="flex min-w-48 items-center gap-2 text-xs font-semibold tracking-wide">
            <span className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground">
              M
            </span>
            <span>MAKE / FIGMA</span>
            <Badge variant="secondary">alpha</Badge>
          </div>
        )}
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <span className="size-2 shrink-0 rounded-full bg-emerald-500" />
          {renameMode ? (
            <Input
              className="h-7 w-56"
              aria-label="文档名称"
              autoFocus
              maxLength={100}
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              onBlur={commitDocumentName}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitDocumentName();
                if (event.key === "Escape") {
                  setNameDraft(documentName);
                  setRenameMode(false);
                }
              }}
            />
          ) : (
            <Button
              className="max-w-56 justify-start truncate"
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => {
                if (onRenameDocument) {
                  setNameDraft(documentName);
                  setRenameMode(true);
                }
              }}
              title={onRenameDocument ? "重命名文档" : undefined}
            >
              {documentName}
            </Button>
          )}
          <span className="hidden text-xs text-muted-foreground xl:inline">
            已保存在本地
          </span>
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-1 overflow-x-auto py-2">
          <div
            className="flex shrink-0 items-center gap-0.5 rounded-lg border p-0.5"
            role="group"
            aria-label="Document access mode"
          >
            <Button
              variant={accessPreference === "view" ? "secondary" : "ghost"}
              size="xs"
              type="button"
              aria-pressed={accessPreference === "view"}
              onClick={() => setAccessMode("view")}
            >
              只读
            </Button>
            <Button
              variant={accessPreference === "edit" ? "secondary" : "ghost"}
              size="xs"
              type="button"
              aria-pressed={accessPreference === "edit"}
              onClick={() => setAccessMode("edit")}
              disabled={safeMode}
            >
              编辑
            </Button>
            <Badge
              className={cn("ml-1", canEdit && "text-emerald-700")}
              variant="outline"
              aria-live="polite"
            >
              {accessLabel}
            </Badge>
          </div>
          <span
            className="engine-status hidden max-w-52 shrink truncate text-xs text-muted-foreground 2xl:inline"
            data-fixture-reset-pending={fixtureResetting ? "true" : "false"}
            data-fixture-reset-generation={fixtureResetGeneration}
          >
            {snapshot.renderer} ·{" "}
            {snapshot.gpu?.webgpu === "ready"
              ? snapshot.resources?.gpuSceneWithinBudget === false
                ? "GPU scene resource fallback"
                : snapshot.gpu.recoveryAttempts
                  ? `WebGPU scene recovered (${snapshot.gpu.recoveryAttempts})`
                  : "WebGPU scene active"
              : snapshot.gpu?.webgpu === "recovering"
                ? "recovering WebGPU scene"
                : snapshot.gpu?.webgpu === "unavailable"
                  ? snapshot.gpu.recoveryAttempts
                    ? `WebGPU recovery exhausted · ${snapshot.gpu.webgl2Available ? "WebGL2 available" : "GPU fallback"}`
                    : snapshot.gpu.webgl2Available
                      ? "WebGL2 available"
                      : "GPU fallback"
                  : "checking GPU"}
            {snapshot.gpu?.developmentSimulation
              ? ` · device-loss simulation ${snapshot.gpu.developmentSimulation.completedLosses}/${snapshot.gpu.developmentSimulation.requestedLosses}`
              : ""}{" "}
            · {snapshot.documentCore} ·{" "}
            {writerMode === "owner"
              ? "local writer"
              : writerMode === "read-only"
                ? "read-only tab"
                : "acquiring writer lock"}{" "}
            · {status}
            {storageNotice ? ` · ${storageNotice}` : ""}
          </span>
          <input
            ref={assetInputRef}
            className="sr-only"
            type="file"
            accept="image/png,image/jpeg,image/webp,font/woff2,font/woff,font/ttf,font/otf,.woff2,.woff,.ttf,.otf"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.currentTarget.value = "";
              if (file) void importAsset(file);
            }}
          />
          <Button
            variant="ghost"
            size="xs"
            data-action="asset-import"
            disabled={!canEdit}
            title={assetStatus ?? "Import image or font"}
            onClick={() =>
              assetImporting
                ? assetUploadAbortRef.current?.abort()
                : openAssetPicker()
            }
          >
            {assetImporting ? "Cancel import" : "Import"}
          </Button>
          {assetStatus && (
            <span
              className={cn(
                "max-w-44 truncate text-xs text-muted-foreground",
                assetStatus.startsWith("Import failed") && "text-destructive",
              )}
              role="status"
              aria-live="polite"
            >
              {assetStatus}
            </span>
          )}
          <input
            ref={figmaImportInputRef}
            className="sr-only"
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.currentTarget.value = "";
              if (file) void importFigmaRestJson(file);
            }}
          />
          <Button
            variant="ghost"
            size="xs"
            disabled={!canEdit}
            title={
              figmaImportStatus ?? "Import a downloaded Figma REST JSON file"
            }
            onClick={openFigmaImportPicker}
          >
            Figma JSON
          </Button>
          {figmaImportStatus && (
            <span
              className={cn(
                "max-w-44 truncate text-xs text-muted-foreground",
                figmaImportStatus.startsWith("Import failed") &&
                  "text-destructive",
              )}
              role="status"
              aria-live="polite"
            >
              {figmaImportStatus}
            </span>
          )}
          {figmaImportReport && (
            <Button
              variant="ghost"
              size="xs"
              type="button"
              title="Download Figma import compatibility report"
              onClick={downloadFigmaImportReport}
            >
              Import report
            </Button>
          )}
          <input
            ref={figmaAssetInputRef}
            className="sr-only"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.currentTarget.value = "";
              if (file) void bindLocalFigmaImage(file);
            }}
          />
          {pendingFigmaAssetRequests.length > 0 && (
            <Button
              variant="ghost"
              size="xs"
              disabled={!canEdit || figmaAssetBinding}
              title={`Attach local image for imported Figma layer ${pendingFigmaAssetRequests[0]!.sourceId}`}
              onClick={openFigmaAssetPicker}
            >
              {figmaAssetBinding
                ? "Binding image"
                : `Attach Figma image (${pendingFigmaAssetRequests.length})`}
            </Button>
          )}
          <Button
            variant="ghost"
            size="xs"
            title={
              selectedNodes.length &&
              selectedNodes.every((node) => node.kind === "slice")
                ? "Export selected Slices as SVG"
                : selectedNodes.length &&
                    selectedNodes.every((node) => node.kind !== "slice")
                  ? "Export selected layers as SVG"
                  : "Export active page as SVG"
            }
            onClick={exportActivePageAsSvg}
          >
            {selectedNodes.length &&
            selectedNodes.every((node) => node.kind === "slice")
              ? "Export Slice SVG"
              : selectedNodes.length &&
                  selectedNodes.every((node) => node.kind !== "slice")
                ? "Export Selection SVG"
                : "Export SVG"}
          </Button>
          <>
            <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              <span>Scale</span>
              <select
                className="h-7 rounded-lg border bg-background px-2 text-xs"
                aria-label="Export scale"
                value={sliceExportScale}
                onChange={(event) =>
                  setSliceExportScale(Number(event.target.value))
                }
              >
                <option value={1}>1×</option>
                <option value={2}>2×</option>
                <option value={4}>4×</option>
                <option value={8}>8×</option>
              </select>
            </label>
            <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              <span>PNG</span>
              <select
                className="h-7 rounded-lg border bg-background px-2 text-xs"
                aria-label="PNG background"
                value={
                  sliceExportBackground === "transparent"
                    ? "transparent"
                    : "opaque"
                }
                onChange={(event) =>
                  setSliceExportBackground(
                    event.target.value === "transparent"
                      ? "transparent"
                      : "#ffffff",
                  )
                }
              >
                <option value="transparent">Transparent</option>
                <option value="opaque">Opaque</option>
              </select>
              {sliceExportBackground !== "transparent" && (
                <input
                  className="size-7 rounded-md border"
                  aria-label="PNG matte color"
                  type="color"
                  value={
                    sliceExportBackground === "white"
                      ? "#ffffff"
                      : sliceExportBackground
                  }
                  onChange={(event) =>
                    setSliceExportBackground(
                      event.target.value as SliceExportBackground,
                    )
                  }
                />
              )}
            </label>
            <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              <span>PDF</span>
              <select
                className="h-7 rounded-lg border bg-background px-2 text-xs"
                aria-label="PDF background"
                value={
                  pdfExportBackground === "transparent"
                    ? "transparent"
                    : "opaque"
                }
                onChange={(event) =>
                  setPdfExportBackground(
                    event.target.value === "transparent"
                      ? "transparent"
                      : "#ffffff",
                  )
                }
              >
                <option value="transparent">Transparent</option>
                <option value="opaque">Opaque</option>
              </select>
              {pdfExportBackground !== "transparent" && (
                <input
                  className="size-7 rounded-md border"
                  aria-label="PDF matte color"
                  type="color"
                  value={pdfExportBackground}
                  onChange={(event) =>
                    setPdfExportBackground(
                      event.target.value as PdfExportBackground,
                    )
                  }
                />
              )}
            </label>
          </>
          <Button
            variant="ghost"
            size="xs"
            title={
              selectedNodes.length &&
              selectedNodes.every((node) => node.kind === "slice")
                ? `Export selected Slices as ${sliceExportBackground === "transparent" ? "transparent" : "matte"} PNG`
                : selectedNodes.length &&
                    selectedNodes.every((node) => node.kind !== "slice")
                  ? `Export selected layers as ${sliceExportBackground === "transparent" ? "transparent" : "matte"} PNG`
                  : `Export active page as ${sliceExportBackground === "transparent" ? "transparent" : "matte"} PNG`
            }
            onClick={() => void exportSelectedSliceRaster("png")}
          >
            Export PNG
          </Button>
          <Button
            variant="ghost"
            size="xs"
            title={
              selectedNodes.length &&
              selectedNodes.every((node) => node.kind === "slice")
                ? "Export selected Slices as PDF"
                : selectedNodes.length &&
                    selectedNodes.every((node) => node.kind !== "slice")
                  ? "Export selected layers as PDF"
                  : "Export active page as PDF"
            }
            onClick={() => void exportSelectedSliceRaster("pdf")}
          >
            Export PDF
          </Button>
          <Button
            variant="ghost"
            size="xs"
            title="Export every Page as one PDF in Canonical page order"
            onClick={() => void exportAllPagesAsPdf()}
          >
            All Pages
          </Button>
          <Button
            variant="ghost"
            size="xs"
            disabled={!canEdit}
            onClick={() => command({ type: "reset" })}
          >
            Reset
          </Button>
          <Button size="xs">
            <Share2 />
            Share
          </Button>
        </div>
      </header>

      <aside
        className="flex min-h-0 flex-col items-center gap-1 border-r bg-background p-2"
        aria-label="Canvas tools"
      >
        {tools.map((item) => (
          <IconButton
            className="relative"
            key={item.id}
            label={`${item.label} (${item.key})${item.id !== "select" && item.id !== "hand" ? " · Enter creates at centre" : ""}`}
            active={tool === item.id}
            disabled={
              safeMode ||
              (!canEdit && item.id !== "select" && item.id !== "hand")
            }
            onClick={() => setActiveTool(item.id)}
          >
            <span>{item.glyph}</span>
            {item.key && (
              <span className="absolute right-1 bottom-0.5 text-[8px] opacity-60">
                {item.key}
              </span>
            )}
          </IconButton>
        ))}
        <div className="flex-1" />
        <IconButton
          label="Zoom in"
          disabled={safeMode}
          onClick={() => {
            const input: EditorInputEvent = {
              type: "wheel",
              x: window.innerWidth / 2,
              y: window.innerHeight / 2,
              deltaX: 0,
              deltaY: -100,
              ctrlKey: true,
              occurredAt: Date.now(),
            };
            const batcher = inputBatcherRef.current;
            if (batcher) batcher.flushWith(input);
            else postInput([input]);
          }}
        >
          +
        </IconButton>
      </aside>

      <LayerPanel
        nodes={activePageNodes}
        pages={orderedPages}
        activePageId={snapshot.activePageId}
        selectedIds={snapshot.selectedIds}
        canEdit={canEdit}
        loading={initialDocumentLoading}
        onSelect={selectLayer}
        onDrop={dropLayer}
        onNest={nestLayer}
        onRename={renameLayer}
        onReorder={reorderSelectedLayers}
        onSelectPage={selectPage}
        onCreatePage={createPage}
        onCreateFrame={createFrame}
        onCreateRectangle={createRectangle}
        onCreateText={createText}
      />

      <section
        className="relative min-h-0 min-w-0 overflow-hidden bg-muted/40"
        aria-label="Design canvas"
      >
        <canvas
          key={`editor-canvas-${canvasGeneration}`}
          ref={canvasRef}
          className="design-canvas size-full touch-none select-none"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            pointer(event, "down");
          }}
          onPointerMove={(event) => pointer(event, "move")}
          onPointerLeave={(event) => pointer(event, "leave")}
          onPointerUp={(event) => {
            pointer(event, "up");
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={(event) => {
            pointer(event, "up");
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onDoubleClick={(event) => {
            drillDownAtCanvasPoint(event);
            void startCanvasTextEdit(event);
          }}
        />
        {initialDocumentLoading && (
          <div
            className="absolute inset-0 z-20 grid place-items-center bg-background/92 text-sm text-muted-foreground"
            role="status"
            aria-live="polite"
            aria-busy="true"
          >
            <div className="flex min-w-56 flex-col items-center gap-3 rounded-xl border bg-background/95 px-6 py-5 shadow-sm">
              <span
                className="size-6 animate-spin rounded-full border-2 border-muted border-t-foreground/70"
                aria-hidden="true"
              />
              <span>{documentLoadingState.label}</span>
              {documentLoadingState.total !== undefined &&
                documentLoadingState.total > 0 && (
                  <div
                    className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                    aria-hidden="true"
                  >
                    <div
                      className="h-full rounded-full bg-primary transition-[width] duration-150"
                      style={{
                        width: `${Math.min(
                          100,
                          ((documentLoadingState.completed ?? 0) /
                            documentLoadingState.total) *
                            100,
                        )}%`,
                      }}
                    />
                  </div>
                )}
            </div>
          </div>
        )}
        {documentHydrated &&
          firstFrameReady &&
          frameQuality === "preview" && (
            <div
              className="pointer-events-none absolute top-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-background/90 px-3 py-1.5 text-xs text-muted-foreground shadow-sm"
              role="status"
              aria-live="polite"
            >
              <span
                className="size-3.5 animate-spin rounded-full border-2 border-muted border-t-foreground/60"
                aria-hidden="true"
              />
              {documentLoadingState.total !== undefined &&
              documentLoadingState.total > 0
                ? `正在后台提高清晰度 ${documentLoadingState.completed ?? 0}/${documentLoadingState.total}…`
                : "正在后台提高清晰度…"}
            </div>
          )}
        {canvasTextEdit && canvasTextNode && canvasTextStyle && (
          <div
            ref={canvasTextEditorRef}
            className="absolute z-10 m-0 min-h-0 overflow-hidden border-0 bg-transparent p-0 whitespace-pre-wrap outline-none [appearance:none] [caret-color:currentColor] [font-kerning:normal] [font-synthesis:none] [overflow-wrap:break-word] focus:outline-none"
            role="textbox"
            aria-label="Canvas text content"
            aria-multiline="true"
            data-rust-caret={
              canvasTextEdit.rustCaretReady ? "ready" : "pending"
            }
            autoFocus
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            style={canvasTextStyle}
            onCompositionStart={() => {
              canvasTextIsComposingRef.current = true;
              pendingCanvasCaretLayoutsRef.current.clear();
              setCanvasTextEdit((current) =>
                current
                  ? {
                      ...current,
                      rustCaretReady: false,
                      rustCaretLayout: undefined,
                    }
                  : current,
              );
            }}
            onCompositionEnd={(event) => {
              canvasTextIsComposingRef.current = false;
              const text = event.currentTarget.innerText;
              const caret = contentEditableCaretOffset(event.currentTarget);
              setCanvasTextEdit((current) =>
                current
                  ? {
                      ...current,
                      draft: text,
                      caret,
                      selectionAnchor: caret,
                      rustCaretReady: false,
                      rustCaretLayout: undefined,
                    }
                  : current,
              );
              requestCanvasCaretLayout(canvasTextNode.id, text, caret);
            }}
            onInput={(event) => {
              const text = event.currentTarget.innerText;
              const caret = contentEditableCaretOffset(event.currentTarget);
              setCanvasTextEdit((current) =>
                current
                  ? {
                      ...current,
                      draft: text,
                      caret,
                      selectionAnchor: caret,
                      rustCaretReady: false,
                      rustCaretLayout: undefined,
                    }
                  : current,
              );
              if (!canvasTextIsComposingRef.current)
                requestCanvasCaretLayout(canvasTextNode.id, text, caret);
            }}
            onCopy={(event) => {
              const selection = contentEditableSelectionOffsets(
                event.currentTarget,
              );
              if (!selection) return;
              const payload = captureTextClipboard(
                canvasTextEdit.draft,
                canvasTextDraftProperties(canvasTextEdit),
                selection.anchor,
                selection.focus,
              );
              if (!payload) return;
              event.preventDefault();
              event.clipboardData.setData("text/plain", payload.text);
              const encoded = encodeTextClipboard(payload);
              if (encoded)
                event.clipboardData.setData(
                  "application/x-makefigma-text-v1",
                  encoded,
                );
            }}
            onCut={(event) => {
              const selection = contentEditableSelectionOffsets(
                event.currentTarget,
              );
              if (!selection) return;
              const start = Math.min(selection.anchor, selection.focus);
              const end = Math.max(selection.anchor, selection.focus);
              const properties = canvasTextDraftProperties(canvasTextEdit);
              const payload = captureTextClipboard(
                canvasTextEdit.draft,
                properties,
                start,
                end,
              );
              if (!payload) return;
              event.preventDefault();
              event.clipboardData.setData("text/plain", payload.text);
              const encoded = encodeTextClipboard(payload);
              if (encoded)
                event.clipboardData.setData(
                  "application/x-makefigma-text-v1",
                  encoded,
                );
              const next = `${canvasTextEdit.draft.slice(0, start)}${canvasTextEdit.draft.slice(end)}`;
              const nextProperties = rebaseTextStyleRuns(
                canvasTextEdit.draft,
                next,
                properties,
              );
              setCanvasTextEdit((current) =>
                current &&
                current.nodeId === canvasTextEdit.nodeId &&
                current.draft === canvasTextEdit.draft
                  ? {
                      ...current,
                      initialDraft: next,
                      draft: next,
                      properties: nextProperties,
                      caret: start,
                      selectionAnchor: start,
                      rustCaretReady: false,
                      rustCaretLayout: undefined,
                    }
                  : current,
              );
              requestCanvasCaretLayout(canvasTextEdit.nodeId, next, start);
            }}
            onPaste={(event) => {
              event.preventDefault();
              const selection = contentEditableSelectionOffsets(
                event.currentTarget,
              );
              if (!selection) return;
              const start = Math.min(selection.anchor, selection.focus);
              const end = Math.max(selection.anchor, selection.focus);
              const properties = canvasTextDraftProperties(canvasTextEdit);
              const rich = decodeTextClipboard(
                event.clipboardData.getData("application/x-makefigma-text-v1"),
              );
              const pasted = rich
                ? pasteTextClipboard(
                    canvasTextEdit.draft,
                    properties,
                    start,
                    end,
                    rich,
                  )
                : undefined;
              const plain =
                pasted?.text ?? event.clipboardData.getData("text/plain");
              if (!plain) return;
              const next =
                pasted?.text ??
                `${canvasTextEdit.draft.slice(0, start)}${plain}${canvasTextEdit.draft.slice(end)}`;
              const nextProperties =
                pasted?.properties ??
                rebaseTextStyleRuns(canvasTextEdit.draft, next, properties);
              const caret = start + plain.length;
              setCanvasTextEdit((current) =>
                current &&
                current.nodeId === canvasTextEdit.nodeId &&
                current.draft === canvasTextEdit.draft
                  ? {
                      ...current,
                      initialDraft: next,
                      draft: next,
                      properties: nextProperties,
                      caret,
                      selectionAnchor: caret,
                      rustCaretReady: false,
                      rustCaretLayout: undefined,
                    }
                  : current,
              );
              requestCanvasCaretLayout(canvasTextEdit.nodeId, next, caret);
            }}
            onBlur={(event) =>
              commitCanvasTextEdit(event.currentTarget.innerText)
            }
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                cancelCanvasTextEdit();
              } else if (
                (event.metaKey || event.ctrlKey) &&
                event.key === "Enter"
              ) {
                event.preventDefault();
                commitCanvasTextEdit();
              } else if (
                !canvasTextIsComposingRef.current &&
                !event.altKey &&
                !event.metaKey &&
                !event.ctrlKey &&
                (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
                canvasTextEdit.rustCaretLayout
              ) {
                const selection = contentEditableSelectionOffsets(
                  event.currentTarget,
                );
                if (!selection) return;
                event.preventDefault();
                const direction = event.key === "ArrowLeft" ? -1 : 1;
                const anchor = snapUtf16CaretToRustLayout(
                  canvasTextEdit.draft,
                  selection.anchor,
                  canvasTextEdit.rustCaretLayout,
                );
                const focus = snapUtf16CaretToRustLayout(
                  canvasTextEdit.draft,
                  selection.focus,
                  canvasTextEdit.rustCaretLayout,
                );
                const nextCaret =
                  !event.shiftKey && anchor !== focus
                    ? direction < 0
                      ? Math.min(anchor, focus)
                      : Math.max(anchor, focus)
                    : moveUtf16CaretInRustLayout(
                        canvasTextEdit.draft,
                        focus,
                        direction,
                        canvasTextEdit.rustCaretLayout,
                      );
                const nextAnchor = event.shiftKey ? anchor : nextCaret;
                placeContentEditableSelection(
                  event.currentTarget,
                  nextAnchor,
                  nextCaret,
                );
                setCanvasTextEdit((current) =>
                  current
                    ? {
                        ...current,
                        caret: nextCaret,
                        selectionAnchor: nextAnchor,
                      }
                    : current,
                );
              }
            }}
          >
            {canvasTextEditParagraphs.map((paragraph, index) => (
              <div
                key={`${paragraph.start}-${paragraph.end}`}
                className="block"
                dir={paragraph.direction}
                style={{
                  marginBottom:
                    index < canvasTextEditParagraphs.length - 1
                      ? `${(canvasTextEdit.properties.paragraph.paragraphSpacing ?? 0) * snapshot.viewport.zoom}px`
                      : 0,
                  textAlign:
                    paragraph.direction === "rtl"
                      ? "right"
                      : canvasTextEdit.properties.paragraph.alignment ===
                          "justify"
                        ? "left"
                        : canvasTextEdit.properties.paragraph.alignment,
                }}
              >
                {paragraph.spans.length
                  ? paragraph.spans.map((span) => {
                      const family = span.style.font
                        ? `"${fontFamilyForAsset(span.style.font.assetId)}", `
                        : "";
                      return (
                        <span
                          key={`${span.start}-${span.end}`}
                          style={{
                            fontFamily: `${family}${canvasDesignTokens.typography.canvasText.family}`,
                            fontSize: `${span.style.fontSize * snapshot.viewport.zoom}px`,
                            fontWeight: span.style.fontWeight,
                            fontStyle: span.style.italic ? "italic" : "normal",
                            fontSynthesis: "none",
                            letterSpacing: `${span.style.letterSpacing * snapshot.viewport.zoom}px`,
                            color: span.style.color
                              ? colorToSrgbCss(span.style.color)
                              : undefined,
                          }}
                        >
                          {span.text}
                        </span>
                      );
                    })
                  : paragraph.text || "\u200b"}
              </div>
            ))}
          </div>
        )}
        <div className="absolute bottom-4 left-4 flex max-w-[calc(100%-2rem)] flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border bg-background/90 px-2.5 py-1.5 text-[10px] text-muted-foreground shadow-sm backdrop-blur [&>b]:text-foreground [&>span:first-child]:font-medium [&>span:first-child]:text-foreground">
          <span>WORLD</span>
          <b>{Math.round(snapshot.viewport.zoom * 100)}%</b>
          <span>⌘ + scroll to zoom</span>
          <span
            aria-label="Render evidence"
            data-render-performance={renderPerformanceEvidence}
            data-render-diagnostics={JSON.stringify(
              snapshot.diagnostics ?? { total: 0, byCategory: {}, recent: [] },
            )}
            data-engine-recoveries={workerRecoveryCount}
          >
            {renderEvidence}
          </span>
          <span
            aria-label="Main thread responsiveness"
            data-main-thread-long-tasks={JSON.stringify(mainThreadLongTasks)}
          >
            {mainThreadEvidence}
          </span>
          <span
            aria-label="Frame interval evidence"
            data-frame-intervals={JSON.stringify(frameIntervals)}
          >
            {frameEvidence}
          </span>
          <span
            aria-label="Input backlog evidence"
            data-input-backlog={JSON.stringify(inputBacklog)}
          >
            {inputBacklogEvidence}
          </span>
          {!deterministicEvidenceCapture && (
            <span
              aria-label="Viewport checkpoint evidence"
              data-viewport-checkpoints={JSON.stringify(viewportCheckpoints)}
            >
              {viewportCheckpointEvidence}
            </span>
          )}
          <span aria-label="Resource evidence">{resourceEvidence}</span>
          <span
            aria-label="Canonical document hash"
            data-document-id={snapshot.documentId}
            data-document-revision={snapshot.revision}
            data-document-hash={snapshot.documentHash ?? ""}
          >
            {snapshot.documentHash
              ? `hash ${snapshot.documentHash.slice(0, 12)}`
              : "hash pending"}
          </span>
        </div>
        {error && (
          <div
            className="absolute top-4 left-1/2 z-20 max-w-md -translate-x-1/2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            {error}
          </div>
        )}
      </section>

      <aside
        className="flex min-h-0 flex-col border-l bg-background [&_section]:relative [&_section]:border-t [&_section]:p-3 [&_section>button]:h-8 [&_section>button]:rounded-lg [&_section>button]:border [&_section>button]:bg-background [&_section>button]:px-2 [&_section>button]:text-xs [&_section>button]:font-medium [&_section>button]:hover:bg-muted [&_section>button:disabled]:opacity-50 [&_section>h2]:mb-3 [&_section>h2]:text-xs [&_section>h2]:font-medium [&_section>h2]:text-muted-foreground [&_textarea]:min-h-20 [&_textarea]:w-full [&_textarea]:resize-y [&_textarea]:rounded-lg [&_textarea]:border [&_textarea]:bg-background [&_textarea]:p-2 [&_textarea]:text-xs [&_textarea]:outline-none [&_textarea]:focus-visible:ring-2 [&_textarea]:focus-visible:ring-ring/50"
        aria-label="Properties"
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b px-3 text-xs font-medium">
          <span>Inspect</span>
          <Badge variant="outline">r{snapshot.revision}</Badge>
        </div>
        {selected ? (
          <Inspector
            node={selected}
            sceneNodes={snapshot.nodes}
            assets={snapshot.assets ?? []}
            fontAvailability={snapshot.fontAvailability}
            onUpdate={update}
            onSetMask={setMask}
            onMovePoint={moveVectorPoint}
            onSetSubpathClosed={setVectorSubpathClosed}
            onInsertPoint={insertVectorPoint}
            onSplitSegment={splitVectorSegment}
            onDeletePoint={deleteVectorPoint}
            onSetPointHandles={setVectorPointHandles}
            readOnly={!canEdit}
          />
        ) : selectedNodes.length > 1 ? (
          <MultiInspector
            nodes={selectedNodes}
            sceneNodes={snapshot.nodes}
            onUpdate={updateSelection}
            onUpdateGeometry={updateSelectionGeometry}
            onUpdateStrokeWeight={updateSelectionStrokeWeight}
            onUseUniformStrokeWeights={useSelectionUniformStrokeWeights}
            onUpdateCornerRadius={updateSelectionCornerRadius}
            onUseUniformCornerRadius={useSelectionUniformCornerRadius}
            onUpdateConstraint={updateSelectionConstraint}
            onRemoveConstraints={removeSelectionConstraints}
            readOnly={!canEdit}
          />
        ) : (
          <div className="p-4 text-sm leading-relaxed text-muted-foreground">
            Select an object to reveal its geometry, fill and layer settings.
          </div>
        )}
        <SelectionArrangeControls
          canEdit={canEdit}
          selectedCount={snapshot.selectedIds.length}
          selectedIsGroup={selected?.kind === "group"}
          onGroup={groupSelected}
          onUngroup={ungroupSelected}
          onArrange={arrangeSelectedLayers}
        />
        <div className="grid grid-cols-2 gap-1 border-t p-2 [&>button]:h-7 [&>button]:rounded-lg [&>button]:border [&>button]:bg-background [&>button]:px-2 [&>button]:text-xs [&>button]:font-medium [&>button]:hover:bg-muted [&>button:disabled]:pointer-events-none [&>button:disabled]:opacity-50">
          <button
            title="Select two or more Vector layers"
            disabled={
              !canEdit ||
              selectedNodes.length < 2 ||
              !selectedNodes.every((node) => node.kind === "vector")
            }
            onClick={() => booleanSelected("union")}
          >
            Union
          </button>
          <button
            title="Select two or more Vector layers"
            disabled={
              !canEdit ||
              selectedNodes.length < 2 ||
              !selectedNodes.every((node) => node.kind === "vector")
            }
            onClick={() => booleanSelected("subtract")}
          >
            Subtract
          </button>
          <button
            title="Select two or more Vector layers"
            disabled={
              !canEdit ||
              selectedNodes.length < 2 ||
              !selectedNodes.every((node) => node.kind === "vector")
            }
            onClick={() => booleanSelected("intersect")}
          >
            Intersect
          </button>
          <button
            title="Select two or more Vector layers"
            disabled={
              !canEdit ||
              selectedNodes.length < 2 ||
              !selectedNodes.every((node) => node.kind === "vector")
            }
            onClick={() => booleanSelected("exclude")}
          >
            Exclude
          </button>
          <button
            title="Flatten a derived Vector Boolean into one editable Vector"
            disabled={!canEdit || !selectedBooleanFlattenable}
            onClick={() =>
              selected && command({ type: "flattenBoolean", id: selected.id })
            }
          >
            Flatten
          </button>
          <button
            title="Convert this editable Polygon or Star into its current VectorPath"
            disabled={!canEdit || !selectedParametricConvertible}
            onClick={() =>
              selected &&
              command({ type: "convertParametricToVector", id: selected.id })
            }
          >
            Convert to Vector
          </button>
          <button
            title="Outline a solid matching-cap Vector or Line stroke as editable filled paths"
            disabled={!canEdit || !selectedVectorOutlineable}
            onClick={() =>
              selected && command({ type: "outlineStroke", id: selected.id })
            }
          >
            Outline stroke
          </button>
          <button
            disabled={!canEdit || snapshot.selectedIds.length === 0}
            onClick={() =>
              command({ type: "duplicate", ids: snapshot.selectedIds })
            }
          >
            Duplicate ⌘D
          </button>
          <button
            disabled={!canEdit || !snapshot.canUndo}
            onClick={() => command({ type: "undo" })}
          >
            ↶ Undo
          </button>
          <button
            disabled={!canEdit || !snapshot.canRedo}
            onClick={() => command({ type: "redo" })}
          >
            Redo ↷
          </button>
        </div>
      </aside>
    </main>
  );
}

function MultiInspector({
  nodes,
  sceneNodes,
  onUpdate,
  onUpdateGeometry,
  onUpdateStrokeWeight,
  onUseUniformStrokeWeights,
  onUpdateCornerRadius,
  onUseUniformCornerRadius,
  onUpdateConstraint,
  onRemoveConstraints,
  readOnly,
}: {
  nodes: readonly CanvasNode[];
  sceneNodes: readonly CanvasNode[];
  onUpdate: (patch: Partial<CanvasNode>) => void;
  onUpdateGeometry: (
    patch: Partial<Pick<CanvasNode, "x" | "y" | "width" | "height">>,
  ) => void;
  onUpdateStrokeWeight: (index: number, value: number) => void;
  onUseUniformStrokeWeights: () => void;
  onUpdateCornerRadius: (index: number, value: number) => void;
  onUseUniformCornerRadius: () => void;
  onUpdateConstraint: (
    axis: "horizontal" | "vertical",
    value: ConstraintType,
  ) => void;
  onRemoveConstraints: () => void;
  readOnly: boolean;
}) {
  const rotation = mixedSelectionValue(nodes.map((node) => node.rotation));
  const opacity = mixedSelectionValue(nodes.map((node) => node.opacity));
  const visible = mixedSelectionValue(
    nodes.map((node) => node.visible !== false),
  );
  const locked = mixedSelectionValue(nodes.map((node) => Boolean(node.locked)));
  const capabilities = mixedInspectorCapabilities(nodes);
  const supportsStrokeWidth = capabilities.strokeWidth;
  const strokeWidth = mixedSelectionValue(
    nodes.map((node) => node.strokeWidth),
  );
  const supportsStrokeAlign = capabilities.strokeAlign;
  const strokeAlign = mixedSelectionValue(
    nodes.map((node) => node.strokeAlign ?? "inside"),
  );
  const strokeWeights = capabilities.perSideStroke
    ? strokeWeightSelection(nodes)
    : undefined;
  const cornerRadii = capabilities.corners
    ? cornerRadiusSelection(nodes)
    : undefined;
  const cornerSmoothing = capabilities.corners
    ? cornerSmoothingSelection(nodes)
    : undefined;
  const constraintsOverriddenByAutoLayout = nodes.some((node) =>
    hasActiveAutoLayoutConstraintOverride(sceneNodes, node),
  );
  const constraintsApplicable =
    !constraintsOverriddenByAutoLayout &&
    nodes.every((node) => hasFrameConstraintScope(sceneNodes, node));
  const constraints = constraintsApplicable
    ? constraintSelection(nodes)
    : undefined;
  const lineAppearance = capabilities.lineStroke
    ? lineSelectionAppearance(nodes)
    : undefined;
  const strokeAppearance = capabilities.strokeDetails
    ? strokeSelectionAppearance(nodes)
    : undefined;
  const sectionContentsHidden = capabilities.sectionContents
    ? mixedSelectionValue(nodes.map((node) => Boolean(node.contentsHidden)))
    : undefined;
  const frameClipsContent = capabilities.frameClip
    ? mixedSelectionValue(nodes.map((node) => node.clipsContent !== false))
    : undefined;
  const selectionGeometry = resolveMultiResizeSelection(
    sceneNodes,
    nodes.map((node) => node.id),
  );
  const supportsFill = capabilities.fill;
  const simpleFill =
    supportsFill &&
    nodes.every((node) => !node.fills?.length && !node.fillGradient);
  const simpleStroke =
    supportsStrokeWidth &&
    nodes.every((node) => !node.strokes?.length && !node.strokeGradient);
  const fill = mixedSelectionValue(nodes.map((node) => node.fill));
  const stroke = mixedSelectionValue(nodes.map((node) => node.stroke));
  const dropShadowEnabled = mixedSelectionValue(
    nodes.map((node) => Boolean(node.dropShadow)),
  );
  const dropShadowValues = mixedSelectionValue(
    nodes.map((node) => JSON.stringify(node.dropShadow ?? null)),
  );
  const selectionField = (value: number): MixedSelectionValue<number> => ({
    kind: "same",
    value: Math.round(value * 100) / 100,
  });
  const numericField = (
    label: string,
    value: MixedSelectionValue<number>,
    unit: string,
    apply: (value: number) => void,
    minimum?: number,
  ) => (
    <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
      <span>{label}</span>
      <div>
        <input
          aria-label={`Selection ${label.toLowerCase()}`}
          disabled={readOnly}
          inputMode="decimal"
          value={value.kind === "same" ? value.value : ""}
          placeholder={value.kind === "mixed" ? "Mixed" : undefined}
          onChange={(event) => {
            const raw = event.target.value.trim();
            const next = Number(raw);
            if (
              raw &&
              Number.isFinite(next) &&
              (minimum === undefined || next >= minimum)
            )
              apply(next);
          }}
        />
        <em>{unit}</em>
      </div>
    </label>
  );
  return (
    <div className="multi-inspector min-h-0 flex-1 overflow-auto">
      <div
        className="selection-title flex min-h-12 items-center gap-2 border-b px-3 py-2 text-sm font-medium [&_input]:h-8 [&_input]:min-w-0 [&_input]:flex-1 [&_input]:rounded-lg [&_input]:border [&_input]:bg-background [&_input]:px-2 [&_input]:text-sm [&_input]:outline-none [&_input]:focus-visible:ring-2 [&_input]:focus-visible:ring-ring/50"
        role="status"
        aria-live="polite"
        data-selection-capabilities={inspectorCapabilityAnnouncement(nodes)}
      >
        <span
          className="grid size-5 shrink-0 place-items-center text-xs text-muted-foreground"
          aria-hidden="true"
        >
          ◫
        </span>
        <strong>{nodes.length} layers selected</strong>
        <span className="visually-hidden sr-only">
          {inspectorCapabilityAnnouncement(nodes)}
        </span>
      </div>
      {selectionGeometry && (
        <section>
          <h2>Geometry</h2>
          <div className="grid grid-cols-2 gap-2">
            {numericField(
              "X",
              selectionField(selectionGeometry.bounds.x),
              "px",
              (value) => onUpdateGeometry({ x: value }),
            )}
            {numericField(
              "Y",
              selectionField(selectionGeometry.bounds.y),
              "px",
              (value) => onUpdateGeometry({ y: value }),
            )}
            {numericField(
              "W",
              selectionField(selectionGeometry.bounds.width),
              "px",
              (value) => onUpdateGeometry({ width: value }),
              0.001,
            )}
            {numericField(
              "H",
              selectionField(selectionGeometry.bounds.height),
              "px",
              (value) => onUpdateGeometry({ height: value }),
              0.001,
            )}
          </div>
        </section>
      )}
      <section>
        <h2>Selection</h2>
        <div className="grid grid-cols-2 gap-2">
          {numericField("Rotation", rotation, "°", (value) =>
            onUpdate({ rotation: value }),
          )}
          <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
            <span>Opacity</span>
            <div>
              <input
                aria-label="Selection opacity"
                disabled={readOnly}
                inputMode="decimal"
                value={
                  opacity.kind === "same" ? Math.round(opacity.value * 100) : ""
                }
                placeholder={opacity.kind === "mixed" ? "Mixed" : undefined}
                onChange={(event) => {
                  const raw = event.target.value.trim();
                  const value = Number(raw);
                  if (
                    raw &&
                    Number.isFinite(value) &&
                    value >= 0 &&
                    value <= 100
                  )
                    onUpdate({ opacity: value / 100 });
                }}
              />
              <em>%</em>
            </div>
          </label>
          {supportsStrokeWidth &&
            numericField(
              "Stroke width",
              strokeWidth,
              "px",
              (value) => onUpdate({ strokeWidth: value }),
              0,
            )}
          {supportsStrokeAlign && (
            <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
              <span>Stroke align</span>
              <div>
                <select
                  aria-label="Selection stroke align"
                  disabled={readOnly}
                  value={strokeAlign.kind === "same" ? strokeAlign.value : ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (
                      value === "inside" ||
                      value === "center" ||
                      value === "outside"
                    )
                      onUpdate({ strokeAlign: value });
                  }}
                >
                  <option value="" disabled>
                    Mixed
                  </option>
                  <option value="inside">Inside</option>
                  <option value="center">Center</option>
                  <option value="outside">Outside</option>
                </select>
              </div>
            </label>
          )}
        </div>
      </section>
      {strokeWeights && (
        <section>
          <h2>Stroke weights</h2>
          <div className="grid grid-cols-2 gap-2">
            {numericField(
              "Top weight",
              strokeWeights.top,
              "px",
              (value) => onUpdateStrokeWeight(0, value),
              0,
            )}
            {numericField(
              "Right weight",
              strokeWeights.right,
              "px",
              (value) => onUpdateStrokeWeight(1, value),
              0,
            )}
            {numericField(
              "Bottom weight",
              strokeWeights.bottom,
              "px",
              (value) => onUpdateStrokeWeight(2, value),
              0,
            )}
            {numericField(
              "Left weight",
              strokeWeights.left,
              "px",
              (value) => onUpdateStrokeWeight(3, value),
              0,
            )}
          </div>
          <button
            type="button"
            disabled={readOnly || !strokeWeights.hasExplicitWeights}
            onClick={onUseUniformStrokeWeights}
          >
            Use uniform width
          </button>
        </section>
      )}
      {cornerRadii && (
        <section>
          <h2>Corner radii</h2>
          <div className="grid grid-cols-2 gap-2">
            {numericField(
              "Top left radius",
              cornerRadii.topLeft,
              "px",
              (value) => onUpdateCornerRadius(0, value),
              0,
            )}
            {numericField(
              "Top right radius",
              cornerRadii.topRight,
              "px",
              (value) => onUpdateCornerRadius(1, value),
              0,
            )}
            {numericField(
              "Bottom right radius",
              cornerRadii.bottomRight,
              "px",
              (value) => onUpdateCornerRadius(2, value),
              0,
            )}
            {numericField(
              "Bottom left radius",
              cornerRadii.bottomLeft,
              "px",
              (value) => onUpdateCornerRadius(3, value),
              0,
            )}
          </div>
          <button
            type="button"
            disabled={readOnly || !cornerRadii.hasExplicitRadii}
            onClick={onUseUniformCornerRadius}
          >
            Use uniform radius
          </button>
        </section>
      )}
      {cornerSmoothing && (
        <section>
          <h2>Corner smoothing</h2>
          <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
            <span>Amount</span>
            <div>
              <input
                aria-label="Selection corner smoothing"
                disabled={readOnly}
                inputMode="decimal"
                value={
                  cornerSmoothing.kind === "same"
                    ? Math.round(cornerSmoothing.value * 100)
                    : ""
                }
                placeholder={
                  cornerSmoothing.kind === "mixed" ? "Mixed" : undefined
                }
                onChange={(event) => {
                  const raw = event.target.value.trim();
                  const value = Number(raw);
                  if (
                    raw &&
                    Number.isFinite(value) &&
                    value >= 0 &&
                    value <= 100
                  )
                    onUpdate({ cornerSmoothing: value / 100 });
                }}
              />
              <em>%</em>
            </div>
          </label>
          <button
            type="button"
            disabled={
              readOnly ||
              (cornerSmoothing.kind === "same" && cornerSmoothing.value === 0)
            }
            onClick={() => onUpdate({ cornerSmoothing: undefined })}
          >
            Use circular corners
          </button>
        </section>
      )}
      {constraints && (
        <section>
          <h2>Constraints</h2>
          <div className="grid grid-cols-2 gap-2">
            <SelectionConstraintField
              label="Selection horizontal constraint"
              value={constraints.horizontal}
              readOnly={readOnly}
              onChange={(value) => onUpdateConstraint("horizontal", value)}
            />
            <SelectionConstraintField
              label="Selection vertical constraint"
              value={constraints.vertical}
              readOnly={readOnly}
              onChange={(value) => onUpdateConstraint("vertical", value)}
            />
          </div>
          <button
            type="button"
            disabled={readOnly || !constraints.hasExplicitConstraints}
            onClick={onRemoveConstraints}
          >
            Remove constraints
          </button>
        </section>
      )}
      {constraintsOverriddenByAutoLayout && (
        <section>
          <h2>Constraints</h2>
          <p
            className="mb-2 text-xs leading-relaxed text-muted-foreground"
            role="status"
          >
            Auto layout owns this selection’s geometry. Existing constraints are
            preserved but not applied.
          </p>
        </section>
      )}
      {!constraintsApplicable &&
        !constraintsOverriddenByAutoLayout &&
        nodes.some((node) => node.constraints) && (
          <section>
            <h2>Constraints</h2>
            <p
              className="mb-2 text-xs leading-relaxed text-muted-foreground"
              role="status"
            >
              Constraints are preserved but not applicable outside a Frame or
              through a non-Group ancestor.
            </p>
          </section>
        )}
      {strokeAppearance && (
        <section>
          <h2>{lineAppearance ? "Line stroke" : "Stroke details"}</h2>
          <div className="grid grid-cols-2 gap-2">
            {lineAppearance && (
              <>
                <LineSelectionCap
                  label="Selection start cap"
                  value={lineAppearance.strokeCapStart}
                  readOnly={readOnly}
                  onChange={(value) => onUpdate({ strokeCapStart: value })}
                />
                <LineSelectionCap
                  label="Selection end cap"
                  value={lineAppearance.strokeCapEnd}
                  readOnly={readOnly}
                  onChange={(value) => onUpdate({ strokeCapEnd: value })}
                />
              </>
            )}
            <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
              <span>Join</span>
              <div>
                <select
                  aria-label="Selection stroke join"
                  disabled={readOnly}
                  value={
                    strokeAppearance.strokeJoin.kind === "same"
                      ? strokeAppearance.strokeJoin.value
                      : ""
                  }
                  onChange={(event) => {
                    const value = event.target.value;
                    if (
                      value === "miter" ||
                      value === "bevel" ||
                      value === "round"
                    )
                      onUpdate({ strokeJoin: value });
                  }}
                >
                  <option value="" disabled>
                    Mixed
                  </option>
                  <option value="miter">Miter</option>
                  <option value="bevel">Bevel</option>
                  <option value="round">Round</option>
                </select>
              </div>
            </label>
            {numericField(
              "Miter limit",
              strokeAppearance.strokeMiterLimit,
              "",
              (value) => onUpdate({ strokeMiterLimit: value }),
              1,
            )}
            <LineSelectionDash
              value={strokeAppearance.strokeDashPattern}
              readOnly={readOnly}
              onChange={(value) => onUpdate({ strokeDashPattern: value })}
            />
          </div>
        </section>
      )}
      <section>
        <h2>Paint</h2>
        <div className="grid grid-cols-2 gap-2">
          {simpleFill ? (
            <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
              <span>Fill</span>
              <div>
                <input
                  aria-label="Selection fill"
                  disabled={readOnly}
                  value={fill.kind === "same" ? fill.value : ""}
                  placeholder={fill.kind === "mixed" ? "Mixed" : undefined}
                  onChange={(event) => {
                    const color = documentColorFromCssHex(event.target.value);
                    if (color)
                      onUpdate({
                        fill: event.target.value,
                        fills: undefined,
                        fillGradient: undefined,
                      });
                  }}
                />
              </div>
            </label>
          ) : (
            <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
              Fill layers: select one compatible layer to edit gradients or
              Paint Stack.
            </p>
          )}
          {simpleStroke ? (
            <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
              <span>Stroke</span>
              <div>
                <input
                  aria-label="Selection stroke"
                  disabled={readOnly}
                  value={stroke.kind === "same" ? stroke.value : ""}
                  placeholder={stroke.kind === "mixed" ? "Mixed" : undefined}
                  onChange={(event) => {
                    const color = documentColorFromCssHex(event.target.value);
                    if (color)
                      onUpdate({
                        stroke: event.target.value,
                        strokes: undefined,
                        strokeGradient: undefined,
                      });
                  }}
                />
              </div>
            </label>
          ) : (
            <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
              Stroke layers: select one compatible layer to edit gradients or
              Paint Stack.
            </p>
          )}
        </div>
      </section>
      {capabilities.dropShadow ? (
        <section>
          <h2>Drop shadow</h2>
          <MixedToggle
            label="Drop shadow enabled"
            value={dropShadowEnabled}
            readOnly={readOnly}
            onChange={(enabled) =>
              onUpdate({
                dropShadow: enabled ? defaultDropShadow() : undefined,
              })
            }
          />
          {dropShadowValues.kind === "mixed" && (
            <p
              className="mb-2 text-xs leading-relaxed text-muted-foreground"
              role="status"
            >
              Drop shadow values: Mixed. Choose an explicit enabled state to
              apply it to all selected layers.
            </p>
          )}
        </section>
      ) : (
        <section>
          <h2>Drop shadow</h2>
          <p
            className="mb-2 text-xs leading-relaxed text-muted-foreground"
            role="status"
          >
            Drop shadow: Not applicable when a Group is selected.
          </p>
        </section>
      )}
      <section>
        <h2>Layer</h2>
        {frameClipsContent && (
          <MixedToggle
            label="Clip content"
            value={frameClipsContent}
            readOnly={readOnly}
            onChange={(value) => onUpdate({ clipsContent: value })}
          />
        )}
        {sectionContentsHidden && (
          <MixedToggle
            label="Hide contents"
            value={sectionContentsHidden}
            readOnly={readOnly}
            onChange={(value) => onUpdate({ contentsHidden: value })}
          />
        )}
        <MixedToggle
          label="Visible"
          value={visible}
          readOnly={readOnly}
          onChange={(value) => onUpdate({ visible: value })}
        />
        <MixedToggle
          label="Lock editing"
          value={locked}
          readOnly={readOnly}
          onChange={(value) => onUpdate({ locked: value })}
        />
      </section>
    </div>
  );
}

function LineSelectionCap({
  label,
  value,
  readOnly,
  onChange,
}: {
  label: string;
  value: MixedSelectionValue<NonNullable<CanvasNode["strokeCapStart"]>>;
  readOnly: boolean;
  onChange: (value: NonNullable<CanvasNode["strokeCapStart"]>) => void;
}) {
  return (
    <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
      <span>{label.replace("Selection ", "")}</span>
      <div>
        <select
          aria-label={label}
          disabled={readOnly}
          value={value.kind === "same" ? value.value : ""}
          onChange={(event) => {
            const next = event.target.value;
            if (
              [
                "none",
                "round",
                "square",
                "arrowLines",
                "arrowEquilateral",
                "triangleFilled",
                "diamondFilled",
                "circleFilled",
              ].includes(next)
            )
              onChange(next as NonNullable<CanvasNode["strokeCapStart"]>);
          }}
        >
          <option value="" disabled>
            Mixed
          </option>
          <option value="none">None</option>
          <option value="round">Round</option>
          <option value="square">Square</option>
          <option value="arrowLines">Arrow lines</option>
          <option value="arrowEquilateral">Arrow</option>
          <option value="triangleFilled">Triangle</option>
          <option value="diamondFilled">Diamond</option>
          <option value="circleFilled">Circle</option>
        </select>
      </div>
    </label>
  );
}

function LineSelectionDash({
  value,
  readOnly,
  onChange,
}: {
  value: MixedSelectionValue<string>;
  readOnly: boolean;
  onChange: (value: number[]) => void;
}) {
  const canonical = value.kind === "same" ? value.value : "";
  return (
    <LineSelectionDashDraft
      key={`${value.kind}:${canonical}`}
      canonical={canonical}
      mixed={value.kind === "mixed"}
      readOnly={readOnly}
      onChange={onChange}
    />
  );
}

function LineSelectionDashDraft({
  canonical,
  mixed,
  readOnly,
  onChange,
}: {
  canonical: string;
  mixed: boolean;
  readOnly: boolean;
  onChange: (value: number[]) => void;
}) {
  const [draft, setDraft] = useState(canonical);
  const commit = () => {
    const pattern = parseLineDashPattern(draft);
    if (pattern) onChange(pattern);
    else setDraft(canonical);
  };
  return (
    <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
      <span>Dash</span>
      <div>
        <input
          aria-label="Selection stroke dash pattern"
          disabled={readOnly}
          placeholder={mixed ? "Mixed" : "8, 4"}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      </div>
    </label>
  );
}

function SelectionConstraintField({
  label,
  value,
  readOnly,
  onChange,
}: {
  label: string;
  value: MixedSelectionValue<ConstraintSelectionValue>;
  readOnly: boolean;
  onChange: (value: ConstraintType) => void;
}) {
  return (
    <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
      <span>{label.replace("Selection ", "")}</span>
      <div>
        <select
          aria-label={label}
          disabled={readOnly}
          value={value.kind === "same" ? value.value : ""}
          onChange={(event) => {
            const next = event.target.value;
            if (
              next === "min" ||
              next === "center" ||
              next === "max" ||
              next === "stretch" ||
              next === "scale"
            )
              onChange(next);
          }}
        >
          <option value="" disabled>
            Mixed
          </option>
          <option value="none" disabled>
            No constraints
          </option>
          <option value="min">Left / Top</option>
          <option value="center">Center</option>
          <option value="max">Right / Bottom</option>
          <option value="stretch">Left &amp; right / Top &amp; bottom</option>
          <option value="scale">Scale</option>
        </select>
      </div>
    </label>
  );
}

function MixedToggle({
  label,
  value,
  readOnly,
  onChange,
}: {
  label: string;
  value: MixedSelectionValue<boolean>;
  readOnly: boolean;
  onChange: (value: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inputRef.current)
      inputRef.current.indeterminate = value.kind === "mixed";
  }, [value]);
  return (
    <label className="my-2 flex items-center gap-2 text-xs text-muted-foreground [&_input]:size-4 [&_input]:accent-primary">
      <input
        ref={inputRef}
        aria-label={value.kind === "mixed" ? `${label} mixed` : label}
        disabled={readOnly}
        type="checkbox"
        checked={value.kind === "same" && value.value}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
      {value.kind === "mixed" && <em>Mixed</em>}
    </label>
  );
}

function Inspector({
  node,
  sceneNodes,
  assets,
  fontAvailability,
  onUpdate,
  onSetMask,
  onMovePoint,
  onSetSubpathClosed,
  onInsertPoint,
  onSplitSegment,
  onDeletePoint,
  onSetPointHandles,
  readOnly,
}: {
  node: CanvasNode;
  sceneNodes: readonly CanvasNode[];
  assets: DocumentAsset[];
  fontAvailability?: EditorSnapshot["fontAvailability"];
  onUpdate: (patch: Partial<CanvasNode>) => void;
  onSetMask: (id: string, enabled: boolean) => void;
  onMovePoint: (id: string, pointId: string, x: number, y: number) => void;
  onSetSubpathClosed: (
    id: string,
    subpathIndex: number,
    closed: boolean,
  ) => void;
  onInsertPoint: (
    id: string,
    subpathIndex: number,
    afterPointId: string | undefined,
    point: NonNullable<
      CanvasNode["vectorPath"]
    >["subpaths"][number]["points"][number],
  ) => void;
  onSplitSegment: (
    id: string,
    subpathIndex: number,
    afterPointId: string,
    t: number,
    pointId: string,
  ) => void;
  onDeletePoint: (id: string, pointId: string) => void;
  onSetPointHandles: (
    id: string,
    pointId: string,
    handleIn: { x: number; y: number } | undefined,
    handleOut: { x: number; y: number } | undefined,
    pointType: NonNullable<
      CanvasNode["vectorPath"]
    >["subpaths"][number]["points"][number]["pointType"],
  ) => void;
  readOnly: boolean;
}) {
  const field = (
    label: string,
    key: keyof CanvasNode,
    value: string | number,
    unit = "",
  ) => (
    <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
      <span>{label}</span>
      <div>
        <input
          aria-label={label}
          readOnly={readOnly}
          inputMode={typeof value === "number" ? "decimal" : undefined}
          value={value}
          onChange={(event) => {
            if (typeof value !== "number") {
              const resetStack =
                key === "fill"
                  ? { fills: undefined }
                  : key === "stroke"
                    ? { strokes: undefined }
                    : {};
              onUpdate({ [key]: event.target.value, ...resetStack });
              return;
            }
            const raw = event.target.value.trim();
            const parsed = Number(raw);
            if (!raw || !Number.isFinite(parsed)) return;
            onUpdate({ [key]: parsed / (key === "opacity" ? 100 : 1) });
          }}
        />
        <em>{unit}</em>
      </div>
    </label>
  );
  const gradientCss = node.fillGradient
    ? `linear-gradient(${node.fillGradient.stops.map((stop) => `${colorCss(stop.color)} ${Math.round(stop.position * 100)}%`).join(", ")})`
    : undefined;
  const imageAsset = node.assetId
    ? assets.find((asset) => asset.assetId === node.assetId)
    : undefined;
  const updateGradient = (gradient: DocumentLinearGradient) =>
    onUpdate({ fillGradient: gradient });
  const createGradient = () => {
    const fillColor = node.fillColor ?? documentColorFromCssHex(node.fill);
    if (fillColor) updateGradient(createDefaultLinearGradient(fillColor));
  };
  const updateGradientColor = (index: number, value: string) => {
    const color = documentColorFromCssHex(value);
    if (!node.fillGradient || !color) return;
    updateGradient({
      ...node.fillGradient,
      stops: node.fillGradient.stops.map((stop, stopIndex) =>
        stopIndex === index
          ? { ...stop, color: { ...color, alpha: stop.color.alpha } }
          : stop,
      ),
    });
  };
  const updateGradientPosition = (index: number, value: number) => {
    if (!node.fillGradient) return;
    const lower = index === 0 ? 0 : node.fillGradient.stops[index - 1].position;
    const upper =
      index === node.fillGradient.stops.length - 1
        ? 1
        : node.fillGradient.stops[index + 1].position;
    const position = Math.max(lower, Math.min(upper, value));
    updateGradient({
      ...node.fillGradient,
      stops: node.fillGradient.stops.map((stop, stopIndex) =>
        stopIndex === index ? { ...stop, position } : stop,
      ),
    });
  };
  const addGradientStop = () => {
    if (!node.fillGradient || node.fillGradient.stops.length >= 16) return;
    let insertion = 0;
    let largestGap = -1;
    for (
      let index = 0;
      index < node.fillGradient.stops.length - 1;
      index += 1
    ) {
      const gap =
        node.fillGradient.stops[index + 1].position -
        node.fillGradient.stops[index].position;
      if (gap > largestGap) {
        largestGap = gap;
        insertion = index;
      }
    }
    if (largestGap <= 0) return;
    const left = node.fillGradient.stops[insertion];
    const nextStop = {
      position: left.position + largestGap / 2,
      color: structuredClone(left.color),
    };
    updateGradient({
      ...node.fillGradient,
      stops: [
        ...node.fillGradient.stops.slice(0, insertion + 1),
        nextStop,
        ...node.fillGradient.stops.slice(insertion + 1),
      ],
    });
  };
  const removeGradientStop = (index: number) => {
    if (!node.fillGradient || node.fillGradient.stops.length <= 2) return;
    updateGradient({
      ...node.fillGradient,
      stops: node.fillGradient.stops.filter(
        (_, stopIndex) => stopIndex !== index,
      ),
    });
  };
  const setGradientDirection = (
    start: [number, number],
    end: [number, number],
  ) =>
    node.fillGradient && updateGradient({ ...node.fillGradient, start, end });
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div
        className="selection-title flex min-h-12 items-center gap-2 border-b px-3 py-2 text-sm font-medium [&_input]:h-8 [&_input]:min-w-0 [&_input]:flex-1 [&_input]:rounded-lg [&_input]:border [&_input]:bg-background [&_input]:px-2 [&_input]:text-sm [&_input]:outline-none [&_input]:focus-visible:ring-2 [&_input]:focus-visible:ring-ring/50"
        role="status"
        aria-live="polite"
      >
        <span className="grid size-5 shrink-0 place-items-center text-xs text-muted-foreground">
          {node.kind === "ellipse"
            ? "○"
            : node.kind === "polygon"
              ? "⬠"
              : node.kind === "star"
                ? "☆"
                : node.kind === "vector"
                  ? "⌁"
                  : node.kind === "line"
                    ? "／"
                    : node.kind === "text"
                      ? "T"
                      : node.kind === "frame"
                        ? "#"
                        : node.kind === "group"
                          ? "◇"
                          : node.kind === "section"
                            ? "§"
                            : node.kind === "slice"
                              ? "▣"
                              : node.kind === "image"
                                ? "▧"
                                : "□"}
        </span>
        <input
          readOnly={readOnly}
          value={node.name}
          aria-label="Layer name"
          onChange={(event) => onUpdate({ name: event.target.value })}
        />
      </div>
      <section>
        <h2>Geometry</h2>
        <div className="grid grid-cols-2 gap-2">
          {field("X", "x", node.x)}
          {field("Y", "y", node.y)}
          {field("W", "width", Math.round(node.width))}
          {node.kind !== "line" &&
            field("H", "height", Math.round(node.height))}
          {field("Rotation", "rotation", Math.round(node.rotation), "°")}
        </div>
      </section>
      {node.kind === "line" ? (
        <section>
          <h2>Appearance</h2>
          {field("Stroke", "stroke", node.stroke)}
          {field("Stroke width", "strokeWidth", node.strokeWidth, "px")}
          <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
            <span>Start cap</span>
            <div>
              <select
                aria-label="Start cap"
                disabled={readOnly}
                value={node.strokeCapStart ?? "none"}
                onChange={(event) =>
                  onUpdate({
                    strokeCapStart: event.target.value as NonNullable<
                      CanvasNode["strokeCapStart"]
                    >,
                  })
                }
              >
                <option value="none">None</option>
                <option value="round">Round</option>
                <option value="square">Square</option>
                <option value="arrowLines">Arrow lines</option>
                <option value="arrowEquilateral">Arrow</option>
                <option value="triangleFilled">Triangle</option>
                <option value="diamondFilled">Diamond</option>
                <option value="circleFilled">Circle</option>
              </select>
            </div>
          </label>
          <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
            <span>End cap</span>
            <div>
              <select
                aria-label="End cap"
                disabled={readOnly}
                value={node.strokeCapEnd ?? "none"}
                onChange={(event) =>
                  onUpdate({
                    strokeCapEnd: event.target.value as NonNullable<
                      CanvasNode["strokeCapEnd"]
                    >,
                  })
                }
              >
                <option value="none">None</option>
                <option value="round">Round</option>
                <option value="square">Square</option>
                <option value="arrowLines">Arrow lines</option>
                <option value="arrowEquilateral">Arrow</option>
                <option value="triangleFilled">Triangle</option>
                <option value="diamondFilled">Diamond</option>
                <option value="circleFilled">Circle</option>
              </select>
            </div>
          </label>
          {field("Opacity", "opacity", Math.round(node.opacity * 100), "%")}
        </section>
      ) : (
        supportsGenericAppearanceInspector(node.kind) && (
          <section>
            <h2>Appearance</h2>
            {node.assetId && (
              <div className="mb-2 grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border bg-muted/20 p-2 [&_strong]:block [&_strong]:truncate [&_strong]:text-xs [&_span]:block [&_span]:truncate [&_span]:text-[10px] [&_span]:text-muted-foreground [&_button]:h-7 [&_button]:rounded-lg [&_button]:border [&_button]:bg-background [&_button]:px-2 [&_button]:text-xs [&_button]:font-medium [&_button]:hover:bg-muted">
                <div className="size-7 rounded-md border bg-muted" />
                <div>
                  <strong>Image fill</strong>
                  <span>
                    {imageAsset?.pixelWidth && imageAsset?.pixelHeight
                      ? `${imageAsset.pixelWidth} × ${imageAsset.pixelHeight}`
                      : node.assetId.slice(0, 8)}
                  </span>
                </div>
                <button
                  type="button"
                  aria-label="Remove image fill"
                  disabled={readOnly}
                  onClick={() => onUpdate({ assetId: undefined })}
                >
                  Remove
                </button>
              </div>
            )}
            {node.fillGradient ? (
              <div className="mb-2 grid grid-cols-[28px_minmax(0,1fr)] items-center gap-2 rounded-lg border bg-muted/20 p-2 [&_strong]:block [&_strong]:truncate [&_strong]:text-xs [&_span]:block [&_span]:truncate [&_span]:text-[10px] [&_span]:text-muted-foreground [&>button]:col-span-full [&>button]:h-7 [&>button]:rounded-lg [&>button]:border [&>button]:bg-background [&>button]:px-2 [&>button]:text-xs [&>button]:font-medium [&>button]:hover:bg-muted [&>button:disabled]:opacity-50">
                <div
                  className="size-7 rounded-md border"
                  style={{ background: gradientCss }}
                />
                <div>
                  <strong>Linear gradient</strong>
                  <span>{node.fillGradient.stops.length} color stops</span>
                </div>
                <div
                  className="col-span-full grid grid-cols-3 gap-1 [&>button]:h-7 [&>button]:rounded-lg [&>button]:border [&>button]:bg-background [&>button]:px-1 [&>button]:text-[10px] [&>button]:font-medium [&>button]:hover:bg-muted [&>button][aria-pressed=true]:bg-accent [&>button][aria-pressed=true]:text-accent-foreground"
                  aria-label="Gradient direction"
                >
                  <button
                    type="button"
                    aria-pressed={sameDirection(
                      node.fillGradient,
                      [0, 0],
                      [1, 0],
                    )}
                    disabled={readOnly}
                    onClick={() => setGradientDirection([0, 0], [1, 0])}
                  >
                    Horizontal
                  </button>
                  <button
                    type="button"
                    aria-pressed={sameDirection(
                      node.fillGradient,
                      [0, 0],
                      [0, 1],
                    )}
                    disabled={readOnly}
                    onClick={() => setGradientDirection([0, 0], [0, 1])}
                  >
                    Vertical
                  </button>
                  <button
                    type="button"
                    aria-pressed={sameDirection(
                      node.fillGradient,
                      [0, 0],
                      [1, 1],
                    )}
                    disabled={readOnly}
                    onClick={() => setGradientDirection([0, 0], [1, 1])}
                  >
                    Diagonal
                  </button>
                </div>
                <div className="col-span-full grid gap-1.5">
                  {node.fillGradient.stops.map((stop, index) => (
                    <label
                      key={`${stop.position}-${index}`}
                      className="grid grid-cols-[38px_24px_minmax(0,1fr)_32px_20px] items-center gap-1 text-[10px] text-muted-foreground [&_input]:min-w-0 [&_input]:accent-primary [&_input[type=color]]:size-6 [&_input[type=color]]:rounded-md [&_input[type=color]]:border [&_button]:rounded-md [&_button]:hover:bg-muted [&_em]:not-italic"
                    >
                      <span>Stop {index + 1}</span>
                      <input
                        aria-label={`Gradient stop ${index + 1} color`}
                        disabled={readOnly}
                        type="color"
                        value={opaqueColorCss(stop.color)}
                        onChange={(event) =>
                          updateGradientColor(index, event.target.value)
                        }
                      />
                      <input
                        aria-label={`Gradient stop ${index + 1} position`}
                        disabled={readOnly}
                        type="range"
                        min={
                          index === 0
                            ? 0
                            : node.fillGradient!.stops[index - 1].position
                        }
                        max={
                          index === node.fillGradient!.stops.length - 1
                            ? 1
                            : node.fillGradient!.stops[index + 1].position
                        }
                        step="0.01"
                        value={stop.position}
                        onChange={(event) =>
                          updateGradientPosition(
                            index,
                            Number(event.target.value),
                          )
                        }
                      />
                      <em>{Math.round(stop.position * 100)}%</em>
                      <button
                        type="button"
                        aria-label={`Remove gradient stop ${index + 1}`}
                        disabled={
                          readOnly || node.fillGradient!.stops.length <= 2
                        }
                        onClick={() => removeGradientStop(index)}
                      >
                        −
                      </button>
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  aria-label="Add gradient stop"
                  disabled={readOnly || node.fillGradient.stops.length >= 16}
                  onClick={addGradientStop}
                >
                  Add stop
                </button>
                <button
                  type="button"
                  disabled={readOnly}
                  onClick={() => onUpdate({ fill: node.fill })}
                >
                  Replace with solid
                </button>
              </div>
            ) : (
              <>
                {field("Fill", "fill", node.fill)}
                <div
                  className="absolute right-5 size-4 -translate-y-8 rounded-md border"
                  style={{ background: node.fill }}
                />
                <button
                  className="mb-2 h-8 w-full rounded-lg border bg-background px-2 text-xs font-medium hover:bg-muted disabled:opacity-50"
                  type="button"
                  disabled={readOnly}
                  onClick={createGradient}
                >
                  Add linear gradient
                </button>
              </>
            )}
            {node.kind !== "text" && (
              <>
                {field("Stroke", "stroke", node.stroke)}
                {field("Stroke width", "strokeWidth", node.strokeWidth, "px")}
              </>
            )}
            {supportsCornerRadiusInspector(node.kind) &&
              field("Radius", "radius", node.radius ?? 0, "px")}
            {field("Opacity", "opacity", Math.round(node.opacity * 100), "%")}
          </section>
        )
      )}
      {supportsStrokeDetailsInspector(node.kind) && (
        <StrokeDetailsInspector
          node={node}
          onUpdate={onUpdate}
          readOnly={readOnly}
        />
      )}
      {supportsPaintStackInspector(node.kind) && (
        <PaintStackInspector
          node={node}
          onUpdate={onUpdate}
          readOnly={readOnly}
        />
      )}
      {hasActiveAutoLayoutConstraintOverride(sceneNodes, node) ? (
        <section>
          <h2>Constraints</h2>
          <p
            className="mb-2 text-xs leading-relaxed text-muted-foreground"
            role="status"
          >
            Auto layout owns this layer’s geometry. Existing constraints are
            preserved but not applied.
          </p>
        </section>
      ) : hasFrameConstraintScope(sceneNodes, node) ? (
        <FrameConstraintsInspector
          node={node}
          onUpdate={onUpdate}
          readOnly={readOnly}
        />
      ) : (
        node.constraints && (
          <section>
            <h2>Constraints</h2>
            <p
              className="mb-2 text-xs leading-relaxed text-muted-foreground"
              role="status"
            >
              Constraints are preserved but not applicable outside a Frame or
              through a non-Group ancestor.
            </p>
          </section>
        )
      )}
      {node.kind === "frame" && (
        <AutoLayoutInspector
          node={node}
          sceneNodes={sceneNodes}
          onUpdate={onUpdate}
          readOnly={readOnly}
        />
      )}
      {node.kind === "frame" && (
        <AutoLayoutFrameSizingInspector
          node={node}
          onUpdate={onUpdate}
          readOnly={readOnly}
        />
      )}
      {node.kind !== "frame" && (
        <AutoLayoutChildInspector
          node={node}
          sceneNodes={sceneNodes}
          onUpdate={onUpdate}
          readOnly={readOnly}
        />
      )}
      {supportsPerSideStrokeInspector(node.kind) && (
        <PerSideStrokeInspector
          node={node}
          onUpdate={onUpdate}
          readOnly={readOnly}
        />
      )}
      {supportsStrokeAlignInspector(node) && (
        <StrokeAlignInspector
          node={node}
          onUpdate={onUpdate}
          readOnly={readOnly}
        />
      )}
      {(node.kind === "frame" ||
        node.kind === "rectangle" ||
        node.kind === "section") && (
        <CornerRadiiInspector
          node={node}
          onUpdate={onUpdate}
          readOnly={readOnly}
        />
      )}
      {(node.kind === "frame" ||
        node.kind === "rectangle" ||
        node.kind === "section") && (
        <CornerSmoothingInspector
          node={node}
          onUpdate={onUpdate}
          readOnly={readOnly}
        />
      )}
      {node.kind === "ellipse" && (
        <EllipseArcInspector
          node={node}
          onUpdate={onUpdate}
          readOnly={readOnly}
        />
      )}
      {(node.kind === "polygon" || node.kind === "star") && (
        <ParametricShapeInspector
          node={node}
          onUpdate={onUpdate}
          readOnly={readOnly}
        />
      )}
      {node.kind === "vector" && (
        <VectorPathInspector
          node={node}
          onUpdate={onUpdate}
          onMovePoint={onMovePoint}
          onSetSubpathClosed={onSetSubpathClosed}
          onInsertPoint={onInsertPoint}
          onSplitSegment={onSplitSegment}
          onDeletePoint={onDeletePoint}
          onSetPointHandles={onSetPointHandles}
          readOnly={readOnly}
        />
      )}
      {node.kind === "booleanOperation" && (
        <BooleanOperationInspector
          node={node}
          sceneNodes={sceneNodes}
          onUpdate={onUpdate}
          readOnly={readOnly}
        />
      )}
      {node.kind === "text" && (
        <TextInspector
          node={node}
          assets={assets}
          fontAvailability={fontAvailability}
          onUpdate={onUpdate}
          readOnly={readOnly}
        />
      )}
      {node.kind !== "group" && node.kind !== "slice" && (
        <DropShadowInspector
          node={node}
          onUpdate={onUpdate}
          readOnly={readOnly}
        />
      )}
      {node.kind !== "group" && node.kind !== "slice" && (
        <LayerBlurInspector
          node={node}
          onUpdate={onUpdate}
          readOnly={readOnly}
        />
      )}
      {node.kind !== "group" && node.kind !== "slice" && (
        <InnerShadowInspector
          node={node}
          onUpdate={onUpdate}
          readOnly={readOnly}
        />
      )}
      {node.kind !== "group" && node.kind !== "slice" && (
        <BackgroundBlurInspector
          node={node}
          onUpdate={onUpdate}
          readOnly={readOnly}
        />
      )}
      {node.kind !== "group" && node.kind !== "slice" && (
        <EffectOrderInspector
          node={node}
          onUpdate={onUpdate}
          readOnly={readOnly}
        />
      )}
      <section>
        <h2>Layer</h2>
        {!["group", "slice"].includes(node.kind) && (
          <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
            <span>Blend mode</span>
            <div>
              <select
                aria-label="Blend mode"
                disabled={readOnly}
                value={node.blendMode ?? "normal"}
                onChange={(event) => {
                  const value = event.target.value;
                  if (
                    [
                      "normal",
                      "multiply",
                      "screen",
                      "overlay",
                      "darken",
                      "lighten",
                    ].includes(value)
                  )
                    onUpdate({
                      blendMode: value as NonNullable<CanvasNode["blendMode"]>,
                    });
                }}
              >
                <option value="normal">Normal</option>
                <option value="multiply">Multiply</option>
                <option value="screen">Screen</option>
                <option value="overlay">Overlay</option>
                <option value="darken">Darken</option>
                <option value="lighten">Lighten</option>
              </select>
            </div>
          </label>
        )}
        {node.kind === "frame" && (
          <label className="my-2 flex items-center gap-2 text-xs text-muted-foreground [&_input]:size-4 [&_input]:accent-primary">
            <input
              disabled={readOnly}
              type="checkbox"
              checked={node.clipsContent !== false}
              onChange={(event) =>
                onUpdate({ clipsContent: event.target.checked })
              }
            />
            Clip content
          </label>
        )}
        {!["group", "section", "booleanOperation", "slice"].includes(
          node.kind,
        ) && (
          <label className="my-2 flex items-center gap-2 text-xs text-muted-foreground [&_input]:size-4 [&_input]:accent-primary">
            <input
              aria-label="Use as alpha mask"
              disabled={readOnly}
              type="checkbox"
              checked={Boolean(node.isMask)}
              onChange={(event) => onSetMask(node.id, event.target.checked)}
            />
            Use as alpha mask
          </label>
        )}
        {node.kind === "section" && (
          <label className="my-2 flex items-center gap-2 text-xs text-muted-foreground [&_input]:size-4 [&_input]:accent-primary">
            <input
              disabled={readOnly}
              type="checkbox"
              checked={Boolean(node.contentsHidden)}
              onChange={(event) =>
                onUpdate({ contentsHidden: event.target.checked })
              }
            />
            Hide contents
          </label>
        )}
        <label className="my-2 flex items-center gap-2 text-xs text-muted-foreground [&_input]:size-4 [&_input]:accent-primary">
          <input
            disabled={readOnly}
            type="checkbox"
            checked={node.visible !== false}
            onChange={(event) => onUpdate({ visible: event.target.checked })}
          />
          Visible
        </label>
        <label className="my-2 flex items-center gap-2 text-xs text-muted-foreground [&_input]:size-4 [&_input]:accent-primary">
          <input
            disabled={readOnly}
            type="checkbox"
            checked={Boolean(node.locked)}
            onChange={(event) => onUpdate({ locked: event.target.checked })}
          />
          Lock editing
        </label>
      </section>
    </div>
  );
}

function BooleanOperationInspector({
  node,
  sceneNodes,
  onUpdate,
  readOnly,
}: {
  node: CanvasNode;
  sceneNodes: readonly CanvasNode[];
  onUpdate: (patch: Partial<CanvasNode>) => void;
  readOnly: boolean;
}) {
  const operation = node.booleanOperation ?? "union";
  const operands = sceneNodes.filter(
    (candidate) => candidate.parentId === node.id,
  ).length;
  return (
    <section>
      <h2>Boolean</h2>
      <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
        <span>Operation</span>
        <div>
          <select
            aria-label="Boolean operation"
            disabled={readOnly}
            value={operation}
            onChange={(event) => {
              const next = event.target.value;
              if (
                next === "union" ||
                next === "subtract" ||
                next === "intersect" ||
                next === "exclude"
              )
                onUpdate({ booleanOperation: next });
            }}
          >
            <option value="union">Union</option>
            <option value="subtract">Subtract</option>
            <option value="intersect">Intersect</option>
            <option value="exclude">Exclude</option>
          </select>
        </div>
      </label>
      <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
        {operands} editable operands · Canvas derives direct Vector operands
        through Rust/WASM.
      </p>
    </section>
  );
}

function DropShadowInspector({
  node,
  onUpdate,
  readOnly,
}: {
  node: CanvasNode;
  onUpdate: (patch: Partial<CanvasNode>) => void;
  readOnly: boolean;
}) {
  const shadows = node.effectStack?.length
    ? node.effectStack.flatMap((effect) =>
        effect.dropShadow ? [effect.dropShadow] : [],
      )
    : node.dropShadow
      ? [node.dropShadow]
      : [];
  const commit = (next: DocumentDropShadow[]) => {
    const current: DocumentEffect[] = node.effectStack?.length
      ? node.effectStack
      : node.dropShadow
        ? [{ dropShadow: node.dropShadow }]
        : [];
    let shadowIndex = 0;
    const retained = current.flatMap<DocumentEffect>((effect) => {
      if (!effect.dropShadow) return [effect];
      const shadow = next[shadowIndex++];
      return shadow ? [{ dropShadow: shadow } satisfies DocumentEffect] : [];
    });
    const stack: DocumentEffect[] = [
      ...retained,
      ...next
        .slice(shadowIndex)
        .map((dropShadow) => ({ dropShadow }) satisfies DocumentEffect),
    ];
    onUpdate({ dropShadow: stack[0]?.dropShadow, effectStack: stack });
  };
  const update = (index: number, patch: Partial<DocumentDropShadow>) =>
    commit(
      shadows.map((shadow, current) =>
        current === index ? { ...shadow, ...patch } : shadow,
      ),
    );
  const move = (index: number, direction: -1 | 1) => {
    const destination = index + direction;
    if (destination < 0 || destination >= shadows.length) return;
    const next = [...shadows];
    [next[index], next[destination]] = [next[destination], next[index]];
    commit(next);
  };
  const label = (index: number, name: string) =>
    index === 0 ? `Drop shadow ${name}` : `Drop shadow ${index + 1} ${name}`;
  const numberField = (
    index: number,
    shadow: DocumentDropShadow,
    title: string,
    key: "offsetX" | "offsetY" | "blurRadius" | "spread",
    minimum?: number,
  ) => (
    <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
      <span>{title}</span>
      <div>
        <input
          aria-label={label(index, title.toLowerCase())}
          disabled={readOnly}
          inputMode="decimal"
          value={shadow[key]}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (
              Number.isFinite(value) &&
              (minimum === undefined || value >= minimum)
            )
              update(index, { [key]: value });
          }}
        />
        <em>px</em>
      </div>
    </label>
  );
  return (
    <section>
      <h2>Effect stack</h2>
      <label className="my-2 flex items-center gap-2 text-xs text-muted-foreground [&_input]:size-4 [&_input]:accent-primary">
        <input
          aria-label="Drop shadow enabled"
          disabled={readOnly}
          type="checkbox"
          checked={shadows.length > 0}
          onChange={(event) =>
            commit(event.target.checked ? [defaultDropShadow()] : [])
          }
        />
        Enabled
      </label>
      {shadows.map((shadow, index) => (
        <fieldset
          key={`${index}-${shadow.offsetX}-${shadow.offsetY}-${shadow.blurRadius}`}
        >
          <legend>Drop shadow {index + 1}</legend>
          <div className="grid grid-cols-4 gap-1 [&>button]:h-7 [&>button]:rounded-lg [&>button]:border [&>button]:bg-background [&>button]:text-xs [&>button]:hover:bg-muted [&>button:disabled]:opacity-50">
            <button
              type="button"
              aria-label={`Move drop shadow ${index + 1} earlier`}
              disabled={readOnly || index === 0}
              onClick={() => move(index, -1)}
            >
              Move earlier
            </button>
            <button
              type="button"
              aria-label={`Move drop shadow ${index + 1} later`}
              disabled={readOnly || index === shadows.length - 1}
              onClick={() => move(index, 1)}
            >
              Move later
            </button>
          </div>
          <label className="my-2 flex items-center gap-2 text-xs text-muted-foreground [&_input]:size-4 [&_input]:accent-primary">
            <input
              aria-label={label(index, "visible")}
              disabled={readOnly}
              type="checkbox"
              checked={shadow.visible}
              onChange={(event) =>
                update(index, { visible: event.target.checked })
              }
            />
            Visible
          </label>
          <div className="grid grid-cols-2 gap-2">
            {numberField(index, shadow, "X", "offsetX")}
            {numberField(index, shadow, "Y", "offsetY")}
            {numberField(index, shadow, "Blur", "blurRadius", 0)}
            {numberField(index, shadow, "Spread", "spread")}
          </div>
          <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
            <span>Color</span>
            <div>
              <input
                aria-label={label(index, "color")}
                disabled={readOnly}
                type="color"
                value={opaqueColorCss(shadow.color)}
                onChange={(event) => {
                  const color = documentColorFromCssHex(event.target.value);
                  if (color)
                    update(index, {
                      color: { ...color, alpha: shadow.color.alpha },
                    });
                }}
              />
            </div>
          </label>
          <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
            <span>Opacity</span>
            <div>
              <input
                aria-label={label(index, "opacity")}
                disabled={readOnly}
                inputMode="decimal"
                value={Math.round(shadow.color.alpha * 100)}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value) && value >= 0 && value <= 100)
                    update(index, {
                      color: { ...shadow.color, alpha: value / 100 },
                    });
                }}
              />
              <em>%</em>
            </div>
          </label>
          {shadows.length > 1 && (
            <button
              type="button"
              aria-label={`Remove drop shadow ${index + 1}`}
              disabled={readOnly}
              onClick={() =>
                commit(shadows.filter((_, current) => current !== index))
              }
            >
              Remove
            </button>
          )}
        </fieldset>
      ))}
      <button
        type="button"
        aria-label="Add drop shadow"
        disabled={readOnly || shadows.length >= 8}
        onClick={() => commit([...shadows, defaultDropShadow()])}
      >
        Add drop shadow
      </button>
    </section>
  );
}

function LayerBlurInspector({
  node,
  onUpdate,
  readOnly,
}: {
  node: CanvasNode;
  onUpdate: (patch: Partial<CanvasNode>) => void;
  readOnly: boolean;
}) {
  const stack = node.effectStack?.length
    ? node.effectStack
    : node.dropShadow
      ? [{ dropShadow: node.dropShadow }]
      : [];
  const index = stack.findIndex((effect) => Boolean(effect.layerBlur));
  const blur = index >= 0 ? stack[index].layerBlur : undefined;
  const commit = (next: NonNullable<typeof blur> | undefined) => {
    const effectStack = next
      ? index >= 0
        ? stack.map((effect, current) =>
            current === index ? { layerBlur: next } : effect,
          )
        : [...stack, { layerBlur: next }]
      : stack.filter((_, current) => current !== index);
    onUpdate({ dropShadow: effectStack[0]?.dropShadow, effectStack });
  };
  return (
    <section>
      <h2>Layer blur</h2>
      <label className="my-2 flex items-center gap-2 text-xs text-muted-foreground [&_input]:size-4 [&_input]:accent-primary">
        <input
          aria-label="Layer blur enabled"
          disabled={readOnly}
          type="checkbox"
          checked={Boolean(blur)}
          onChange={(event) =>
            commit(
              event.target.checked ? { radius: 8, visible: true } : undefined,
            )
          }
        />
        Enabled
      </label>
      {blur && (
        <>
          <label className="my-2 flex items-center gap-2 text-xs text-muted-foreground [&_input]:size-4 [&_input]:accent-primary">
            <input
              aria-label="Layer blur visible"
              disabled={readOnly}
              type="checkbox"
              checked={blur.visible}
              onChange={(event) =>
                commit({ ...blur, visible: event.target.checked })
              }
            />
            Visible
          </label>
          <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
            <span>Radius</span>
            <div>
              <input
                aria-label="Layer blur radius"
                disabled={readOnly}
                inputMode="decimal"
                value={blur.radius}
                onChange={(event) => {
                  const radius = Number(event.target.value);
                  if (Number.isFinite(radius) && radius >= 0 && radius <= 256)
                    commit({ ...blur, radius });
                }}
              />
              <em>px</em>
            </div>
          </label>
        </>
      )}
    </section>
  );
}

function InnerShadowInspector({
  node,
  onUpdate,
  readOnly,
}: {
  node: CanvasNode;
  onUpdate: (patch: Partial<CanvasNode>) => void;
  readOnly: boolean;
}) {
  const stack = node.effectStack?.length
    ? node.effectStack
    : node.dropShadow
      ? [{ dropShadow: node.dropShadow }]
      : [];
  const index = stack.findIndex((effect) => Boolean(effect.innerShadow));
  const shadow = index >= 0 ? stack[index].innerShadow : undefined;
  const commit = (next: DocumentDropShadow | undefined) => {
    const effectStack = next
      ? index >= 0
        ? stack.map((effect, current) =>
            current === index ? { innerShadow: next } : effect,
          )
        : [...stack, { innerShadow: next }]
      : stack.filter((_, current) => current !== index);
    onUpdate({ dropShadow: effectStack[0]?.dropShadow, effectStack });
  };
  const number = (
    title: string,
    key: "offsetX" | "offsetY" | "blurRadius" | "spread",
    minimum?: number,
  ) =>
    shadow && (
      <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
        <span>{title}</span>
        <div>
          <input
            aria-label={`Inner shadow ${title.toLowerCase()}`}
            disabled={readOnly}
            inputMode="decimal"
            value={shadow[key]}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (
                Number.isFinite(value) &&
                (minimum === undefined || value >= minimum)
              )
                commit({ ...shadow, [key]: value });
            }}
          />
          <em>px</em>
        </div>
      </label>
    );
  return (
    <section>
      <h2>Inner shadow</h2>
      <label className="my-2 flex items-center gap-2 text-xs text-muted-foreground [&_input]:size-4 [&_input]:accent-primary">
        <input
          aria-label="Inner shadow enabled"
          disabled={readOnly}
          type="checkbox"
          checked={Boolean(shadow)}
          onChange={(event) =>
            commit(event.target.checked ? defaultDropShadow() : undefined)
          }
        />
        Enabled
      </label>
      {shadow && (
        <>
          <label className="my-2 flex items-center gap-2 text-xs text-muted-foreground [&_input]:size-4 [&_input]:accent-primary">
            <input
              aria-label="Inner shadow visible"
              disabled={readOnly}
              type="checkbox"
              checked={shadow.visible}
              onChange={(event) =>
                commit({ ...shadow, visible: event.target.checked })
              }
            />
            Visible
          </label>
          <div className="grid grid-cols-2 gap-2">
            {number("X", "offsetX")}
            {number("Y", "offsetY")}
            {number("Blur", "blurRadius", 0)}
            {number("Spread", "spread")}
          </div>
          <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
            <span>Color</span>
            <div>
              <input
                aria-label="Inner shadow color"
                disabled={readOnly}
                type="color"
                value={opaqueColorCss(shadow.color)}
                onChange={(event) => {
                  const color = documentColorFromCssHex(event.target.value);
                  if (color)
                    commit({
                      ...shadow,
                      color: { ...color, alpha: shadow.color.alpha },
                    });
                }}
              />
            </div>
          </label>
          <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
            <span>Opacity</span>
            <div>
              <input
                aria-label="Inner shadow opacity"
                disabled={readOnly}
                inputMode="decimal"
                value={Math.round(shadow.color.alpha * 100)}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value) && value >= 0 && value <= 100)
                    commit({
                      ...shadow,
                      color: { ...shadow.color, alpha: value / 100 },
                    });
                }}
              />
              <em>%</em>
            </div>
          </label>
        </>
      )}
    </section>
  );
}

function BackgroundBlurInspector({
  node,
  onUpdate,
  readOnly,
}: {
  node: CanvasNode;
  onUpdate: (patch: Partial<CanvasNode>) => void;
  readOnly: boolean;
}) {
  const stack = node.effectStack?.length
    ? node.effectStack
    : node.dropShadow
      ? [{ dropShadow: node.dropShadow }]
      : [];
  const index = stack.findIndex((effect) => Boolean(effect.backgroundBlur));
  const blur = index >= 0 ? stack[index].backgroundBlur : undefined;
  const commit = (next: NonNullable<typeof blur> | undefined) => {
    const effectStack = next
      ? index >= 0
        ? stack.map((effect, current) =>
            current === index ? { backgroundBlur: next } : effect,
          )
        : [...stack, { backgroundBlur: next }]
      : stack.filter((_, current) => current !== index);
    onUpdate({ dropShadow: effectStack[0]?.dropShadow, effectStack });
  };
  return (
    <section>
      <h2>Background blur</h2>
      <label className="my-2 flex items-center gap-2 text-xs text-muted-foreground [&_input]:size-4 [&_input]:accent-primary">
        <input
          aria-label="Background blur enabled"
          disabled={readOnly}
          type="checkbox"
          checked={Boolean(blur)}
          onChange={(event) =>
            commit(
              event.target.checked ? { radius: 8, visible: true } : undefined,
            )
          }
        />
        Enabled
      </label>
      {blur && (
        <>
          <label className="my-2 flex items-center gap-2 text-xs text-muted-foreground [&_input]:size-4 [&_input]:accent-primary">
            <input
              aria-label="Background blur visible"
              disabled={readOnly}
              type="checkbox"
              checked={blur.visible}
              onChange={(event) =>
                commit({ ...blur, visible: event.target.checked })
              }
            />
            Visible
          </label>
          <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
            <span>Radius</span>
            <div>
              <input
                aria-label="Background blur radius"
                disabled={readOnly}
                inputMode="decimal"
                value={blur.radius}
                onChange={(event) => {
                  const radius = Number(event.target.value);
                  if (Number.isFinite(radius) && radius >= 0 && radius <= 256)
                    commit({ ...blur, radius });
                }}
              />
              <em>px</em>
            </div>
          </label>
        </>
      )}
    </section>
  );
}

/** The inspector edits effects in dedicated controls, but their positions are
 * semantic: Canvas composes them in this exact order. Keep a separate, full
 * stack order control so effects of different kinds can move past each other
 * instead of making order an implementation detail of the Drop Shadow panel. */
function EffectOrderInspector({
  node,
  onUpdate,
  readOnly,
}: {
  node: CanvasNode;
  onUpdate: (patch: Partial<CanvasNode>) => void;
  readOnly: boolean;
}) {
  const stack: DocumentEffect[] = node.effectStack?.length
    ? node.effectStack
    : node.dropShadow
      ? [{ dropShadow: node.dropShadow }]
      : [];
  if (stack.length < 2) return null;
  const label = (effect: DocumentEffect) =>
    effect.dropShadow
      ? "Drop shadow"
      : effect.layerBlur
        ? "Layer blur"
        : effect.innerShadow
          ? "Inner shadow"
          : "Background blur";
  const move = (index: number, direction: -1 | 1) => {
    const destination = index + direction;
    if (destination < 0 || destination >= stack.length) return;
    const next = [...stack];
    [next[index], next[destination]] = [next[destination], next[index]];
    // `dropShadow` is the legacy projection of the first stack item. Updating
    // it together prevents a later snapshot/remote replay from reintroducing a
    // shadow that the canonical order intentionally moved behind another effect.
    onUpdate({ dropShadow: next[0]?.dropShadow, effectStack: next });
  };
  return (
    <section>
      <h2>Effect order</h2>
      <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
        Effects are composited from top to bottom.
      </p>
      {stack.map((effect, index) => (
        <div
          className="grid grid-cols-4 gap-1 [&>button]:h-7 [&>button]:rounded-lg [&>button]:border [&>button]:bg-background [&>button]:text-xs [&>button]:hover:bg-muted [&>button:disabled]:opacity-50"
          key={`${label(effect)}-${index}`}
        >
          <span>
            {index + 1}. {label(effect)}
          </span>
          <button
            type="button"
            aria-label={`Move ${label(effect)} ${index + 1} earlier`}
            disabled={readOnly || index === 0}
            onClick={() => move(index, -1)}
          >
            Move earlier
          </button>
          <button
            type="button"
            aria-label={`Move ${label(effect)} ${index + 1} later`}
            disabled={readOnly || index === stack.length - 1}
            onClick={() => move(index, 1)}
          >
            Move later
          </button>
        </div>
      ))}
    </section>
  );
}

function StrokeDetailsInspector({
  node,
  onUpdate,
  readOnly,
}: {
  node: CanvasNode;
  onUpdate: (patch: Partial<CanvasNode>) => void;
  readOnly: boolean;
}) {
  const canonicalDash = (node.strokeDashPattern ?? []).join(", ");
  return (
    <StrokeDetailsInspectorDraft
      key={`${node.id}:${canonicalDash}`}
      node={node}
      canonicalDash={canonicalDash}
      onUpdate={onUpdate}
      readOnly={readOnly}
    />
  );
}

function StrokeDetailsInspectorDraft({
  node,
  canonicalDash,
  onUpdate,
  readOnly,
}: {
  node: CanvasNode;
  canonicalDash: string;
  onUpdate: (patch: Partial<CanvasNode>) => void;
  readOnly: boolean;
}) {
  const [dash, setDash] = useState(canonicalDash);
  const commitDash = () => {
    const pattern = parseLineDashPattern(dash);
    if (!pattern) {
      setDash(canonicalDash);
      return;
    }
    onUpdate({ strokeDashPattern: pattern });
  };
  return (
    <section>
      <h2>Stroke details</h2>
      <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
        <span>Join</span>
        <div>
          <select
            aria-label="Stroke join"
            disabled={readOnly}
            value={node.strokeJoin ?? "miter"}
            onChange={(event) =>
              onUpdate({
                strokeJoin: event.target.value as NonNullable<
                  CanvasNode["strokeJoin"]
                >,
              })
            }
          >
            <option value="miter">Miter</option>
            <option value="bevel">Bevel</option>
            <option value="round">Round</option>
          </select>
        </div>
      </label>
      <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
        <span>Miter limit</span>
        <div>
          <input
            aria-label="Miter limit"
            disabled={readOnly}
            inputMode="decimal"
            value={node.strokeMiterLimit ?? 10}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isFinite(value) && value >= 1)
                onUpdate({ strokeMiterLimit: value });
            }}
          />
        </div>
      </label>
      <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
        <span>Dash</span>
        <div>
          <input
            aria-label="Stroke dash pattern"
            disabled={readOnly}
            placeholder="8, 4"
            value={dash}
            onChange={(event) => setDash(event.target.value)}
            onBlur={commitDash}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </div>
      </label>
    </section>
  );
}

function FrameConstraintsInspector({
  node,
  onUpdate,
  readOnly,
}: {
  node: CanvasNode;
  onUpdate: (patch: Partial<CanvasNode>) => void;
  readOnly: boolean;
}) {
  const constraints = node.constraints ?? {
    horizontal: "min" as const,
    vertical: "min" as const,
  };
  const update = (
    axis: "horizontal" | "vertical",
    value: typeof constraints.horizontal,
  ) => onUpdate({ constraints: { ...constraints, [axis]: value } });
  return (
    <section>
      <h2>Constraints</h2>
      <div className="grid grid-cols-2 gap-2">
        <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
          <span>Horizontal</span>
          <div>
            <select
              aria-label="Horizontal constraint"
              disabled={readOnly}
              value={constraints.horizontal}
              onChange={(event) =>
                update(
                  "horizontal",
                  event.target.value as typeof constraints.horizontal,
                )
              }
            >
              <option value="min">Left</option>
              <option value="center">Center</option>
              <option value="max">Right</option>
              <option value="stretch">Left &amp; right</option>
              <option value="scale">Scale</option>
            </select>
          </div>
        </label>
        <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
          <span>Vertical</span>
          <div>
            <select
              aria-label="Vertical constraint"
              disabled={readOnly}
              value={constraints.vertical}
              onChange={(event) =>
                update(
                  "vertical",
                  event.target.value as typeof constraints.vertical,
                )
              }
            >
              <option value="min">Top</option>
              <option value="center">Center</option>
              <option value="max">Bottom</option>
              <option value="stretch">Top &amp; bottom</option>
              <option value="scale">Scale</option>
            </select>
          </div>
        </label>
      </div>
      {node.constraints && (
        <button
          type="button"
          disabled={readOnly}
          onClick={() => onUpdate({ constraints: undefined })}
        >
          Remove constraints
        </button>
      )}
    </section>
  );
}

function AutoLayoutInspector({
  node,
  sceneNodes,
  onUpdate,
  readOnly,
}: {
  node: CanvasNode;
  sceneNodes: readonly CanvasNode[];
  onUpdate: (patch: Partial<CanvasNode>) => void;
  readOnly: boolean;
}) {
  const layout: DocumentAutoLayout = node.autoLayout ?? {
    ...defaultAutoLayout(),
    mode: "none",
  };
  const incompatibleChildren = sceneNodes.some(
    (child) => child.parentId === node.id && child.relativeTransform,
  );
  const wrapIncompatibleChildren = sceneNodes.some(
    (child) =>
      child.parentId === node.id &&
      ((child.autoLayout?.primarySizing ?? "fixed") !== "fixed" ||
        (child.autoLayout?.counterSizing ?? "fixed") !== "fixed"),
  );
  const wrapSupported =
    !incompatibleChildren &&
    !wrapIncompatibleChildren &&
    layout.primarySizing === "fixed" &&
    layout.counterSizing === "fixed";
  const counterAlignmentOptions =
    layout.mode === "horizontal"
      ? (["start", "center", "end", "baseline"] as const)
      : (["start", "center", "end"] as const);
  const update = (patch: Partial<DocumentAutoLayout>) =>
    onUpdate({ autoLayout: { ...layout, ...patch } });
  const padding = (index: number, value: number) => {
    const next = [...layout.padding] as DocumentAutoLayout["padding"];
    next[index] = value;
    update({ padding: next });
  };
  const numeric = (
    label: string,
    value: number,
    onChange: (value: number) => void,
  ) => (
    <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
      <span>{label}</span>
      <div>
        <input
          aria-label={`Auto layout ${label}`}
          disabled={readOnly || layout.mode === "none"}
          inputMode="decimal"
          value={value}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next) && next >= 0) onChange(next);
          }}
        />
        <em>px</em>
      </div>
    </label>
  );
  const select = <T extends string>(
    label: string,
    value: T,
    options: readonly T[],
    onChange: (value: T) => void,
  ) => (
    <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
      <span>{label}</span>
      <div>
        <select
          aria-label={`Auto layout ${label}`}
          disabled={readOnly}
          value={value}
          onChange={(event) => onChange(event.target.value as T)}
        >
          {options.map((option) => (
            <option key={option} value={option}>
              {option === "spaceBetween"
                ? "Space between"
                : option[0].toUpperCase() + option.slice(1)}
            </option>
          ))}
        </select>
      </div>
    </label>
  );
  return (
    <section>
      <h2>Auto layout</h2>
      {layout.mode === "none" ? (
        <button
          type="button"
          className="flex h-8 w-full items-center justify-between rounded-lg border bg-background px-2 text-xs font-medium hover:bg-muted disabled:opacity-50"
          disabled={readOnly}
          title="Add Auto layout (Shift+A)"
          onClick={() =>
            update({
              ...defaultAutoLayout(),
              mode: "vertical",
              absolute: false,
            })
          }
        >
          + Add Auto layout <kbd>⇧A</kbd>
        </button>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            {select(
              "Direction",
              layout.mode,
              ["horizontal", "vertical"] as const,
              (mode) =>
                update(
                  mode === "vertical" && layout.counterAlignment === "baseline"
                    ? { mode, counterAlignment: "start" }
                    : { mode },
                ),
            )}
            {select(
              "Primary alignment",
              layout.primaryAlignment,
              ["start", "center", "end", "spaceBetween"] as const,
              (primaryAlignment) => update({ primaryAlignment }),
            )}
            {select(
              "Counter alignment",
              layout.counterAlignment,
              counterAlignmentOptions,
              (counterAlignment) => update({ counterAlignment }),
            )}
            {numeric("Gap", layout.itemSpacing, (value) =>
              update({ itemSpacing: value }),
            )}
            {layout.wrap &&
              select(
                "Wrap track distribution",
                layout.trackAlignment ?? "auto",
                ["auto", "spaceBetween"] as const,
                (trackAlignment) =>
                  update({
                    trackAlignment:
                      trackAlignment === "auto" ? undefined : trackAlignment,
                  }),
              )}
            {layout.wrap &&
              (layout.trackAlignment ?? "auto") === "auto" &&
              numeric(
                "Wrap gap",
                layout.trackSpacing ?? layout.itemSpacing,
                (value) => update({ trackSpacing: value }),
              )}
            {numeric("Top padding", layout.padding[0], (value) =>
              padding(0, value),
            )}
            {numeric("Right padding", layout.padding[1], (value) =>
              padding(1, value),
            )}
            {numeric("Bottom padding", layout.padding[2], (value) =>
              padding(2, value),
            )}
            {numeric("Left padding", layout.padding[3], (value) =>
              padding(3, value),
            )}
          </div>
          <label className="my-2 flex items-center gap-2 text-xs text-muted-foreground [&_input]:size-4 [&_input]:accent-primary">
            <input
              aria-label="Auto layout wrap"
              disabled={readOnly || (!layout.wrap && !wrapSupported)}
              type="checkbox"
              checked={layout.wrap}
              onChange={(event) => update({ wrap: event.target.checked })}
            />
            Wrap items
          </label>
          {layout.wrap && layout.trackSpacing !== undefined && (
            <button
              type="button"
              disabled={readOnly}
              onClick={() => update({ trackSpacing: undefined })}
            >
              Use item gap between rows
            </button>
          )}
          <button
            type="button"
            className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground disabled:opacity-50"
            disabled={readOnly}
            onClick={() => update({ mode: "none" })}
          >
            Remove Auto layout
          </button>
        </>
      )}
      <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
        {incompatibleChildren
          ? "Adding Auto layout converts transformed flow children; absolute children keep their position."
          : !layout.wrap && !wrapSupported
            ? "Wrap is available for fixed-size Frames with fixed-size regular children."
            : "Fixed-size layout, Fill, Frame Hug, Frame Min/Max sizing, fixed-size wrapping, and auto-size Text Hug are available."}
      </p>
    </section>
  );
}

function AutoLayoutChildInspector({
  node,
  sceneNodes,
  onUpdate,
  readOnly,
}: {
  node: CanvasNode;
  sceneNodes: readonly CanvasNode[];
  onUpdate: (patch: Partial<CanvasNode>) => void;
  readOnly: boolean;
}) {
  const parent = node.parentId
    ? sceneNodes.find((candidate) => candidate.id === node.parentId)
    : undefined;
  const direction =
    parent?.kind === "frame" ? parent.autoLayout?.mode : undefined;
  if (direction !== "horizontal" && direction !== "vertical") return null;
  const layout: DocumentAutoLayout = node.autoLayout ?? {
    mode: "none",
    padding: [0, 0, 0, 0],
    itemSpacing: 0,
    wrap: false,
    primaryAlignment: "start",
    counterAlignment: "start",
    primarySizing: "fixed",
    counterSizing: "fixed",
    absolute: false,
  };
  const update = (patch: Partial<DocumentAutoLayout>) =>
    onUpdate({ autoLayout: { ...layout, ...patch } });
  const canHug = (key: "primarySizing" | "counterSizing") => {
    if (node.kind !== "text") return false;
    const autoSize = node.textProperties?.autoSize ?? "fixed";
    const axis =
      key === "primarySizing"
        ? direction
        : direction === "horizontal"
          ? "vertical"
          : "horizontal";
    return (
      autoSize === "widthAndHeight" ||
      (autoSize === "height" && axis === "vertical")
    );
  };
  const sizing = (
    label: string,
    value: DocumentAutoLayout["primarySizing"],
    key: "primarySizing" | "counterSizing",
  ) => (
    <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
      <span>{label}</span>
      <div>
        <select
          aria-label={`Auto layout ${label}`}
          disabled={readOnly || Boolean(parent?.autoLayout?.wrap)}
          value={value}
          onChange={(event) => {
            const next = event.target.value;
            if (
              next === "fixed" ||
              next === "fill" ||
              (next === "hug" && canHug(key))
            )
              update({ [key]: next });
          }}
        >
          <option value="fixed">Fixed</option>
          <option value="fill">Fill</option>
          {canHug(key) && <option value="hug">Hug contents</option>}
        </select>
      </div>
    </label>
  );
  const bound = (
    label: string,
    key: "minWidth" | "maxWidth" | "minHeight" | "maxHeight",
  ) => (
    <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
      <span>{label}</span>
      <div>
        <input
          aria-label={`Auto layout ${label}`}
          disabled={readOnly}
          inputMode="decimal"
          value={layout[key] ?? ""}
          onChange={(event) => {
            const raw = event.target.value.trim();
            const value = Number(raw);
            if (!raw || (Number.isFinite(value) && value >= 0))
              update({ [key]: raw ? value : undefined });
          }}
        />
        <em>px</em>
      </div>
    </label>
  );
  return (
    <section>
      <h2>Auto layout child</h2>
      <div className="grid grid-cols-2 gap-2">
        {sizing(
          direction === "horizontal" ? "Horizontal sizing" : "Vertical sizing",
          layout.primarySizing,
          "primarySizing",
        )}
        {sizing(
          direction === "horizontal" ? "Vertical sizing" : "Horizontal sizing",
          layout.counterSizing,
          "counterSizing",
        )}
        {bound("Minimum width", "minWidth")}
        {bound("Maximum width", "maxWidth")}
        {bound("Minimum height", "minHeight")}
        {bound("Maximum height", "maxHeight")}
      </div>
      <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
        <span>Align self</span>
        <div>
          <select
            aria-label="Auto layout align self"
            disabled={readOnly || layout.absolute}
            value={layout.alignSelf ?? "inherit"}
            onChange={(event) => {
              const value = event.target.value;
              update({
                alignSelf:
                  value === "inherit"
                    ? undefined
                    : (value as "start" | "center" | "end"),
              });
            }}
          >
            <option value="inherit">Inherit</option>
            <option value="start">Start</option>
            <option value="center">Center</option>
            <option value="end">End</option>
          </select>
        </div>
      </label>
      <label className="my-2 flex items-center gap-2 text-xs text-muted-foreground [&_input]:size-4 [&_input]:accent-primary">
        <input
          aria-label="Auto layout absolute position"
          disabled={readOnly}
          type="checkbox"
          checked={layout.absolute}
          onChange={(event) => update({ absolute: event.target.checked })}
        />
        Absolute position
      </label>
      <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
        Auto-size Text nodes can Hug their supported axis. Wrap uses fixed-size
        regular children.
      </p>
    </section>
  );
}

function AutoLayoutFrameSizingInspector({
  node,
  onUpdate,
  readOnly,
}: {
  node: CanvasNode;
  onUpdate: (patch: Partial<CanvasNode>) => void;
  readOnly: boolean;
}) {
  const layout: DocumentAutoLayout = node.autoLayout ?? {
    mode: "none",
    padding: [0, 0, 0, 0],
    itemSpacing: 0,
    wrap: false,
    primaryAlignment: "start",
    counterAlignment: "start",
    primarySizing: "fixed",
    counterSizing: "fixed",
    absolute: false,
  };
  if (layout.mode === "none") return null;
  const update = (patch: Partial<DocumentAutoLayout>) =>
    onUpdate({ autoLayout: { ...layout, ...patch } });
  const sizing = (label: string, key: "primarySizing" | "counterSizing") => (
    <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
      <span>{label}</span>
      <div>
        <select
          aria-label={`Auto layout frame ${label}`}
          disabled={readOnly || layout.wrap}
          value={layout[key]}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "fixed" || value === "hug") update({ [key]: value });
          }}
        >
          <option value="fixed">Fixed</option>
          <option value="hug">Hug contents</option>
        </select>
      </div>
    </label>
  );
  const bound = (
    label: string,
    key: "minWidth" | "maxWidth" | "minHeight" | "maxHeight",
  ) => (
    <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
      <span>{label}</span>
      <div>
        <input
          aria-label={`Auto layout ${label}`}
          disabled={readOnly}
          inputMode="decimal"
          value={layout[key] ?? ""}
          onChange={(event) => {
            const raw = event.target.value.trim();
            const value = Number(raw);
            if (!raw || (Number.isFinite(value) && value >= 0))
              update({ [key]: raw ? value : undefined });
          }}
        />
        <em>px</em>
      </div>
    </label>
  );
  return (
    <section>
      <h2>Auto layout sizing</h2>
      <div className="grid grid-cols-2 gap-2">
        {sizing(
          "Width sizing",
          autoLayoutSizingKeyForAxis(layout.mode, "width"),
        )}
        {sizing(
          "Height sizing",
          autoLayoutSizingKeyForAxis(layout.mode, "height"),
        )}
        {bound("Minimum width", "minWidth")}
        {bound("Maximum width", "maxWidth")}
        {bound("Minimum height", "minHeight")}
        {bound("Maximum height", "maxHeight")}
      </div>
    </section>
  );
}

function PaintStackInspector({
  node,
  onUpdate,
  readOnly,
}: {
  node: CanvasNode;
  onUpdate: (patch: Partial<CanvasNode>) => void;
  readOnly: boolean;
}) {
  const paintStack = (key: "fills" | "strokes") => node[key] ?? [];
  const updateStack = (
    key: "fills" | "strokes",
    paints: DocumentPaint[] | undefined,
  ) => onUpdate({ [key]: paints } as Partial<CanvasNode>);
  const renderStack = (kind: "fill" | "stroke") => {
    const key = kind === "fill" ? "fills" : "strokes";
    const legacy = kind === "fill" ? node.fill : node.stroke;
    const paints = paintStack(key);
    const title = kind === "fill" ? "Fill layers" : "Stroke layers";
    const singular = kind === "fill" ? "fill" : "stroke";
    const updatePaint = (index: number, next: DocumentPaint) =>
      updateStack(
        key,
        paints.map((paint, paintIndex) =>
          paintIndex === index ? next : paint,
        ),
      );
    const paintColor = (paint: DocumentPaint): DocumentColor =>
      paint.color ??
      documentColorFromCssHex(paint.css) ?? {
        space: "srgb",
        components: [0, 0, 0],
        alpha: 1,
      };
    const updateSolid = (index: number, paint: DocumentPaint, css: string) => {
      const color = documentColorFromCssHex(css);
      if (!color) return;
      updatePaint(index, { ...paint, css, color, gradient: undefined });
    };
    const updateGradient = (
      index: number,
      paint: DocumentPaint,
      gradient: DocumentLinearGradient,
    ) =>
      updatePaint(index, {
        ...paint,
        css: colorCss(gradient.stops[0].color),
        color: gradient.stops[0].color,
        gradient,
      });
    const addGradientStop = (index: number, paint: DocumentPaint) => {
      const gradient = paint.gradient;
      if (!gradient || gradient.stops.length >= 16) return;
      let insertion = 0;
      let largestGap = -1;
      for (
        let stopIndex = 0;
        stopIndex < gradient.stops.length - 1;
        stopIndex += 1
      ) {
        const gap =
          gradient.stops[stopIndex + 1].position -
          gradient.stops[stopIndex].position;
        if (gap > largestGap) {
          largestGap = gap;
          insertion = stopIndex;
        }
      }
      if (largestGap <= 0) return;
      const left = gradient.stops[insertion];
      const nextStop = {
        position: left.position + largestGap / 2,
        color: structuredClone(left.color),
      };
      updateGradient(index, paint, {
        ...gradient,
        stops: [
          ...gradient.stops.slice(0, insertion + 1),
          nextStop,
          ...gradient.stops.slice(insertion + 1),
        ],
      });
    };
    return (
      <div
        className="grid gap-1.5 rounded-lg border bg-muted/20 p-2 [&_button]:h-7 [&_button]:rounded-lg [&_button]:border [&_button]:bg-background [&_button]:px-2 [&_button]:text-[10px] [&_button]:font-medium [&_button]:hover:bg-muted [&_button:disabled]:opacity-50"
        key={key}
      >
        <div className="flex items-center justify-between gap-2 text-xs font-medium [&_span]:text-[10px] [&_span]:text-muted-foreground">
          <strong>{title}</strong>
          <span>
            {paints.length ? `${paints.length} layers` : "Single value"}
          </span>
        </div>
        {paints.length > 0 && (
          <div className="grid gap-1.5">
            {paints.map((paint, index) => {
              const gradient = paint.gradient;
              const layerLabel = `${title} ${index + 1}`;
              return (
                <div
                  className="grid gap-1.5 rounded-lg border bg-background p-1.5"
                  key={`${index}-${paint.css}`}
                >
                  <div className="grid grid-cols-[16px_minmax(0,1fr)_24px] items-center gap-1 [&>span]:text-center [&>span]:text-[10px] [&>span]:text-muted-foreground [&_select]:h-7 [&_select]:min-w-0 [&_select]:rounded-md [&_select]:border [&_select]:bg-background [&_select]:px-1 [&_select]:text-[10px]">
                    <span>{index + 1}</span>
                    <select
                      aria-label={`${layerLabel} type`}
                      disabled={readOnly}
                      value={gradient ? "gradient" : "solid"}
                      onChange={(event) => {
                        if (event.target.value === "gradient") {
                          const color = paintColor(paint);
                          updateGradient(
                            index,
                            paint,
                            createDefaultLinearGradient(color),
                          );
                        } else if (gradient) {
                          const color = gradient.stops[0].color;
                          updatePaint(index, {
                            ...paint,
                            css: colorCss(color),
                            color,
                            gradient: undefined,
                          });
                        }
                      }}
                    >
                      <option value="solid">Solid</option>
                      <option value="gradient">Linear gradient</option>
                    </select>
                    <button
                      type="button"
                      aria-label={`Remove ${singular} layer ${index + 1}`}
                      disabled={readOnly || paints.length <= 1}
                      onClick={() =>
                        updateStack(
                          key,
                          paints.filter(
                            (_, paintIndex) => paintIndex !== index,
                          ),
                        )
                      }
                    >
                      −
                    </button>
                  </div>
                  {gradient ? (
                    <div className="grid grid-cols-[24px_minmax(0,1fr)] items-start gap-1.5">
                      <div
                        className="mt-0.5 size-6 rounded-md border"
                        style={{ background: gradientCss(gradient) }}
                      />
                      <div
                        className="col-span-full grid grid-cols-3 gap-1 [&>button]:h-7 [&>button]:rounded-lg [&>button]:border [&>button]:bg-background [&>button]:px-1 [&>button]:text-[10px] [&>button]:font-medium [&>button]:hover:bg-muted [&>button][aria-pressed=true]:bg-accent [&>button][aria-pressed=true]:text-accent-foreground"
                        aria-label={`${layerLabel} direction`}
                      >
                        <button
                          type="button"
                          aria-pressed={sameDirection(gradient, [0, 0], [1, 0])}
                          disabled={readOnly}
                          onClick={() =>
                            updateGradient(index, paint, {
                              ...gradient,
                              start: [0, 0],
                              end: [1, 0],
                            })
                          }
                        >
                          Horizontal
                        </button>
                        <button
                          type="button"
                          aria-pressed={sameDirection(gradient, [0, 0], [0, 1])}
                          disabled={readOnly}
                          onClick={() =>
                            updateGradient(index, paint, {
                              ...gradient,
                              start: [0, 0],
                              end: [0, 1],
                            })
                          }
                        >
                          Vertical
                        </button>
                        <button
                          type="button"
                          aria-pressed={sameDirection(gradient, [0, 0], [1, 1])}
                          disabled={readOnly}
                          onClick={() =>
                            updateGradient(index, paint, {
                              ...gradient,
                              start: [0, 0],
                              end: [1, 1],
                            })
                          }
                        >
                          Diagonal
                        </button>
                      </div>
                      <div className="col-span-full grid gap-1.5">
                        {gradient.stops.map((stop, stopIndex) => (
                          <label
                            key={`${stop.position}-${stopIndex}`}
                            className="grid grid-cols-[38px_24px_minmax(0,1fr)_32px_20px] items-center gap-1 text-[10px] text-muted-foreground [&_input]:min-w-0 [&_input]:accent-primary [&_input[type=color]]:size-6 [&_input[type=color]]:rounded-md [&_input[type=color]]:border [&_button]:rounded-md [&_button]:hover:bg-muted [&_em]:not-italic"
                          >
                            <span>Stop {stopIndex + 1}</span>
                            <input
                              aria-label={`${layerLabel} gradient stop ${stopIndex + 1} color`}
                              disabled={readOnly}
                              type="color"
                              value={opaqueColorCss(stop.color)}
                              onChange={(event) => {
                                const color = documentColorFromCssHex(
                                  event.target.value,
                                );
                                if (color)
                                  updateGradient(index, paint, {
                                    ...gradient,
                                    stops: gradient.stops.map(
                                      (current, currentIndex) =>
                                        currentIndex === stopIndex
                                          ? {
                                              ...current,
                                              color: {
                                                ...color,
                                                alpha: current.color.alpha,
                                              },
                                            }
                                          : current,
                                    ),
                                  });
                              }}
                            />
                            <input
                              aria-label={`${layerLabel} gradient stop ${stopIndex + 1} position`}
                              disabled={readOnly}
                              type="range"
                              min={
                                stopIndex === 0
                                  ? 0
                                  : gradient.stops[stopIndex - 1].position
                              }
                              max={
                                stopIndex === gradient.stops.length - 1
                                  ? 1
                                  : gradient.stops[stopIndex + 1].position
                              }
                              step="0.01"
                              value={stop.position}
                              onChange={(event) => {
                                const lower =
                                  stopIndex === 0
                                    ? 0
                                    : gradient.stops[stopIndex - 1].position;
                                const upper =
                                  stopIndex === gradient.stops.length - 1
                                    ? 1
                                    : gradient.stops[stopIndex + 1].position;
                                const position = Math.max(
                                  lower,
                                  Math.min(upper, Number(event.target.value)),
                                );
                                updateGradient(index, paint, {
                                  ...gradient,
                                  stops: gradient.stops.map(
                                    (current, currentIndex) =>
                                      currentIndex === stopIndex
                                        ? { ...current, position }
                                        : current,
                                  ),
                                });
                              }}
                            />
                            <em>{Math.round(stop.position * 100)}%</em>
                            <button
                              type="button"
                              aria-label={`Remove ${layerLabel} gradient stop ${stopIndex + 1}`}
                              disabled={readOnly || gradient.stops.length <= 2}
                              onClick={() =>
                                updateGradient(index, paint, {
                                  ...gradient,
                                  stops: gradient.stops.filter(
                                    (_, currentIndex) =>
                                      currentIndex !== stopIndex,
                                  ),
                                })
                              }
                            >
                              −
                            </button>
                          </label>
                        ))}
                      </div>
                      <button
                        type="button"
                        className="col-span-full justify-self-start"
                        aria-label={`Add ${layerLabel} gradient stop`}
                        disabled={readOnly || gradient.stops.length >= 16}
                        onClick={() => addGradientStop(index, paint)}
                      >
                        Add stop
                      </button>
                    </div>
                  ) : (
                    <label className="grid grid-cols-[36px_minmax(0,1fr)_24px] items-center gap-1 text-[10px] text-muted-foreground [&_input]:h-7 [&_input]:min-w-0 [&_input]:rounded-md [&_input]:border [&_input]:bg-background [&_input]:px-1 [&_input]:text-[10px] [&_input[type=color]]:size-6 [&_input[type=color]]:p-0">
                      <span>Color</span>
                      <input
                        aria-label={layerLabel}
                        disabled={readOnly}
                        value={paint.css}
                        onChange={(event) =>
                          updateSolid(index, paint, event.target.value)
                        }
                      />
                      <input
                        aria-label={`${layerLabel} color`}
                        disabled={readOnly}
                        type="color"
                        value={opaqueColorCss(paintColor(paint))}
                        onChange={(event) =>
                          updateSolid(index, paint, event.target.value)
                        }
                      />
                    </label>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className="flex gap-1">
          {paints.length === 0 ? (
            <button
              type="button"
              disabled={readOnly}
              onClick={() =>
                updateStack(key, [
                  { css: legacy, color: documentColorFromCssHex(legacy) },
                ])
              }
            >
              Create {singular} stack
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={readOnly || paints.length >= 16}
                onClick={() =>
                  updateStack(key, [
                    ...paints,
                    structuredClone(paints[paints.length - 1]),
                  ])
                }
              >
                Add layer
              </button>
              <button
                type="button"
                disabled={readOnly}
                onClick={() => updateStack(key, undefined)}
              >
                Use single {singular}
              </button>
            </>
          )}
        </div>
      </div>
    );
  };
  return (
    <section className="grid gap-2">
      <h2>Paint layers</h2>
      {node.kind !== "line" && renderStack("fill")}
      {renderStack("stroke")}
    </section>
  );
}

function PerSideStrokeInspector({
  node,
  onUpdate,
  readOnly,
}: {
  node: CanvasNode;
  onUpdate: (patch: Partial<CanvasNode>) => void;
  readOnly: boolean;
}) {
  const weights =
    node.strokeWeights ??
    ([
      node.strokeWidth,
      node.strokeWidth,
      node.strokeWidth,
      node.strokeWidth,
    ] as [number, number, number, number]);
  const updateWeight = (index: number, value: string) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    const next = [...weights] as [number, number, number, number];
    next[index] = parsed;
    onUpdate({ strokeWeights: next });
  };
  return (
    <section>
      <h2>Stroke weights</h2>
      <div className="grid grid-cols-2 gap-2">
        {(["Top", "Right", "Bottom", "Left"] as const).map((label, index) => (
          <label
            className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground"
            key={label}
          >
            <span>{label}</span>
            <div>
              <input
                aria-label={`${label} stroke weight`}
                disabled={readOnly}
                inputMode="decimal"
                value={weights[index]}
                onChange={(event) => updateWeight(index, event.target.value)}
              />
              <em>px</em>
            </div>
          </label>
        ))}
      </div>
      <button
        type="button"
        disabled={readOnly || !node.strokeWeights}
        onClick={() => onUpdate({ strokeWeights: undefined })}
      >
        Use uniform width
      </button>
    </section>
  );
}

function StrokeAlignInspector({
  node,
  onUpdate,
  readOnly,
}: {
  node: CanvasNode;
  onUpdate: (patch: Partial<CanvasNode>) => void;
  readOnly: boolean;
}) {
  return (
    <section>
      <h2>Stroke align</h2>
      <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
        <span>Align</span>
        <div>
          <select
            aria-label="Stroke align"
            disabled={readOnly}
            value={node.strokeAlign ?? "inside"}
            onChange={(event) =>
              onUpdate({
                strokeAlign: event.target.value as NonNullable<
                  CanvasNode["strokeAlign"]
                >,
              })
            }
          >
            <option value="inside">Inside</option>
            <option value="center">Center</option>
            <option value="outside">Outside</option>
          </select>
        </div>
      </label>
    </section>
  );
}

function CornerRadiiInspector({
  node,
  onUpdate,
  readOnly,
}: {
  node: CanvasNode;
  onUpdate: (patch: Partial<CanvasNode>) => void;
  readOnly: boolean;
}) {
  const radii =
    node.cornerRadii ??
    ([node.radius, node.radius, node.radius, node.radius] as [
      number,
      number,
      number,
      number,
    ]);
  const updateRadius = (index: number, raw: string) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return;
    const next = [...radii] as [number, number, number, number];
    next[index] = value;
    onUpdate({ cornerRadii: next });
  };
  return (
    <section>
      <h2>Independent corners</h2>
      <div className="grid grid-cols-2 gap-2">
        {(
          ["Top left", "Top right", "Bottom right", "Bottom left"] as const
        ).map((label, index) => (
          <label
            className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground"
            key={label}
          >
            <span>{label}</span>
            <div>
              <input
                aria-label={`${label} corner radius`}
                disabled={readOnly}
                inputMode="decimal"
                value={radii[index]}
                onChange={(event) => updateRadius(index, event.target.value)}
              />
              <em>px</em>
            </div>
          </label>
        ))}
      </div>
      <button
        type="button"
        disabled={readOnly || !node.cornerRadii}
        onClick={() => onUpdate({ cornerRadii: undefined })}
      >
        Use uniform radius
      </button>
    </section>
  );
}

function CornerSmoothingInspector({
  node,
  onUpdate,
  readOnly,
}: {
  node: CanvasNode;
  onUpdate: (patch: Partial<CanvasNode>) => void;
  readOnly: boolean;
}) {
  const smoothing = node.cornerSmoothing ?? 0;
  return (
    <section>
      <h2>Corner smoothing</h2>
      <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
        <span>Amount</span>
        <div>
          <input
            aria-label="Corner smoothing"
            disabled={readOnly}
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={smoothing}
            onChange={(event) =>
              onUpdate({ cornerSmoothing: Number(event.target.value) })
            }
          />
          <em>{Math.round(smoothing * 100)}%</em>
        </div>
      </label>
      <button
        type="button"
        disabled={readOnly || smoothing === 0}
        onClick={() => onUpdate({ cornerSmoothing: undefined })}
      >
        Use circular corners
      </button>
    </section>
  );
}

function EllipseArcInspector({
  node,
  onUpdate,
  readOnly,
}: {
  node: CanvasNode;
  onUpdate: (patch: Partial<CanvasNode>) => void;
  readOnly: boolean;
}) {
  const arc = node.arcData ?? {
    startingAngle: 0,
    endingAngle: 360,
    innerRadius: 0,
  };
  const update = (key: keyof typeof arc, raw: string) => {
    const value = Number(raw);
    if (
      !Number.isFinite(value) ||
      (key === "innerRadius" && (value < 0 || value > 1))
    )
      return;
    onUpdate(ellipseArcUpdatePatch(node, { [key]: value }));
  };
  return (
    <section>
      <h2>Arc</h2>
      <div className="grid grid-cols-2 gap-2">
        <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
          <span>Start</span>
          <div>
            <input
              aria-label="Arc start angle"
              disabled={readOnly}
              inputMode="decimal"
              value={arc.startingAngle}
              onChange={(event) => update("startingAngle", event.target.value)}
            />
            <em>°</em>
          </div>
        </label>
        <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
          <span>End</span>
          <div>
            <input
              aria-label="Arc end angle"
              disabled={readOnly}
              inputMode="decimal"
              value={arc.endingAngle}
              onChange={(event) => update("endingAngle", event.target.value)}
            />
            <em>°</em>
          </div>
        </label>
        <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
          <span>Inner</span>
          <div>
            <input
              aria-label="Arc inner radius"
              disabled={readOnly}
              inputMode="decimal"
              value={arc.innerRadius}
              onChange={(event) => update("innerRadius", event.target.value)}
            />
          </div>
        </label>
      </div>
      <button
        type="button"
        disabled={readOnly || !node.arcData}
        onClick={() => onUpdate({ arcData: undefined })}
      >
        Reset ellipse
      </button>
    </section>
  );
}

function ParametricShapeInspector({
  node,
  onUpdate,
  readOnly,
}: {
  node: CanvasNode;
  onUpdate: (patch: Partial<CanvasNode>) => void;
  readOnly: boolean;
}) {
  const shape = node.parametricShape;
  if (!shape) return null;
  const pointCount = (raw: string) => {
    const value = Number(raw);
    if (Number.isInteger(value) && value >= 3 && value <= 100)
      onUpdate({ parametricShape: { ...shape, pointCount: value } });
  };
  const innerRatio = (raw: string) => {
    const value = Number(raw);
    if (
      shape.kind === "star" &&
      Number.isFinite(value) &&
      value >= 0.05 &&
      value <= 0.95
    )
      onUpdate({ parametricShape: { ...shape, innerRatio: value } });
  };
  return (
    <section>
      <h2>{shape.kind === "polygon" ? "Polygon" : "Star"}</h2>
      <div className="grid grid-cols-2 gap-2">
        <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
          <span>Points</span>
          <div>
            <input
              aria-label="Shape point count"
              disabled={readOnly}
              inputMode="numeric"
              value={shape.pointCount}
              onChange={(event) => pointCount(event.target.value)}
            />
          </div>
        </label>
        {shape.kind === "star" && (
          <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
            <span>Inner ratio</span>
            <div>
              <input
                aria-label="Star inner ratio"
                disabled={readOnly}
                inputMode="decimal"
                value={shape.innerRatio}
                onChange={(event) => innerRatio(event.target.value)}
              />
            </div>
          </label>
        )}
      </div>
    </section>
  );
}

function VectorPathInspector({
  node,
  onUpdate,
  onMovePoint,
  onSetSubpathClosed,
  onInsertPoint,
  onSplitSegment,
  onDeletePoint,
  onSetPointHandles,
  readOnly,
}: {
  node: CanvasNode;
  onUpdate: (patch: Partial<CanvasNode>) => void;
  onMovePoint: (id: string, pointId: string, x: number, y: number) => void;
  onSetSubpathClosed: (
    id: string,
    subpathIndex: number,
    closed: boolean,
  ) => void;
  onInsertPoint: (
    id: string,
    subpathIndex: number,
    afterPointId: string | undefined,
    point: NonNullable<
      CanvasNode["vectorPath"]
    >["subpaths"][number]["points"][number],
  ) => void;
  onSplitSegment: (
    id: string,
    subpathIndex: number,
    afterPointId: string,
    t: number,
    pointId: string,
  ) => void;
  onDeletePoint: (id: string, pointId: string) => void;
  onSetPointHandles: (
    id: string,
    pointId: string,
    handleIn: { x: number; y: number } | undefined,
    handleOut: { x: number; y: number } | undefined,
    pointType: NonNullable<
      CanvasNode["vectorPath"]
    >["subpaths"][number]["points"][number]["pointType"],
  ) => void;
  readOnly: boolean;
}) {
  const [selectedPointId, setSelectedPointId] = useState("");
  const path = node.vectorPath;
  if (!path) return null;
  const points = path.subpaths.flatMap((subpath, subpathIndex) =>
    subpath.points.map((point, pointIndex) => ({
      point,
      subpathIndex,
      pointIndex,
    })),
  );
  const selectedPoint =
    points.find(({ point }) => point.id === selectedPointId) ?? points[0];
  const updateCoordinate = (axis: "x" | "y", raw: string) => {
    const value = Number(raw);
    if (!selectedPoint || !Number.isFinite(value)) return;
    onMovePoint(
      node.id,
      selectedPoint.point.id,
      axis === "x" ? value : selectedPoint.point.x,
      axis === "y" ? value : selectedPoint.point.y,
    );
  };
  const insertAfterSelected = () => {
    if (!selectedPoint) return;
    const subpath = path.subpaths[selectedPoint.subpathIndex];
    const next =
      subpath.points[selectedPoint.pointIndex + 1] ??
      (subpath.closed ? subpath.points[0] : undefined);
    const x = next
      ? (selectedPoint.point.x + next.x) / 2
      : selectedPoint.point.x + 20;
    const y = next
      ? (selectedPoint.point.y + next.y) / 2
      : selectedPoint.point.y;
    onInsertPoint(node.id, selectedPoint.subpathIndex, selectedPoint.point.id, {
      id: createId(),
      x,
      y,
      pointType: "corner",
    });
  };
  const splitSelectedSegment = () => {
    if (!selectedPoint) return;
    const subpath = path.subpaths[selectedPoint.subpathIndex];
    if (
      selectedPoint.pointIndex + 1 >= subpath.points.length &&
      !subpath.closed
    )
      return;
    onSplitSegment(
      node.id,
      selectedPoint.subpathIndex,
      selectedPoint.point.id,
      0.5,
      createId(),
    );
  };
  const canDeleteSelected = Boolean(
    selectedPoint &&
    path.subpaths[selectedPoint.subpathIndex].points.length >
      (path.subpaths[selectedPoint.subpathIndex].closed ? 3 : 1),
  );
  const setHandles = (
    handleIn: { x: number; y: number } | undefined,
    handleOut: { x: number; y: number } | undefined,
    pointType = selectedPoint?.point.pointType,
  ) =>
    selectedPoint &&
    onSetPointHandles(
      node.id,
      selectedPoint.point.id,
      handleIn,
      handleOut,
      pointType ?? "corner",
    );
  return (
    <section>
      <h2>Vector path</h2>
      <div className="grid grid-cols-2 gap-2">
        <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
          <span>Fill rule</span>
          <div>
            <select
              aria-label="Vector fill rule"
              disabled={readOnly}
              value={path.fillRule}
              onChange={(event) =>
                onUpdate({
                  vectorPath: {
                    ...path,
                    fillRule: event.target.value as typeof path.fillRule,
                  },
                })
              }
            >
              <option value="nonZero">Non-zero</option>
              <option value="evenOdd">Even-odd</option>
            </select>
          </div>
        </label>
        <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
          <span>Points</span>
          <div>
            <output aria-label="Vector point count">{points.length}</output>
          </div>
        </label>
      </div>
      <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
        <span>Anchor</span>
        <div>
          <select
            aria-label="Vector anchor"
            disabled={readOnly}
            value={selectedPoint?.point.id ?? ""}
            onChange={(event) => setSelectedPointId(event.target.value)}
          >
            {points.map(({ point, subpathIndex, pointIndex }) => (
              <option key={point.id} value={point.id}>
                Path {subpathIndex + 1} · Point {pointIndex + 1}
              </option>
            ))}
          </select>
        </div>
      </label>
      {selectedPoint && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
              <span>X</span>
              <div>
                <input
                  aria-label="Vector anchor x"
                  disabled={readOnly}
                  inputMode="decimal"
                  value={selectedPoint.point.x}
                  onChange={(event) =>
                    updateCoordinate("x", event.target.value)
                  }
                />
              </div>
            </label>
            <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
              <span>Y</span>
              <div>
                <input
                  aria-label="Vector anchor y"
                  disabled={readOnly}
                  inputMode="decimal"
                  value={selectedPoint.point.y}
                  onChange={(event) =>
                    updateCoordinate("y", event.target.value)
                  }
                />
              </div>
            </label>
          </div>
          <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
            <span>Point type</span>
            <div>
              <select
                aria-label="Vector point type"
                disabled={readOnly}
                value={selectedPoint.point.pointType}
                onChange={(event) =>
                  setHandles(
                    selectedPoint.point.handleIn,
                    selectedPoint.point.handleOut,
                    event.target.value as typeof selectedPoint.point.pointType,
                  )
                }
              >
                <option value="corner">Corner</option>
                <option value="mirrored">Mirrored</option>
                <option value="asymmetric">Asymmetric</option>
              </select>
            </div>
          </label>
          <div>
            <button
              type="button"
              disabled={readOnly}
              onClick={() =>
                setHandles({ x: -20, y: 0 }, { x: 20, y: 0 }, "mirrored")
              }
            >
              Add handles
            </button>
            <button
              type="button"
              disabled={
                readOnly ||
                (!selectedPoint.point.handleIn &&
                  !selectedPoint.point.handleOut)
              }
              onClick={() => setHandles(undefined, undefined, "corner")}
            >
              Remove handles
            </button>
          </div>
        </>
      )}
      <div>
        <button
          type="button"
          disabled={readOnly || !selectedPoint}
          onClick={insertAfterSelected}
        >
          Add point
        </button>
        <button
          type="button"
          disabled={
            readOnly ||
            !selectedPoint ||
            (selectedPoint.pointIndex + 1 >=
              path.subpaths[selectedPoint.subpathIndex].points.length &&
              !path.subpaths[selectedPoint.subpathIndex].closed)
          }
          onClick={splitSelectedSegment}
        >
          Split segment
        </button>
        <button
          type="button"
          disabled={readOnly || !canDeleteSelected || !selectedPoint}
          onClick={() =>
            selectedPoint && onDeletePoint(node.id, selectedPoint.point.id)
          }
        >
          Delete point
        </button>
      </div>
      <div>
        {path.subpaths.map((subpath, index) => (
          <label
            key={`subpath-${index}`}
            className="my-2 flex items-center gap-2 text-xs text-muted-foreground [&_input]:size-4 [&_input]:accent-primary"
          >
            <input
              aria-label={`Close vector subpath ${index + 1}`}
              disabled={
                readOnly || (!subpath.closed && subpath.points.length < 3)
              }
              type="checkbox"
              checked={subpath.closed}
              onChange={(event) =>
                onSetSubpathClosed(node.id, index, event.target.checked)
              }
            />
            Close path {index + 1}
          </label>
        ))}
      </div>
    </section>
  );
}

function TextInspector({
  node,
  assets,
  fontAvailability,
  onUpdate,
  readOnly,
}: {
  node: CanvasNode;
  assets: DocumentAsset[];
  fontAvailability?: EditorSnapshot["fontAvailability"];
  onUpdate: (patch: Partial<CanvasNode>) => void;
  readOnly: boolean;
}) {
  const properties = useMemo<DocumentTextProperties>(
    () =>
      node.textProperties ?? {
        runs: [],
        paragraph: {
          alignment: "left",
          lineHeight: DEFAULT_TEXT_LINE_HEIGHT,
          paragraphSpacing: 0,
        },
        autoSize: "fixed",
        fallbackFonts: [],
      },
    [node.textProperties],
  );
  const primary = properties.runs[0];
  const selectionColor = primary?.color ??
    node.fillColor ??
    documentColorFromCssHex(node.fill) ?? {
      space: "srgb" as const,
      components: [0, 0, 0] as [number, number, number],
      alpha: 1,
    };
  const variationAxesCanonical = formatFontVariationAxes(
    primary?.font?.variationAxes,
  );
  const [textDraft, setTextDraft] = useState(node.text ?? "");
  const [selectedTextRange, setSelectedTextRange] = useState({
    start: 0,
    end: (node.text ?? "").length,
  });
  const isComposingText = useRef(false);
  useEffect(() => {
    if (!isComposingText.current) {
      const text = node.text ?? "";
      setTextDraft(text);
      setSelectedTextRange({ start: 0, end: text.length });
    }
  }, [node.id, node.text]);
  const fontStatus = primary?.font
    ? (fontAvailability?.[primary.font.assetId] ?? "idle")
    : undefined;
  const fontAssets = assets.filter((asset) =>
    asset.mediaType.startsWith("font/"),
  );
  const selectionSummary = useMemo(
    () =>
      textSelectionStyleSummary(
        node.text ?? "",
        properties,
        selectedTextRange.start,
        selectedTextRange.end,
      ),
    [node.text, properties, selectedTextRange],
  );
  const updateProperties = (next: DocumentTextProperties) =>
    onUpdate({ textProperties: next });
  const updateRun = (
    patch: Partial<NonNullable<DocumentTextProperties["runs"][number]>>,
  ) => {
    const text = node.text ?? "";
    const textLength = new TextEncoder().encode(text).byteLength;
    const current = primary ?? {
      start: 0,
      end: textLength,
      fontSize: 31,
      fontWeight: 500,
      italic: false,
      letterSpacing: 0,
    };
    const complete = {
      ...properties,
      runs:
        textLength && properties.runs.length === 0
          ? [{ ...current, start: 0, end: textLength }]
          : properties.runs,
    };
    const start = utf8OffsetAtUtf16Index(text, selectedTextRange.start);
    const end = utf8OffsetAtUtf16Index(text, selectedTextRange.end);
    updateProperties(
      patchTextStyleRuns(
        text,
        complete,
        start === end ? 0 : start,
        start === end ? textLength : end,
        patch,
      ),
    );
  };
  const numeric = (value: string, apply: (number: number) => void) => {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) apply(parsed);
  };
  const commitText = (value: string) => {
    const text = unicodeScalarText(value);
    if (text === (node.text ?? "")) return;
    onUpdate({ text, textProperties: textReplacementProperties(node, text) });
  };
  return (
    <section className="space-y-0">
      <h2>Content</h2>
      <textarea
        readOnly={readOnly}
        value={textDraft}
        onSelect={(event) =>
          setSelectedTextRange({
            start: event.currentTarget.selectionStart,
            end: event.currentTarget.selectionEnd,
          })
        }
        onCopy={(event) => {
          const payload = captureTextClipboard(
            textDraft,
            properties,
            event.currentTarget.selectionStart,
            event.currentTarget.selectionEnd,
          );
          if (!payload) return;
          const encoded = encodeTextClipboard(payload);
          event.preventDefault();
          event.clipboardData.setData("text/plain", payload.text);
          if (encoded)
            event.clipboardData.setData(
              "application/x-makefigma-text-v1",
              encoded,
            );
        }}
        onCut={(event) => {
          const start = event.currentTarget.selectionStart;
          const end = event.currentTarget.selectionEnd;
          const payload = captureTextClipboard(
            textDraft,
            properties,
            start,
            end,
          );
          if (!payload) return;
          const encoded = encodeTextClipboard(payload);
          event.preventDefault();
          event.clipboardData.setData("text/plain", payload.text);
          if (encoded)
            event.clipboardData.setData(
              "application/x-makefigma-text-v1",
              encoded,
            );
          const next = `${textDraft.slice(0, start)}${textDraft.slice(end)}`;
          event.currentTarget.value = next;
          event.currentTarget.setSelectionRange(start, start);
          setSelectedTextRange({ start, end: start });
          setTextDraft(next);
          if (!isComposingText.current)
            onUpdate({
              text: next,
              textProperties: rebaseTextStyleRuns(textDraft, next, properties),
            });
        }}
        onPaste={(event) => {
          // Deliberately ignore text/html. Browser clipboard HTML is untrusted;
          // a later rich-paste step accepts only our versioned private MIME.
          event.preventDefault();
          const start = event.currentTarget.selectionStart;
          const end = event.currentTarget.selectionEnd;
          const rich = decodeTextClipboard(
            event.clipboardData.getData("application/x-makefigma-text-v1"),
          );
          const pasted =
            rich && unicodeScalarText(rich.text) === rich.text
              ? pasteTextClipboard(textDraft, properties, start, end, rich)
              : undefined;
          const plain = unicodeScalarText(
            pasted?.text ?? event.clipboardData.getData("text/plain"),
          );
          if (!plain) return;
          const next =
            pasted?.text ??
            `${textDraft.slice(0, start)}${plain}${textDraft.slice(end)}`;
          event.currentTarget.value = next;
          const caret = start + plain.length;
          event.currentTarget.setSelectionRange(caret, caret);
          setSelectedTextRange({ start: caret, end: caret });
          setTextDraft(next);
          if (!isComposingText.current) {
            if (pasted)
              onUpdate({ text: next, textProperties: pasted.properties });
            else commitText(next);
          }
        }}
        onCompositionStart={() => {
          isComposingText.current = true;
        }}
        onCompositionEnd={(event) => {
          isComposingText.current = false;
          const text = unicodeScalarText(event.currentTarget.value);
          setTextDraft(text);
          commitText(text);
        }}
        onChange={(event) => {
          const text = unicodeScalarText(event.target.value);
          setTextDraft(text);
          if (!isComposingText.current) commitText(text);
        }}
        onBlur={(event) => {
          if (!isComposingText.current) commitText(event.currentTarget.value);
        }}
        aria-label="Text content"
      />
      <p
        className="mb-2 text-xs leading-relaxed text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        {selectedTextRange.start === selectedTextRange.end
          ? "Caret style: edits apply to the full text"
          : `Selection: ${selectionSummary.characterCount} characters${selectionSummary.mixed ? " · mixed styles; changes replace the selected style" : ""}`}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
          <span>Font</span>
          <div>
            <select
              aria-label="Font"
              disabled={readOnly}
              value={primary?.font?.assetId ?? ""}
              onChange={(event) =>
                updateRun({
                  font: event.target.value
                    ? {
                        assetId: event.target.value,
                        faceIndex: primary?.font?.faceIndex ?? 0,
                        variationAxes: primary?.font?.variationAxes,
                      }
                    : undefined,
                })
              }
            >
              <option value="">System fallback</option>
              {fontAssets.map((asset) => (
                <option value={asset.assetId} key={asset.assetId}>
                  {asset.assetId.slice(0, 8)}
                </option>
              ))}
            </select>
          </div>
        </label>
        <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
          <span>Size</span>
          <div>
            <input
              aria-label="Font size"
              disabled={readOnly}
              inputMode="decimal"
              value={primary?.fontSize ?? 31}
              onChange={(event) =>
                numeric(event.target.value, (fontSize) =>
                  updateRun({ fontSize }),
                )
              }
            />
            <em>px</em>
          </div>
        </label>
        <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
          <span>Weight</span>
          <div>
            <input
              aria-label="Font weight"
              disabled={readOnly}
              inputMode="numeric"
              value={primary?.fontWeight ?? 500}
              onChange={(event) =>
                numeric(event.target.value, (fontWeight) =>
                  updateRun({ fontWeight }),
                )
              }
            />
          </div>
        </label>
        <VariationAxesField
          key={`${node.id}:${primary?.font?.assetId ?? "none"}:${primary?.font?.faceIndex ?? 0}:${variationAxesCanonical}`}
          font={primary?.font}
          readOnly={readOnly}
          onChange={(font) => updateRun({ font })}
        />
        <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
          <span>Tracking</span>
          <div>
            <input
              aria-label="Letter spacing"
              disabled={readOnly}
              inputMode="decimal"
              value={primary?.letterSpacing ?? 0}
              onChange={(event) =>
                numeric(event.target.value, (letterSpacing) =>
                  updateRun({ letterSpacing }),
                )
              }
            />
            <em>px</em>
          </div>
        </label>
        <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
          <span>Color</span>
          <div>
            <input
              aria-label="Text selection color"
              disabled={readOnly}
              type="color"
              value={colorToOpaqueSrgbCss(selectionColor)}
              onChange={(event) => {
                const color = documentColorFromCssHex(event.target.value);
                if (color) updateRun({ color });
              }}
            />
          </div>
        </label>
        <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
          <span>Line height</span>
          <div>
            <input
              aria-label="Line height"
              disabled={readOnly}
              inputMode="decimal"
              value={
                properties.paragraph.lineHeight ?? DEFAULT_TEXT_LINE_HEIGHT
              }
              onChange={(event) => {
                const raw = event.target.value.trim();
                if (!raw)
                  updateProperties({
                    ...properties,
                    paragraph: {
                      ...properties.paragraph,
                      lineHeight: undefined,
                    },
                  });
                else
                  numeric(raw, (lineHeight) => {
                    if (lineHeight > 0)
                      updateProperties({
                        ...properties,
                        paragraph: { ...properties.paragraph, lineHeight },
                      });
                  });
              }}
            />
            <em>px</em>
          </div>
        </label>
        <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
          <span>Paragraph</span>
          <div>
            <input
              aria-label="Paragraph spacing"
              disabled={readOnly}
              inputMode="decimal"
              value={properties.paragraph.paragraphSpacing}
              onChange={(event) =>
                numeric(event.target.value, (paragraphSpacing) => {
                  if (paragraphSpacing >= 0)
                    updateProperties({
                      ...properties,
                      paragraph: { ...properties.paragraph, paragraphSpacing },
                    });
                })
              }
            />
            <em>px</em>
          </div>
        </label>
      </div>
      <div className="grid grid-cols-3 gap-1 [&>button]:h-8 [&>button]:rounded-lg [&>button]:border [&>button]:bg-background [&>button]:text-xs [&>button]:hover:bg-muted [&>button][aria-pressed=true]:bg-accent [&>button][aria-pressed=true]:text-accent-foreground">
        <label>
          Align{" "}
          <select
            aria-label="Text alignment"
            disabled={readOnly}
            value={properties.paragraph.alignment}
            onChange={(event) =>
              updateProperties({
                ...properties,
                paragraph: {
                  ...properties.paragraph,
                  alignment: event.target
                    .value as DocumentTextProperties["paragraph"]["alignment"],
                },
              })
            }
          >
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
            <option value="justify">Justify</option>
          </select>
        </label>
        <label>
          Auto size{" "}
          <select
            aria-label="Text auto size"
            disabled={readOnly}
            value={properties.autoSize}
            onChange={(event) =>
              updateProperties({
                ...properties,
                autoSize: event.target
                  .value as DocumentTextProperties["autoSize"],
              })
            }
          >
            <option value="fixed">Fixed</option>
            <option value="height">Auto height</option>
            <option value="widthAndHeight">Auto width &amp; height</option>
          </select>
        </label>
        <label>
          Fallback{" "}
          <select
            aria-label="Fallback font"
            disabled={readOnly}
            value={properties.fallbackFonts?.[0]?.assetId ?? ""}
            onChange={(event) =>
              updateProperties({
                ...properties,
                fallbackFonts: event.target.value
                  ? [{ assetId: event.target.value, faceIndex: 0 }]
                  : [],
              })
            }
          >
            <option value="">None</option>
            {fontAssets
              .filter((asset) => asset.assetId !== primary?.font?.assetId)
              .map((asset) => (
                <option value={asset.assetId} key={asset.assetId}>
                  {asset.assetId.slice(0, 8)}
                </option>
              ))}
          </select>
        </label>
        <label className="my-2 flex items-center gap-2 text-xs text-muted-foreground [&_input]:size-4 [&_input]:accent-primary">
          <input
            aria-label="Italic"
            disabled={readOnly}
            type="checkbox"
            checked={primary?.italic ?? false}
            onChange={(event) => updateRun({ italic: event.target.checked })}
          />
          Italic
        </label>
      </div>
      {fontStatus && (
        <p
          className="mb-2 text-xs leading-relaxed text-muted-foreground"
          role="status"
        >
          Font{" "}
          {fontStatus === "ready"
            ? "loaded"
            : fontStatus === "loading"
              ? "loading"
              : fontStatus === "unavailable"
                ? "unavailable — system fallback"
                : "not loaded"}
        </p>
      )}
    </section>
  );
}

function VariationAxesField({
  font,
  readOnly,
  onChange,
}: {
  font?: DocumentFontReference;
  readOnly: boolean;
  onChange: (font: DocumentFontReference) => void;
}) {
  const [draft, setDraft] = useState(() =>
    formatFontVariationAxes(font?.variationAxes),
  );
  const [error, setError] = useState<string | undefined>(undefined);
  const commit = () => {
    if (!font) return;
    const result = parseFontVariationAxes(draft);
    if (!result.valid) {
      setError(result.error);
      return;
    }
    setError(undefined);
    setDraft(formatFontVariationAxes(result.axes));
    onChange({ ...font, variationAxes: result.axes });
  };
  return (
    <label className="mb-2 block space-y-1.5 text-xs [&>span]:block [&>span]:font-medium [&>span]:text-muted-foreground [&>div]:flex [&>div]:items-center [&>div]:rounded-lg [&>div]:border [&>div]:bg-background [&_input]:h-8 [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-2 [&_input]:text-xs [&_input]:outline-none [&_input]:focus-visible:ring-0 [&_select]:h-8 [&_select]:w-full [&_select]:min-w-0 [&_select]:border-0 [&_select]:bg-transparent [&_select]:px-2 [&_select]:text-xs [&_em]:pr-2 [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
      <span>Variations</span>
      <div>
        <input
          aria-label="Variable font axes"
          disabled={readOnly || !font}
          placeholder="wght=650, wdth=92"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(undefined);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
        />
      </div>
      {error && <em role="alert">{error}</em>}
    </label>
  );
}

function colorCss(color: DocumentColor): string {
  return colorToSrgbCss(color);
}

function opaqueColorCss(color: DocumentColor): string {
  return colorToOpaqueSrgbCss(color);
}

function gradientCss(gradient: DocumentLinearGradient): string {
  return `linear-gradient(${gradient.stops.map((stop) => `${colorCss(stop.color)} ${Math.round(stop.position * 100)}%`).join(", ")})`;
}

function sameDirection(
  gradient: DocumentLinearGradient,
  start: [number, number],
  end: [number, number],
) {
  return (
    gradient.start[0] === start[0] &&
    gradient.start[1] === start[1] &&
    gradient.end[0] === end[0] &&
    gradient.end[1] === end[1]
  );
}

function svgFileStem(value: string) {
  const stem = value
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return stem || "makefigma-page";
}

function downloadBlob(blob: Blob, filename: string) {
  const anchor = document.createElement("a");
  const url = URL.createObjectURL(blob);
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function downloadCompatibilityReport(
  stem: string,
  result: SvgExportResult,
  input: {
    target: ExportTarget;
    formatRequested: ExportFormat;
    background?: "transparent" | string;
  },
) {
  const payload = JSON.stringify(buildExportManifest(result, input), null, 2);
  downloadBlob(
    new Blob([payload], { type: "application/json;charset=utf-8" }),
    `${stem}.compatibility.json`,
  );
}

/** A multi-page PDF is one deliverable, so it receives one sidecar. Retaining
 * each Page's target ID/name prevents same-named pages from overwriting or
 * ambiguously splitting the report. */
function downloadCompatibilityReportSet(
  stem: string,
  targets: ReadonlyArray<{
    id: string;
    name: string;
    target: ExportTarget;
    result: SvgExportResult;
  }>,
  background: "transparent" | string,
) {
  const payload = JSON.stringify(
    buildPdfExportManifestSet(targets, background),
    null,
    2,
  );
  downloadBlob(
    new Blob([payload], { type: "application/json;charset=utf-8" }),
    `${stem}.compatibility.json`,
  );
}
