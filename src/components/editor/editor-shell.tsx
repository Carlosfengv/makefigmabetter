"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { IconButton } from "@/components/ui/icon-button";
import { appendLocalJournalEntry, appendPendingRemoteOperation, loadLocalDocument, loadPendingRemoteOperations, pendingOperationIsCoveredBySnapshot, prepareLocalStorage, removePendingRemoteOperation, removePendingRemoteOperationsCoveredBySnapshot, replacePendingRemoteOperation, replacePendingRemoteOperations, saveLocalDocument, saveViewportRecord } from "@/lib/local-document";
import { createId, createNode, DEFAULT_TEXT_LINE_HEIGHT, documentColorFromCssHex, type CanvasNode, type ConstraintType, type CoreLocalSnapshot, type DocumentAsset, type DocumentColor, type DocumentFontReference, type DocumentLinearGradient, type DocumentPaint, type DocumentTextProperties, type EditorCommand, type EditorInputEvent, type EditorSnapshot, type MainToWorker, type NodeKind, type RendererPreference, type SimulatedGpuFault, type ToolKind, type WorkerToMain } from "@/lib/editor-protocol";
import { FontFaceRegistry, fontFamilyForAsset } from "@/lib/font-face-registry";
import { canvasDesignTokens } from "@/lib/canvas-design-tokens";
import { layoutTextRanges, segmentGraphemes, textParagraphRanges } from "@/lib/text-layout";
import { styledTextSpans } from "@/lib/text-style-runs";
import { maintainWriterLease, type WriterLease, type WriterLeaseMode } from "@/lib/writer-lease";
import { planWorkerRecovery } from "@/lib/worker-recovery";
import { colorToOpaqueSrgbCss, colorToSrgbCss, createDefaultLinearGradient } from "@/lib/color-rendering";
import { createInputBatchBacklogSampler, createInputTransferBatcher, type InputBatchBacklogSummary, type InputTransferBatcher } from "@/lib/input-transfer-batcher";
import { createFrameIntervalSampler, emptyMainThreadLongTaskSummary, recordMainThreadLongTask, type FrameIntervalSummary, type MainThreadLongTaskSummary } from "@/lib/main-thread-health";
import { createViewportCheckpointSampler, type ViewportCheckpointSummary } from "@/lib/viewport-checkpoint-performance";
import { encodeInputBatch } from "@/lib/input-transfer";
import { createEditorTransactionQueue } from "@/lib/editor-transaction-queue";
import { applyOptimisticUpdates, type OptimisticUpdate } from "@/lib/optimistic-projection";
import { DocumentApiTransport } from "@/lib/document-api-transport";
import { AssetApiTransport } from "@/lib/asset-api-transport";
import { probeAssetInWorker } from "@/lib/asset-probe-client";
import { decodeRasterInWorker, type DecodedRaster } from "@/lib/asset-decode-client";
import { formatFontVariationAxes, parseFontVariationAxes } from "@/lib/font-variation-axes";
import { PendingOperationSynchronizer } from "@/lib/pending-operation-sync";
import { deleteUtf16SelectionInRustLayout, moveUtf16CaretInRustLayout, replaceUtf16SelectionInRustLayout, snapUtf16CaretToRustLayout, utf16IndexAtUtf8Offset, type RustTextCaretLayout } from "@/lib/rust-text-caret";
import { LayerPanel } from "./layer-panel";
import { createZoomPerformanceFixture } from "@/lib/zoom-performance-fixture";
import phase0BasicCardFixture from "../../../fixtures/documents/phase0-basic-card.fixture.json";
import phase1TextMultilingualFixture from "../../../fixtures/documents/phase1-text-multilingual.fixture.json";
import phase1Text10kFixture from "../../../fixtures/documents/phase1-text-10k.fixture.json";
import phase1RenderCompositeFixture from "../../../fixtures/documents/phase1-render-composite.fixture.json";
import phase2CommonNodesFixture from "../../../fixtures/documents/phase2-common-nodes.fixture.json";
import { createPhase1Shape100kFixture } from "@/lib/phase1-shape-100k-fixture";
import { resolveLayerDrop, resolveLayerOrder, type LayerOrderAction } from "@/lib/layer-order";
import { exportPageToSvg } from "@/lib/svg-export";
import { mixedSelectionValue, type MixedSelectionValue } from "@/lib/mixed-selection";
import { lineSelectionAppearance, parseLineDashPattern, strokeSelectionAppearance } from "@/lib/line-selection-appearance";
import { resolvedStrokeWeights, strokeWeightSelection } from "@/lib/stroke-weight-selection";
import { cornerRadiusSelection, resolvedCornerRadii } from "@/lib/corner-radius-selection";
import { cornerSmoothingSelection } from "@/lib/corner-smoothing-selection";
import { constraintSelection, type ConstraintSelectionValue } from "@/lib/constraint-selection";
import { hasFrameConstraintScope } from "@/lib/frame-constraint-scope";
import { mixedInspectorCapabilities, supportsCornerRadiusInspector, supportsGenericAppearanceInspector, supportsPaintStackInspector, supportsPerSideStrokeInspector, supportsStrokeAlignInspector, supportsStrokeDetailsInspector } from "@/lib/inspector-capabilities";
import { layerKeyboardNestingTarget, type LayerNestingIntent } from "@/lib/layer-keyboard-nesting";
import { resolveMultiResizeSelection } from "@/lib/multi-selection";
import { selectionGeometryPatches } from "@/lib/selection-geometry-edit";
import { resolveCanvasObjectSelection } from "@/lib/canvas-selection";
import { ellipseArcUpdatePatch } from "@/lib/ellipse-arc";

const tools: Array<{ id: ToolKind; label: string; glyph: string; key: string }> = [
  { id: "select", label: "Move", glyph: "↖", key: "V" },
  { id: "hand", label: "Pan", glyph: "✋", key: "H" },
  { id: "frame", label: "Frame", glyph: "#", key: "F" },
  { id: "section", label: "Section", glyph: "§", key: "S" },
  { id: "rectangle", label: "Rectangle", glyph: "□", key: "R" },
  { id: "ellipse", label: "Ellipse", glyph: "○", key: "O" },
  { id: "line", label: "Line", glyph: "／", key: "L" },
  { id: "arrow", label: "Arrow", glyph: "→", key: "A" },
  { id: "text", label: "Text", glyph: "T", key: "T" },
];

const defaultPageId = "00000000-0000-0000-0000-000000000001";
const blankSnapshot: EditorSnapshot = { documentId: "00000000-0000-0000-0000-000000000000", revision: 0, nodes: [], pages: [{ id: defaultPageId, name: "Page 1", positionId: "00000000000000000000000000000001:00000000000000000000000000000000" }], activePageId: defaultPageId, selectedIds: [], viewport: { x: 0, y: 0, zoom: 1 }, canUndo: false, canRedo: false, renderer: "Canvas 2D", documentCore: "Starting Rust/WASM bridge" };
type DocumentUiState = Pick<EditorSnapshot, "documentId" | "revision" | "documentHash" | "memory" | "resources" | "diagnostics" | "nodes" | "assets" | "pages" | "activePageId" | "canUndo" | "canRedo" | "renderer" | "gpu" | "documentCore" | "localSnapshot" | "localJournalEntry">;
type SelectionUiState = { selectedIds: string[] };
type ViewUiState = { viewport: EditorSnapshot["viewport"]; performance?: EditorSnapshot["performance"] };
const localDevTenantId = "00000000-0000-0000-0000-000000000002";
const localDevActorId = "00000000-0000-0000-0000-000000000007";
const documentApiUrl = process.env.NEXT_PUBLIC_DOCUMENT_API_URL ?? "/document-api";
const assetApiUrl = process.env.NEXT_PUBLIC_ASSET_API_URL ?? "/asset-api";
type EditIntent = { at: number; id: string };
type PendingImagePlacement = { assetId: string; width?: number; height?: number; targetId?: string };
type CanvasTextEdit = { nodeId: string; draft: string; initialDraft: string; caret: number; selectionAnchor: number; rustCaretReady: boolean; rustCaretLayout?: RustTextCaretLayout };
type TabMessage = { type: "snapshot"; snapshot: CoreLocalSnapshot } | { type: "request-edit"; intent: EditIntent };
/** Fixture-only runtime seed. Canonical Document keeps `DocumentAsset` metadata
 * and node-level image references; bytes are transferred to the Worker after hydration. */
type FixtureAssetSeed = DocumentAsset & { bytesBase64: string };

function importedImageNode(imageAsset: PendingImagePlacement, viewport: EditorSnapshot["viewport"]) {
  const sourceWidth = imageAsset.width ?? 320;
  const sourceHeight = imageAsset.height ?? 220;
  const scale = Math.min(1, 480 / Math.max(sourceWidth, sourceHeight));
  const image = createNode("image", -viewport.x - sourceWidth * scale / 2, -viewport.y - sourceHeight * scale / 2);
  image.assetId = imageAsset.assetId;
  image.width = Math.max(32, sourceWidth * scale);
  image.height = Math.max(32, sourceHeight * scale);
  image.name = "Imported image";
  return image;
}

function imageFillTarget(nodes: readonly CanvasNode[], selectedIds: readonly string[]) {
  const selected = selectedIds.length === 1 ? nodes.find((node) => node.id === selectedIds[0]) : undefined;
  return selected && !selected.locked && ["frame", "rectangle", "ellipse", "image"].includes(selected.kind) ? selected : undefined;
}

function importFailureMessage(code: string) {
  if (code === "RESOURCE_LIMIT") return "Import failed · image exceeds the 256 MB / 256 MP import limit";
  return `Import failed · ${code.toLowerCase().replaceAll("_", " ")}`;
}

function newerEditIntent(candidate: EditIntent, current: EditIntent) {
  return candidate.at > current.at || (candidate.at === current.at && candidate.id > current.id);
}

function sameIds(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Content replacement is one atomic Canonical update. Phase 2 adds selecting
 * and styling arbitrary subranges; until then the first style remains valid
 * over the complete new UTF-8 source. */
function textReplacementProperties(node: CanvasNode, text: string): DocumentTextProperties {
  const properties: DocumentTextProperties = node.textProperties ?? {
    runs: [],
    paragraph: { alignment: "left", lineHeight: DEFAULT_TEXT_LINE_HEIGHT, paragraphSpacing: 0 },
    autoSize: "fixed",
    fallbackFonts: [],
  };
  const primary = properties.runs[0];
  const textLength = new TextEncoder().encode(text).byteLength;
  return {
    ...properties,
    runs: textLength && primary ? [{ ...primary, start: 0, end: textLength }] : [],
  };
}

/** The Inspector owns the initial intent, so it also supplies a deterministic
 * geometry patch for auto-sized text. The worker repeats this measurement with
 * its loaded FontFace; including it here keeps the selected dimensions responsive
 * even while that worker font is still becoming ready. */
function resolveTextAutoSizePatch(node: CanvasNode, patch: Partial<CanvasNode>): Partial<CanvasNode> {
  if (node.kind !== "text") return patch;
  const properties = patch.textProperties ?? node.textProperties;
  if (!properties || properties.autoSize === "fixed") return patch;
  const primary = properties.runs[0];
  const fontSize = primary?.fontSize ?? 31;
  const lineHeight = properties.paragraph.lineHeight ?? DEFAULT_TEXT_LINE_HEIGHT;
  const letterSpacing = primary?.letterSpacing ?? 0;
  const measure = (value: string) => {
    if (typeof document === "undefined") return Array.from(value).length * fontSize * .6;
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return Array.from(value).length * fontSize * .6;
    const family = primary?.font ? `"${fontFamilyForAsset(primary.font.assetId)}", ` : "";
    ctx.font = `${primary?.italic ? "italic " : ""}${primary?.fontWeight ?? canvasDesignTokens.typography.canvasText.weight} ${fontSize}px ${family}${canvasDesignTokens.typography.canvasText.family}`;
    return ctx.measureText(value).width + Math.max(0, Array.from(value).length - 1) * letterSpacing;
  };
  const text = patch.text ?? node.text ?? "";
  const nextWidth = patch.width ?? node.width;
  const maxWidth = properties.autoSize === "widthAndHeight" ? Number.POSITIVE_INFINITY : Math.max(1, nextWidth);
  const lines = layoutTextRanges({ text, maxWidth, measure });
  const paragraphBreaks = Math.max(0, (text.match(/\r\n|[\n\r\u2028\u2029]/gu) ?? []).length);
  const height = Math.max(1, lines.length * lineHeight + paragraphBreaks * properties.paragraph.paragraphSpacing);
  const width = Math.max(1, ...lines.map((line) => measure(line.text)));
  return { ...patch, height, ...(properties.autoSize === "widthAndHeight" ? { width } : {}) };
}

function textNodeContainsPoint(node: CanvasNode, point: { x: number; y: number }) {
  if (node.kind !== "text" || node.visible === false) return false;
  const centerX = node.x + node.width / 2;
  const centerY = node.y + node.height / 2;
  const radians = -node.rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const dx = point.x - centerX;
  const dy = point.y - centerY;
  const localX = dx * cosine - dy * sine + node.width / 2;
  const localY = dx * sine + dy * cosine + node.height / 2;
  return localX >= 0 && localX <= node.width && localY >= 0 && localY <= node.height;
}

function textLocalPoint(node: CanvasNode, point: { x: number; y: number }) {
  const centerX = node.x + node.width / 2;
  const centerY = node.y + node.height / 2;
  const radians = -node.rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const dx = point.x - centerX;
  const dy = point.y - centerY;
  return { x: dx * cosine - dy * sine + node.width / 2, y: dx * sine + dy * cosine + node.height / 2 };
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
  const paragraphs = [...editor.querySelectorAll<HTMLElement>(":scope > .canvas-text-paragraph")];
  if (paragraphs.length) {
    let remaining = targetOffset;
    for (let index = 0; index < paragraphs.length; index += 1) {
      const paragraph = paragraphs[index];
      const length = paragraph.innerText.length;
      if (remaining <= length) { placeIn(paragraph, remaining); return; }
      remaining -= length;
      if (index < paragraphs.length - 1) {
        if (remaining === 0) { placeIn(paragraph, length); return; }
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

function contentEditablePointAtOffset(editor: HTMLElement, targetOffset: number) {
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
  const paragraphs = [...editor.querySelectorAll<HTMLElement>(":scope > .canvas-text-paragraph")];
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

function placeContentEditableSelection(editor: HTMLElement, anchorOffset: number, focusOffset: number) {
  const selection = window.getSelection();
  if (!selection) return;
  const anchor = contentEditablePointAtOffset(editor, anchorOffset);
  const focus = contentEditablePointAtOffset(editor, focusOffset);
  if (typeof selection.setBaseAndExtent === "function") {
    selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
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
function replaceContentEditableRange(editor: HTMLElement, startOffset: number, endOffset: number, replacement: string) {
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

function contentEditableOffsetAtPoint(editor: HTMLElement, node: Node | null, offset: number) {
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
    anchor: contentEditableOffsetAtPoint(editor, selection.anchorNode, selection.anchorOffset),
    focus: contentEditableOffsetAtPoint(editor, selection.focusNode, selection.focusOffset),
  };
}

/** Converts a Canvas double-click into the same insertion position the text
 * editor would select if it had received that pointer event directly. */
function textCaretAtPoint(node: CanvasNode, point: { x: number; y: number }) {
  const text = node.text ?? "";
  const properties = node.textProperties;
  const primary = properties?.runs[0];
  const fontSize = primary?.fontSize ?? 31;
  const lineHeight = properties?.paragraph.lineHeight ?? DEFAULT_TEXT_LINE_HEIGHT;
  const letterSpacing = primary?.letterSpacing ?? 0;
  const local = textLocalPoint(node, point);
  const ctx = typeof document === "undefined" ? undefined : document.createElement("canvas").getContext("2d");
  const family = primary?.font ? `"${fontFamilyForAsset(primary.font.assetId)}", ` : "";
  if (ctx) ctx.font = `${primary?.italic ? "italic " : ""}${primary?.fontWeight ?? canvasDesignTokens.typography.canvasText.weight} ${fontSize}px ${family}${canvasDesignTokens.typography.canvasText.family}`;
  const measure = (value: string) => (ctx?.measureText(value).width ?? Array.from(value).length * fontSize * .6) + Math.max(0, segmentGraphemes(value).length - 1) * letterSpacing;
  const lines = layoutTextRanges({ text, maxWidth: Math.max(1, node.width), measure });
  const bytes = new TextEncoder().encode(text);
  let lineTop = 0;
  let previousEnd = 0;
  for (const line of lines) {
    const skipped = new TextDecoder().decode(bytes.slice(previousEnd, line.start));
    if (/\r\n|[\n\r\u2028\u2029]/u.test(skipped)) lineTop += properties?.paragraph.paragraphSpacing ?? 0;
    const lineBottom = lineTop + lineHeight;
    if (local.y <= lineBottom) {
      const lineWidth = measure(line.text);
      const alignment = properties?.paragraph.alignment ?? "left";
      let x = alignment === "center" ? (node.width - lineWidth) / 2 : alignment === "right" ? node.width - lineWidth : 0;
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

function requestedFixtureSnapshot(): Extract<EditorCommand, { type: "hydrate" }> ["snapshot"] | undefined {
  if (typeof window === "undefined") return undefined;
  const fixture = new URLSearchParams(window.location.search).get("fixture");
  if (fixture === "zoom-50k") {
    const performanceFixture = createZoomPerformanceFixture();
    return { format: "benchmark-projection-v1", nodes: performanceFixture.nodes, viewport: performanceFixture.viewport };
  }
  if (fixture === "phase1-shape-100k") {
    const performanceFixture = createPhase1Shape100kFixture();
    return { format: "benchmark-projection-v1", nodes: performanceFixture.nodes, viewport: performanceFixture.viewport };
  }
  const requestedDocumentFixture = fixture === "phase0-basic-card"
    ? phase0BasicCardFixture
    : fixture === "phase1-text-multilingual"
      ? phase1TextMultilingualFixture
      : fixture === "phase1-text-10k"
        ? phase1Text10kFixture
        : fixture === "phase1-render-composite"
          ? { ...phase1RenderCompositeFixture, nodes: phase1RenderCompositeFixture.nodes.filter((node) => node.kind !== "image") }
          : fixture === "phase2-common-nodes"
            ? phase2CommonNodesFixture
      : undefined;
  if (!requestedDocumentFixture) return undefined;
  return {
    format: "legacy-projection-v0",
    nodes: structuredClone(requestedDocumentFixture.nodes) as CanvasNode[],
    viewport: structuredClone(requestedDocumentFixture.viewport),
  };
}

function requestedFixtureAssetSeeds(): FixtureAssetSeed[] {
  if (typeof window === "undefined") return [];
  return new URLSearchParams(window.location.search).get("fixture") === "phase1-render-composite"
    ? structuredClone(phase1RenderCompositeFixture.assets) as FixtureAssetSeed[]
    : [];
}

function requestedFixtureAssetNodes(): CanvasNode[] {
  if (typeof window === "undefined") return [];
  return new URLSearchParams(window.location.search).get("fixture") === "phase1-render-composite"
    ? structuredClone(phase1RenderCompositeFixture.nodes.filter((node) => node.kind === "image")) as CanvasNode[]
    : [];
}

function decodeFixtureAssetBytes(seed: FixtureAssetSeed): ArrayBuffer {
  const encoded = atob(seed.bytesBase64);
  const bytes = new Uint8Array(encoded.length);
  for (let index = 0; index < encoded.length; index += 1) bytes[index] = encoded.charCodeAt(index);
  if (bytes.byteLength !== seed.byteLength) throw new Error("FIXTURE_ASSET_LENGTH_MISMATCH");
  return bytes.buffer;
}

function requestedFixtureStatus() {
  if (typeof window === "undefined") return "fixed fixture loaded";
  const fixture = new URLSearchParams(window.location.search).get("fixture");
  if (fixture === "phase1-shape-100k") return "generated Phase 1 F-SHAPE-100K fixture loaded";
  if (fixture === "phase1-text-10k") return "fixed Phase 1 F-TEXT-10K fixture loaded";
  if (fixture === "phase1-text-multilingual") return "fixed Phase 1 text fixture loaded";
  if (fixture === "phase1-render-composite") return "fixed Phase 1 render composite fixture loaded";
  if (fixture === "phase2-common-nodes") return "fixed Phase 2 common-nodes fixture loaded";
  return "fixed Phase 0 fixture loaded";
}

function isDeterministicEvidenceCapture() {
  if (typeof window === "undefined") return false;
  const search = new URLSearchParams(window.location.search);
  return search.get("fixture") === "phase0-basic-card" && search.get("renderer") === "canvas2d";
}

function requestedRendererPreference(): RendererPreference {
  if (typeof window === "undefined") return "auto";
  return new URLSearchParams(window.location.search).get("renderer") === "canvas2d" ? "canvas2d" : "auto";
}

function isStabilityEvidenceCapture() {
  if (process.env.NODE_ENV === "production" || typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("stabilityEvidence") === "1";
}

function requestedStabilityAssetReadDelayMs() {
  if (!isStabilityEvidenceCapture()) return 0;
  const requested = Number(new URLSearchParams(window.location.search).get("simulateAssetReadDelayMs"));
  return Number.isInteger(requested) ? Math.min(15_000, Math.max(0, requested)) : 0;
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
  if (process.env.NODE_ENV === "production" || typeof window === "undefined") return 0;
  const search = new URLSearchParams(window.location.search);
  if (!["phase0-basic-card", "phase1-render-composite"].includes(search.get("fixture") ?? "") && !isStabilityEvidenceCapture()) return 0;
  const requested = Number(search.get("simulateGpuLoss"));
  return Number.isInteger(requested) ? Math.min(2, Math.max(0, requested)) : 0;
}

/** The image fixture delays development-only loss injection until its decoded
 * bitmap has been submitted once, exercising texture re-upload after recovery. */
function requestedGpuLossAfterImage() {
  if (process.env.NODE_ENV === "production" || typeof window === "undefined") return false;
  const search = new URLSearchParams(window.location.search);
  return search.get("fixture") === "phase1-render-composite" && requestedGpuLossSimulationCount() > 0;
}

function requestedGpuFaultSimulation(): SimulatedGpuFault | undefined {
  if (process.env.NODE_ENV === "production" || typeof window === "undefined") return undefined;
  const search = new URLSearchParams(window.location.search);
  if (!["phase0-basic-card", "phase1-render-composite"].includes(search.get("fixture") ?? "")) return undefined;
  const fault = search.get("simulateGpuFault");
  return fault === "out-of-memory" || fault === "validation" || fault === "upload" ? fault : undefined;
}

function requestedEngineCrashSimulationCount(): number {
  if (process.env.NODE_ENV === "production" || typeof window === "undefined") return 0;
  const search = new URLSearchParams(window.location.search);
  if (search.get("fixture") !== "phase0-basic-card" && !isStabilityEvidenceCapture()) return 0;
  const requested = Number(search.get("simulateWorkerCrash"));
  return Number.isInteger(requested) ? Math.min(2, Math.max(0, requested)) : 0;
}

function requestedEngineCrashSimulationDelayMs(): number {
  if (process.env.NODE_ENV === "production" || typeof window === "undefined") return 100;
  const search = new URLSearchParams(window.location.search);
  if (search.get("fixture") !== "phase0-basic-card" && !isStabilityEvidenceCapture()) return 100;
  const requested = Number(search.get("simulateWorkerCrashDelayMs"));
  return Number.isInteger(requested) ? Math.min(5_000, Math.max(0, requested)) : 100;
}

function changesDocument(command: EditorCommand) {
  return command.type !== "select" && command.type !== "select-page";
}

export function EditorShell({ documentId, documentName = "Orbit card exploration", workspaceHref, remoteSync = true, writerLock = true, onRenameDocument, onDocumentSaved }: { documentId?: string; documentName?: string; workspaceHref?: string; remoteSync?: boolean; writerLock?: boolean; onRenameDocument?: (name: string) => void; onDocumentSaved?: (revision: number) => void }) {
  const writerLockName = `makefigma:${documentId ?? "starter-document"}`;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // An OffscreenCanvas transfer is irreversible. Development Strict Mode and
  // Fast Refresh can re-run this component effect against the old element, so
  // replace that element before attempting to boot another worker.
  const transferredCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const restoredRef = useRef(false);
  const remoteBootstrapRequestedRef = useRef(false);
  const resetPendingRef = useRef(false);
  const remoteAdoptedRevisionRef = useRef<{ documentId: string; revision: number } | undefined>(undefined);
  const revisionRef = useRef(0);
  const snapshotRef = useRef<EditorSnapshot>(blankSnapshot);
  const confirmedSnapshotRef = useRef<EditorSnapshot>(blankSnapshot);
  const recoverySnapshotRef = useRef<CoreLocalSnapshot | undefined>(undefined);
  const recoveryFailuresRef = useRef(0);
  const workerRecoveryAwaitingConfirmationRef = useRef(false);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const recoveryStabilityTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const viewportCheckpointTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const assetInputRef = useRef<HTMLInputElement>(null);
  const assetUploadAbortRef = useRef<AbortController | null>(null);
  /** The DOM editor needs the same document-scoped family the Worker uses. */
  const mainFontFacesRef = useRef(new FontFaceRegistry());
  const mainFontBytesRef = useRef(new Map<string, ArrayBuffer>());
  const pendingImagePlacementRef = useRef<PendingImagePlacement | undefined>(undefined);
  const persistenceQueue = useRef(Promise.resolve());
  const remoteSyncQueue = useRef(Promise.resolve());
  const writerRef = useRef(false);
  const writerLeaseRef = useRef<WriterLease | null>(null);
  const editIntentRef = useRef<EditIntent | undefined>(undefined);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const inputBatcherRef = useRef<InputTransferBatcher | null>(null);
  const transactionQueueRef = useRef<ReturnType<typeof createEditorTransactionQueue> | null>(null);
  const optimisticUpdatesRef = useRef(new Map<string, OptimisticUpdate>());
  const simulatedWorkerCrashesRef = useRef(0);
  const fixtureBenchmarkStartedRef = useRef(false);
  const fixtureAssetsSeededRef = useRef(false);
  const fixtureAssetNodesCreatedRef = useRef(false);
  const frameIntervalSamplerRef = useRef(createFrameIntervalSampler());
  const inputBacklogSamplerRef = useRef(createInputBatchBacklogSampler());
  const viewportCheckpointSamplerRef = useRef(createViewportCheckpointSampler());
  const [documentState, setDocumentState] = useState<DocumentUiState>(blankSnapshot);
  const [selectionState, setSelectionState] = useState<SelectionUiState>({ selectedIds: blankSnapshot.selectedIds });
  const [viewState, setViewState] = useState<ViewUiState>({ viewport: blankSnapshot.viewport });
  const [tool, setTool] = useState<ToolKind>("select");
  const [status, setStatus] = useState("Starting engine");
  const [storageNotice, setStorageNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [assetStatus, setAssetStatus] = useState<string>();
  const [assetImporting, setAssetImporting] = useState(false);
  const [writerMode, setWriterMode] = useState<WriterLeaseMode>("acquiring");
  const [accessPreference, setAccessPreference] = useState<"edit" | "view">("edit");
  const [canvasGeneration, setCanvasGeneration] = useState(0);
  const [workerRecoveryCount, setWorkerRecoveryCount] = useState(0);
  const [safeMode, setSafeMode] = useState(false);
  const [mainThreadLongTasks, setMainThreadLongTasks] = useState<MainThreadLongTaskSummary>(emptyMainThreadLongTaskSummary);
  const [frameIntervals, setFrameIntervals] = useState<FrameIntervalSummary>({ samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 });
  const [inputBacklog, setInputBacklog] = useState<InputBatchBacklogSummary>({ samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 });
  const [viewportCheckpoints, setViewportCheckpoints] = useState<ViewportCheckpointSummary>({ samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 });
  const [mainThreadMonitor, setMainThreadMonitor] = useState<"waiting" | "monitoring" | "unavailable">("waiting");
  const [mainThreadMonitoringEnabled, setMainThreadMonitoringEnabled] = useState(false);
  const [canvasTextEdit, setCanvasTextEdit] = useState<CanvasTextEdit>();
  const [renameMode, setRenameMode] = useState(false);
  const [nameDraft, setNameDraft] = useState(documentName);
  const canvasTextCommitRef = useRef(false);
  const canvasTextIsComposingRef = useRef(false);
  const canvasTextEditorRef = useRef<HTMLDivElement>(null);
  const pendingCanvasCaretLayoutsRef = useRef(new Map<string, { nodeId: string; text: string; targetUtf16: number }>());
  /** A restarted Worker owns no prior layout response. Keep the DOM draft, but
   * never reuse its old caret map after that boundary. */
  const needsCanvasTextCaretRecoveryRef = useRef(false);
  const canvasTextEditNodeId = canvasTextEdit?.nodeId;
  const canvasTextCaret = canvasTextEdit?.caret;
  const canvasTextSelectionAnchor = canvasTextEdit?.selectionAnchor;
  const fixtureSnapshot = useMemo(() => requestedFixtureSnapshot(), []);
  const fixtureAssetSeeds = useMemo(() => requestedFixtureAssetSeeds(), []);
  const fixtureAssetNodes = useMemo(() => requestedFixtureAssetNodes(), []);
  const fixtureStatus = useMemo(() => requestedFixtureStatus(), []);
  // URL-only capture mode is intentionally enabled after hydration so the
  // server and the browser's first render have exactly the same DOM shape.
  const [deterministicEvidenceCapture, setDeterministicEvidenceCapture] = useState(false);
  const rendererPreference = useMemo(() => requestedRendererPreference(), []);
  const simulateGpuLosses = useMemo(() => requestedGpuLossSimulationCount(), []);
  const simulateGpuLossAfterImage = useMemo(() => requestedGpuLossAfterImage(), []);
  const simulateGpuFault = useMemo(() => requestedGpuFaultSimulation(), []);
  const simulateWorkerCrashes = useMemo(() => requestedEngineCrashSimulationCount(), []);
  const simulateWorkerCrashDelayMs = useMemo(() => requestedEngineCrashSimulationDelayMs(), []);
  const snapshot = useMemo(() => ({ ...documentState, ...selectionState, ...viewState }) as EditorSnapshot, [documentState, selectionState, viewState]);
  useEffect(() => { if (!renameMode) setNameDraft(documentName); }, [documentName, renameMode]);
  const commitDocumentName = useCallback(() => {
    const next = nameDraft.trim();
    if (next && next.length <= 100) onRenameDocument?.(next);
    setRenameMode(false);
  }, [nameDraft, onRenameDocument]);

  useLayoutEffect(() => {
    if (canvasTextEditNodeId === undefined || canvasTextCaret === undefined || canvasTextSelectionAnchor === undefined) return;
    const editor = canvasTextEditorRef.current;
    if (!editor) return;
    editor.focus({ preventScroll: true });
    if (canvasTextSelectionAnchor === canvasTextCaret) placeContentEditableCaret(editor, canvasTextCaret);
    else placeContentEditableSelection(editor, canvasTextSelectionAnchor, canvasTextCaret);
  }, [canvasTextCaret, canvasTextEditNodeId, canvasTextSelectionAnchor]);

  useEffect(() => {
    const task = window.setTimeout(() => setDeterministicEvidenceCapture(isDeterministicEvidenceCapture()), 0);
    return () => window.clearTimeout(task);
  }, []);

  const post = useCallback((message: MainToWorker, transfer?: Transferable[]) => workerRef.current?.postMessage(message, transfer ?? []), []);
  const requestCanvasCaretLayout = useCallback((nodeId: string, text: string, targetUtf16: number) => {
    const requestId = createId();
    pendingCanvasCaretLayoutsRef.current.set(requestId, { nodeId, text, targetUtf16 });
    post({ type: "text-caret-layout", requestId, nodeId, text });
  }, [post]);
  useEffect(() => {
    if (!needsCanvasTextCaretRecoveryRef.current || !canvasTextEdit || canvasTextEdit.rustCaretReady || snapshot.documentCore !== "Rust/WASM bridge ready") return;
    const node = snapshot.nodes.find((candidate) => candidate.id === canvasTextEdit.nodeId && candidate.kind === "text" && (candidate.pageId ?? defaultPageId) === snapshot.activePageId);
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
    requestCanvasCaretLayout(canvasTextEdit.nodeId, canvasTextEdit.draft, canvasTextEdit.caret);
  }, [canvasTextEdit, post, requestCanvasCaretLayout, snapshot.activePageId, snapshot.documentCore, snapshot.nodes]);
  const postInput = useCallback((events: readonly EditorInputEvent[]) => {
    const buffer = encodeInputBatch(events);
    workerRef.current?.postMessage({ type: "input", buffer } satisfies MainToWorker, [buffer]);
  }, []);
  /** Registers the exact asset bytes with document.fonts before a native
   * textarea is allowed to edit that text. The Canvas Worker performs the same
   * registration with its own FontFaceSet, so neither side silently falls back
   * to a different font while an edit session is open. */
  const ensureMainFontFace = useCallback(async (documentId: string, asset: DocumentAsset, suppliedBytes?: ArrayBuffer) => {
    if (!asset.mediaType.startsWith("font/")) return undefined;
    const registry = mainFontFacesRef.current;
    const knownFamily = registry.familyFor(asset.assetId);
    if (knownFamily) return knownFamily;
    if (suppliedBytes) mainFontBytesRef.current.set(asset.assetId, suppliedBytes.slice(0));
    let source = mainFontBytesRef.current.get(asset.assetId);
    if (!source) {
      try {
        source = await new AssetApiTransport({ baseUrl: assetApiUrl, tenantId: localDevTenantId, actorId: localDevActorId }).download(documentId, asset.assetId);
        mainFontBytesRef.current.set(asset.assetId, source.slice(0));
      } catch {
        return undefined;
      }
    }
    const target = typeof document === "undefined" ? undefined : document.fonts;
    const create = typeof FontFace === "function"
      ? (family: string, bytes: ArrayBuffer) => new FontFace(family, bytes)
      : undefined;
    return registry.load(asset.assetId, source.slice(0), target, create);
  }, []);
  const rehydrateFromRemote = useCallback(async (documentId: string) => {
    const snapshot = await new DocumentApiTransport({ baseUrl: documentApiUrl, tenantId: localDevTenantId, actorId: localDevActorId }).loadSnapshot(documentId);
    // Transfer the opaque bytes straight back to the Worker; TypeScript never
    // creates a second document representation while reconciling.
    post({ type: "remote-hydrate", snapshot }, [snapshot.buffer]);
  }, [post]);
  const reconcilePendingOperations = useCallback(async (documentId: string) => {
    const [snapshot, storedOperations] = await Promise.all([
      new DocumentApiTransport({ baseUrl: documentApiUrl, tenantId: localDevTenantId, actorId: localDevActorId }).loadSnapshot(documentId),
      loadPendingRemoteOperations(),
    ]);
    const normalizedDocumentId = documentId.replaceAll("-", "").toLowerCase();
    const operations = storedOperations.filter((operation) => operation.documentId.replaceAll("-", "").toLowerCase() === normalizedDocumentId);
    post({ type: "remote-reconcile", snapshot, operations }, [snapshot.buffer]);
  }, [post]);
  const synchronizePendingOperations = useCallback((
    nextOperation?: import("@/lib/editor-protocol").PendingRemoteOperation,
    reconciliation?: { removeOperationIds: string[]; replacements: import("@/lib/editor-protocol").PendingRemoteOperation[]; discardedOperationIds: string[]; coreRejectedOperationIds: string[]; blockedOperationIds: string[]; rejectionDiagnostics: string[] },
  ) => {
    const task = remoteSyncQueue.current
      .catch(() => undefined)
      .then(async () => {
        if (reconciliation) {
          await replacePendingRemoteOperations(reconciliation.removeOperationIds, reconciliation.replacements);
          if (reconciliation.blockedOperationIds.length) {
            setStatus("Engine worker online · an older pending operation needs manual recovery");
            return undefined;
          }
        } else if (nextOperation) await appendPendingRemoteOperation(nextOperation);
        const synchronizer = new PendingOperationSynchronizer({
          load: loadPendingRemoteOperations,
          replace: replacePendingRemoteOperation,
          remove: removePendingRemoteOperation,
        }, new DocumentApiTransport({ baseUrl: documentApiUrl, tenantId: localDevTenantId, actorId: localDevActorId }));
        const report = await synchronizer.flush();
        if (report.reconciliationRequiredOperationIds.length) {
          setStatus("Engine worker online · remote reconciliation required");
          await reconcilePendingOperations(nextOperation?.documentId ?? reconciliation?.replacements[0]?.documentId ?? snapshotRef.current.documentId).catch(() => setStatus("Engine worker online · remote snapshot unavailable"));
        }
        else if (report.retryingOperationIds.length) setStatus("Engine worker online · remote sync retrying");
        else if (report.acceptedOperationIds.length) setStatus("Engine worker online · remote changes saved");
        return report;
      })
      .catch(() => {
        setStatus("Engine worker online · remote sync retrying");
        return undefined;
      });
    remoteSyncQueue.current = task.then(() => undefined);
    return task;
  }, [reconcilePendingOperations]);
  const command = useCallback((next: EditorCommand) => {
    if (safeMode) { setStatus("Engine worker safe mode · reload to retry"); return; }
    if (changesDocument(next) && !writerRef.current) { setStatus("Engine worker online · read-only tab"); return; }
    if (next.type === "reset") {
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
      const projected = applyOptimisticUpdates(confirmedSnapshotRef.current, optimisticUpdatesRef.current.values());
      snapshotRef.current = projected;
      setDocumentState(projected);
    }
  }, [post, safeMode]);
  const reorderSelectedLayers = useCallback((action: LayerOrderAction) => {
    const current = snapshotRef.current;
    const pageNodes = current.nodes.filter((node) => (node.pageId ?? defaultPageId) === current.activePageId);
    const resolved = resolveLayerOrder(pageNodes, current.selectedIds, action);
    if (resolved) command({ type: "reposition", positionIds: [...resolved.positionIds].map(([id, positionId]) => ({ id, positionId })) });
  }, [command]);
  const recoverWorker = useCallback((reason: "error" | "message-error") => {
    if (recoveryStabilityTimerRef.current) clearTimeout(recoveryStabilityTimerRef.current);
    const plan = planWorkerRecovery(recoveryFailuresRef.current);
    if (plan.mode === "safe-mode") {
      transactionQueueRef.current?.reset();
      optimisticUpdatesRef.current.clear();
      workerRef.current?.terminate();
      workerRef.current = null;
      setSafeMode(true);
      setError("Engine Worker 连续异常，已进入安全模式；已确认的本地快照保持不变，请刷新后重试。");
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
    setCanvasTextEdit((current) => current ? { ...current, rustCaretReady: false, rustCaretLayout: undefined } : current);
    workerRef.current?.terminate();
    workerRef.current = null;
    setError(undefined);
    setStatus(`Engine worker recovering after ${reason}`);
    recoveryTimerRef.current = setTimeout(() => setCanvasGeneration((generation) => generation + 1), 150);
  }, []);

  useEffect(() => () => {
    if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
    if (recoveryStabilityTimerRef.current) clearTimeout(recoveryStabilityTimerRef.current);
    if (viewportCheckpointTimerRef.current) clearTimeout(viewportCheckpointTimerRef.current);
  }, []);

  useEffect(() => {
    if (!remoteSync) return;
    const retry = () => { void synchronizePendingOperations(); };
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
        worker.postMessage({ type: "transaction", transaction } satisfies MainToWorker);
        return true;
      },
    });
    transactionQueueRef.current = queue;
    return () => {
      queue.reset();
      if (transactionQueueRef.current === queue) transactionQueueRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mainThreadMonitoringEnabled) return;
    if (!("PerformanceObserver" in globalThis)) {
      const unavailable = setTimeout(() => setMainThreadMonitor("unavailable"), 0);
      return () => clearTimeout(unavailable);
    }
    try {
      const observer = new PerformanceObserver((entries) => {
        setMainThreadLongTasks((current) => entries.getEntries().reduce(
          (summary, entry) => recordMainThreadLongTask(summary, entry.duration),
          current,
        ));
      });
      observer.observe({ type: "longtask" });
      return () => observer.disconnect();
    } catch {
      const unavailable = setTimeout(() => setMainThreadMonitor("unavailable"), 0);
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
    const batcher = createInputTransferBatcher((events) => postInput(events), undefined, (durationMs) => {
      inputBacklogSamplerRef.current.record(durationMs);
      setInputBacklog(inputBacklogSamplerRef.current.summary());
    });
    inputBatcherRef.current = batcher;
    return () => {
      batcher.dispose();
      if (inputBatcherRef.current === batcher) inputBatcherRef.current = null;
    };
  }, [postInput]);

  useEffect(() => {
    if (!writerLock) {
      writerRef.current = accessPreference === "edit";
      setWriterMode(accessPreference === "edit" ? "owner" : "read-only");
      setStatus(accessPreference === "edit" ? "Engine worker online · server conflict protection active" : "Engine worker online · view-only mode");
      return () => { writerRef.current = false; };
    }
    const channel = new BroadcastChannel(writerLockName);
    const optimisticUpdates = optimisticUpdatesRef.current;
    editIntentRef.current ??= { at: Date.now(), id: createId() };
    channelRef.current = channel;
    channel.onmessage = ({ data }: MessageEvent<TabMessage>) => {
      if (data.type === "snapshot" && !writerRef.current) {
        post({ type: "command", command: { type: "hydrate", snapshot: data.snapshot } });
        setStatus("Engine worker online · read-only copy updated");
      }
      if (data.type === "request-edit" && writerRef.current && newerEditIntent(data.intent, editIntentRef.current!)) {
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
        setStatus("Engine worker online · local editing (Web Locks unavailable)");
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
        await navigator.locks!.request(name, { ifAvailable: true }, async (lock) => callback(lock));
      },
      onMode: (mode) => {
        writerRef.current = mode === "owner";
        setWriterMode(mode);
        if (mode === "owner") setStatus("Engine worker online · writer lease acquired");
        if (mode === "read-only") {
          setStatus("Engine worker online · requesting edit handoff");
          channel.postMessage({ type: "request-edit", intent: editIntentRef.current! } satisfies TabMessage);
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
  }, [accessPreference, post, writerLock]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (transferredCanvasRef.current === canvas) {
      setCanvasGeneration((generation) => generation + 1);
      return;
    }
    if (!("transferControlToOffscreen" in canvas)) { setError("此浏览器不支持 OffscreenCanvas，无法启动独立画布引擎。"); return; }
    fixtureAssetsSeededRef.current = false;
    fixtureAssetNodesCreatedRef.current = false;
    remoteBootstrapRequestedRef.current = false;
    const worker = new Worker(new URL("../../workers/editor.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    let disposed = false;
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
    const resize = () => post({ type: "resize", width: canvas.clientWidth, height: canvas.clientHeight, dpr: window.devicePixelRatio || 1 });
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    worker.onmessage = async ({ data }: MessageEvent<WorkerToMain>) => {
      if (data.type === "ready") {
        setStatus("Engine worker online");
        setMainThreadLongTasks(emptyMainThreadLongTaskSummary());
        setMainThreadMonitor("monitoring");
        setMainThreadMonitoringEnabled(true);
        void prepareLocalStorage().then((health) => {
          if (health.lowSpace) setStorageNotice("local storage space low");
          else if (!health.persistentStorageGranted) setStorageNotice("browser may evict local data");
          else if (!health.opfsAvailable) setStorageNotice("IndexedDB snapshot fallback");
        }).catch(() => setStorageNotice("local storage status unavailable"));
        try {
          const recoverySnapshot = recoverySnapshotRef.current;
          const local = recoverySnapshot ?? fixtureSnapshot ?? await loadLocalDocument(documentId);
          if (local) {
            if (recoverySnapshot) setStatus("Engine worker online · recovered confirmed snapshot");
            else if (fixtureSnapshot) setStatus(`Engine worker online · ${fixtureStatus}`);
            else if ("recoveredFromPrevious" in local && local.recoveredFromPrevious) setStatus("Engine worker online · restored previous local snapshot");
            post({ type: "command", command: { type: "hydrate", snapshot: local } });
          }
        } catch { setStatus("Engine worker online · local save unavailable"); }
        restoredRef.current = true;
        // Hydration starts an async WASM bridge load. Post on the next task so
        // the worker has registered that load before it records the bootstrap
        // request; the worker then emits only the final canonical state.
        if (!fixtureSnapshot && remoteSync) setTimeout(() => {
          if (!disposed) post({ type: "remote-bootstrap" });
        }, 0);
      }
      if (data.type === "remote-bootstrap") {
        if (!remoteSync || resetPendingRef.current) return;
        if (!restoredRef.current || fixtureSnapshot || remoteBootstrapRequestedRef.current) return;
        remoteBootstrapRequestedRef.current = true;
        const transport = new DocumentApiTransport({ baseUrl: documentApiUrl, tenantId: localDevTenantId, actorId: localDevActorId });
        const synchronizeThenHydrate = async (knownRemoteSnapshot?: Uint8Array) => {
          const report = await synchronizePendingOperations();
          if (disposed) return;
          if (!report || report.retryingOperationIds.length) {
            retryRemoteBootstrap();
            return;
          }
          // The reconciliation request already transfers the authoritative
          // snapshot and replays valid local pending intents in the Worker. A
          // second plain hydrate here would immediately overwrite that replay.
          if (report.reconciliationRequiredOperationIds.length) return;
          const changedRemote = report.acceptedOperationIds.length > 0 || report.reconciliationRequiredOperationIds.length > 0;
          const remoteSnapshot = changedRemote || !knownRemoteSnapshot
            ? await transport.loadSnapshot(data.documentId)
            : knownRemoteSnapshot;
          if (!disposed) {
            post({ type: "remote-hydrate", snapshot: remoteSnapshot }, [remoteSnapshot.buffer]);
            setStatus(report.reconciliationRequiredOperationIds.length
              ? "Engine worker online · remote reconciliation required"
              : "Engine worker online · remote document loaded");
          }
        };
        try {
          // A normal restart must not intentionally trigger a 409 just to learn
          // that the durable root already exists. Pending local operations must
          // reach the service before its older snapshot can replace local state.
          const remoteSnapshot = await transport.loadSnapshot(data.documentId);
          if (!disposed) await synchronizeThenHydrate(remoteSnapshot);
        } catch (reason) {
          if (reason instanceof Error && reason.message === "REMOTE_DOCUMENT_MISSING") {
            try {
              const result = await transport.createDocument(data.documentId, data.snapshot);
              if (!disposed) {
                if (result === "created") {
                  // The adopted root already contains every local operation up
                  // through this canonical snapshot revision.
                  remoteAdoptedRevisionRef.current = { documentId: data.documentId, revision: data.revision };
                  await removePendingRemoteOperationsCoveredBySnapshot(data.documentId, data.revision);
                }
                setStatus(result === "created" ? "Engine worker online · remote document created" : "Engine worker online · remote document verified");
                await synchronizeThenHydrate(result === "created" ? data.snapshot : undefined);
              }
            } catch (createReason) {
              if (!disposed && createReason instanceof Error && createReason.message === "REMOTE_DOCUMENT_CONFLICT") {
                setStatus("Engine worker online · remote reconciliation required");
                void rehydrateFromRemote(data.documentId).then(() => setStatus("Engine worker online · remote snapshot applied")).catch(() => setStatus("Engine worker online · remote snapshot unavailable"));
              } else if (!disposed) {
                setStatus("Engine worker online · remote document unavailable");
                retryRemoteBootstrap();
              }
            }
          } else if (!disposed && reason instanceof Error && reason.message === "REMOTE_DOCUMENT_CONFLICT") {
            setStatus("Engine worker online · remote reconciliation required");
            void rehydrateFromRemote(data.documentId).then(() => setStatus("Engine worker online · remote snapshot applied")).catch(() => setStatus("Engine worker online · remote snapshot unavailable"));
          } else if (!disposed) {
            setStatus("Engine worker online · remote document unavailable");
            retryRemoteBootstrap();
          }
        }
      }
      if (data.type === "remote-reset" && !disposed && !fixtureSnapshot) {
        const resetTask = remoteSyncQueue.current
          .catch(() => undefined)
          .then(async () => {
            setStatus("Engine worker online · saving demo reset");
            const transport = new DocumentApiTransport({ baseUrl: documentApiUrl, tenantId: localDevTenantId, actorId: localDevActorId });
            await transport.resetDocument(data.documentId, data.snapshot);
            const pending = await loadPendingRemoteOperations();
            const normalizedDocumentId = data.documentId.replaceAll("-", "").toLowerCase();
            await replacePendingRemoteOperations(
              pending.filter((operation) => operation.documentId.replaceAll("-", "").toLowerCase() === normalizedDocumentId).map((operation) => operation.operationId),
              [],
            );
            remoteAdoptedRevisionRef.current = { documentId: data.documentId, revision: data.revision };
            resetPendingRef.current = false;
            setStatus("Engine worker online · demo reset saved");
          })
          .catch(async () => {
            resetPendingRef.current = false;
            setStatus("Engine worker online · demo reset could not be saved");
            await rehydrateFromRemote(data.documentId).catch(() => setStatus("Engine worker online · remote snapshot unavailable"));
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
        const alreadyRepresented = adopted && pendingOperationIsCoveredBySnapshot(data.operation, adopted.documentId, adopted.revision);
        if (!disposed && remoteSync && !fixtureSnapshot && !alreadyRepresented) void synchronizePendingOperations(data.operation);
      }
      if (data.type === "remote-reconciled" && !disposed && remoteSync && !fixtureSnapshot) {
        if (data.coreRejectedOperationIds.length) setStatus("Engine worker online · local operations conflict with the remote document");
        else if (data.discardedOperationIds.length) setStatus(`Engine worker online · ${data.rejectionDiagnostics[0] ?? "invalid local operations were discarded during reconciliation"}`);
        void synchronizePendingOperations(undefined, data);
      }
      if (data.type === "text-caret-layout") {
        const pending = pendingCanvasCaretLayoutsRef.current.get(data.requestId);
        pendingCanvasCaretLayoutsRef.current.delete(data.requestId);
        if (!disposed && pending && data.layout && pending.nodeId === data.nodeId && pending.text === data.text) {
          const layout: RustTextCaretLayout = data.layout;
          setCanvasTextEdit((current) => {
            if (!current || current.nodeId !== pending.nodeId || current.draft !== pending.text) return current;
            const caret = snapUtf16CaretToRustLayout(current.draft, pending.targetUtf16, layout);
            return { ...current, caret, selectionAnchor: caret, rustCaretReady: true, rustCaretLayout: layout };
          });
        }
      }
      if (data.type === "snapshot") {
        if (
          fixtureAssetSeeds.length
          && !fixtureAssetsSeededRef.current
          && data.snapshot.documentCore === "Rust/WASM bridge ready"
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
              post({ type: "register-asset", transactionId: createId(), asset });
              const bytes = decodeFixtureAssetBytes(seed);
              if (asset.mediaType.startsWith("font/")) void ensureMainFontFace(data.snapshot.documentId, asset, bytes.slice(0));
              post({ type: "asset-bytes", assetId: asset.assetId, mediaType: asset.mediaType, bytes }, [bytes]);
            }
          } catch {
            setStatus("Engine worker online · fixture asset unavailable");
          }
        }
        if (
          fixtureAssetNodes.length
          && fixtureAssetsSeededRef.current
          && !fixtureAssetNodesCreatedRef.current
          && fixtureAssetSeeds.every((asset) => data.snapshot.assets?.some((candidate) => candidate.assetId === asset.assetId))
        ) {
          fixtureAssetNodesCreatedRef.current = true;
          post({
            type: "transaction",
            transaction: {
              id: createId(),
              baseRevision: data.snapshot.revision,
              commands: fixtureAssetNodes.map((node) => ({ type: "create" as const, node })),
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
        const projectedSnapshot = applyOptimisticUpdates(data.snapshot, optimisticUpdatesRef.current.values());
        snapshotRef.current = projectedSnapshot;
        const pendingImage = pendingImagePlacementRef.current;
        if (pendingImage && data.snapshot.assets?.some((asset) => asset.assetId.replaceAll("-", "") === pendingImage.assetId.replaceAll("-", ""))) {
          pendingImagePlacementRef.current = undefined;
          const target = pendingImage.targetId ? data.snapshot.nodes.find((node) => node.id === pendingImage.targetId && !node.locked && ["frame", "rectangle", "ellipse", "image"].includes(node.kind)) : undefined;
          transactionQueueRef.current?.enqueue([target
            ? { type: "update", id: target.id, patch: { assetId: pendingImage.assetId } }
            : { type: "create", node: importedImageNode(pendingImage, data.snapshot.viewport) },
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
            if (recoveryStabilityTimerRef.current) clearTimeout(recoveryStabilityTimerRef.current);
            recoveryStabilityTimerRef.current = setTimeout(() => { recoveryFailuresRef.current = 0; }, 5_000);
          }
        }
        setDocumentState(projectedSnapshot);
        if (documentId && data.snapshot.revision > 0) onDocumentSaved?.(data.snapshot.revision);
        setSelectionState({ selectedIds: projectedSnapshot.selectedIds });
        setViewState({ viewport: projectedSnapshot.viewport, performance: projectedSnapshot.performance });
        if (data.snapshot.localSnapshot && simulatedWorkerCrashesRef.current < simulateWorkerCrashes && !crashSimulationTimer) {
          simulatedWorkerCrashesRef.current += 1;
          crashSimulationTimer = setTimeout(() => {
            if (!disposed && workerRef.current === worker) worker.postMessage({ type: "simulate-crash" } satisfies MainToWorker);
          }, simulateWorkerCrashDelayMs);
        }
        if (restoredRef.current && writerRef.current && !fixtureSnapshot && data.snapshot.localSnapshot) {
          const { localJournalEntry, localSnapshot } = data.snapshot;
          persistenceQueue.current = persistenceQueue.current
            .catch(() => undefined)
            .then(async () => {
              if (localJournalEntry) await appendLocalJournalEntry(localJournalEntry, documentId);
              await saveLocalDocument(localSnapshot, documentId);
              channelRef.current?.postMessage({ type: "snapshot", snapshot: localSnapshot } satisfies TabMessage);
            })
            .catch((reason: unknown) => setStatus(reason instanceof Error && reason.message === "LOCAL_STORAGE_QUOTA_EXCEEDED" ? "Engine worker online · local storage is full" : "Engine worker online · save paused"));
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
        setSelectionState((current) => sameIds(current.selectedIds, data.selectedIds) ? current : { selectedIds: data.selectedIds });
        setViewState({ viewport: data.viewport, performance: data.performance });
        snapshotRef.current = { ...snapshotRef.current, viewport: data.viewport, selectedIds: data.selectedIds, performance: data.performance };
        if (data.viewportChanged && restoredRef.current && writerRef.current && !fixtureSnapshot) {
          if (viewportCheckpointTimerRef.current) clearTimeout(viewportCheckpointTimerRef.current);
          viewportCheckpointTimerRef.current = setTimeout(() => {
            viewportCheckpointTimerRef.current = undefined;
            if (writerRef.current) post({ type: "checkpoint" });
          }, 500);
        }
      }
      if (data.type === "viewport-checkpoint" && restoredRef.current && writerRef.current && !fixtureSnapshot) {
        persistenceQueue.current = persistenceQueue.current
          .catch(() => undefined)
          .then(async () => {
            const startedAt = performance.now();
            await saveViewportRecord({ format: "viewport-record-v1", viewport: data.viewport, documentHash: data.documentHash, coreRevision: data.coreRevision }, documentId);
            viewportCheckpointSamplerRef.current.record(performance.now() - startedAt);
            setViewportCheckpoints(viewportCheckpointSamplerRef.current.summary());
          })
          .catch(() => setStatus("Engine worker online · viewport save paused"));
      }
      if (data.type === "ack") {
        if (data.acceptedRevision !== undefined) revisionRef.current = data.acceptedRevision;
        const acknowledgement = transactionQueueRef.current?.acknowledge(data);
        if (acknowledgement?.handled && !acknowledgement.retried) {
          optimisticUpdatesRef.current.delete(data.transactionId);
          const projected = applyOptimisticUpdates(confirmedSnapshotRef.current, optimisticUpdatesRef.current.values());
          snapshotRef.current = projected;
          setDocumentState(projected);
          setSelectionState({ selectedIds: projected.selectedIds });
          setViewState({ viewport: projected.viewport, performance: projected.performance });
        }
        if (data.errorCode) setStatus(`Engine worker online · ${data.errorCode.toLowerCase().replaceAll("_", " ")}`);
      }
      if (data.type === "tool") setTool(data.tool);
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
    post({ type: "init", canvas: offscreen, width: canvas.clientWidth, height: canvas.clientHeight, dpr: window.devicePixelRatio || 1, documentId, rendererPreference, simulateGpuLosses, simulateGpuLossAfterImage, simulateGpuFault }, [offscreen]);
    return () => { disposed = true; if (crashSimulationTimer) clearTimeout(crashSimulationTimer); if (remoteBootstrapRetryTimer) clearTimeout(remoteBootstrapRetryTimer); observer.disconnect(); worker.terminate(); if (workerRef.current === worker) workerRef.current = null; };
  }, [canvasGeneration, documentId, ensureMainFontFace, fixtureAssetNodes, fixtureAssetSeeds, fixtureSnapshot, fixtureStatus, onDocumentSaved, post, recoverWorker, rehydrateFromRemote, remoteSync, rendererPreference, simulateGpuFault, simulateGpuLossAfterImage, simulateGpuLosses, simulateWorkerCrashDelayMs, simulateWorkerCrashes, synchronizePendingOperations]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const input: EditorInputEvent = { type: "wheel", x: event.clientX - rect.left, y: event.clientY - rect.top, deltaX: event.deltaX, deltaY: event.deltaY, ctrlKey: event.ctrlKey || event.metaKey, occurredAt: Date.now() };
      const batcher = inputBatcherRef.current;
      if (batcher) batcher.enqueue(input);
      else postInput([input]);
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => canvas.removeEventListener("wheel", wheel);
  }, [canvasGeneration, postInput]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).matches("input, textarea, [contenteditable=\"true\"]")) return;
      const match = tools.find((entry) => entry.key.toLowerCase() === event.key.toLowerCase());
      if (safeMode) return;
      if (match && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        if (writerRef.current || match.id === "select" || match.id === "hand") {
          setTool(match.id);
          post({ type: "tool", tool: match.id });
        } else setStatus("Engine worker online · read-only tab");
      }
      if ((event.metaKey || event.ctrlKey) && ["d", "g"].includes(event.key.toLowerCase())) event.preventDefault();
      if ((event.metaKey || event.ctrlKey) && ["[", "]"].includes(event.key) && writerRef.current) {
        event.preventDefault();
        const direction: LayerOrderAction = event.key === "]" ? (event.shiftKey ? "front" : "forward") : (event.shiftKey ? "back" : "backward");
        reorderSelectedLayers(direction);
        return;
      }
      if (writerRef.current) post({ type: "key", key: event.key, metaKey: event.metaKey || event.ctrlKey, shiftKey: event.shiftKey });
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [post, reorderSelectedLayers, safeMode]);

  // Viewport updates replace `snapshot`, but keep the document and selection
  // references stable. Depending on the whole snapshot made every zoom frame
  // linearly scan all 50K nodes just to rediscover that nothing is selected.
  const selectedNodes = useMemo(() => {
    const ids = new Set(snapshot.selectedIds);
    return snapshot.nodes.filter((node) => ids.has(node.id));
  }, [snapshot.nodes, snapshot.selectedIds]);
  const selected = selectedNodes.length === 1 ? selectedNodes[0] : undefined;
  const canEdit = accessPreference === "edit" && writerMode === "owner" && !safeMode;
  const accessLabel = safeMode
    ? "安全模式"
    : accessPreference === "view"
      ? "只读"
      : writerMode === "owner"
        ? "可编辑"
        : "申请编辑中";
  const renderEvidence = deterministicEvidenceCapture ? "collecting render evidence" : snapshot.performance?.samples ? `render P95 ${snapshot.performance.p95Ms.toFixed(1)}ms · ${snapshot.diagnostics?.total ?? 0} diagnostics` : "collecting render evidence";
  const renderPerformanceEvidence = snapshot.performance ? JSON.stringify(snapshot.performance) : undefined;
  const mainThreadEvidence = mainThreadMonitor === "waiting"
    ? "main task monitor starting"
    : mainThreadMonitor === "unavailable"
    ? "main-task monitor unavailable"
    : mainThreadLongTasks.count
      ? `main ${mainThreadLongTasks.count} long tasks · worst ${mainThreadLongTasks.maxDurationMs.toFixed(0)}ms`
      : "main 0 long tasks";
  const frameEvidence = frameIntervals.samples ? `frame P95 ${frameIntervals.p95Ms.toFixed(1)}ms` : "collecting frame intervals";
  const inputBacklogEvidence = snapshot.performance?.inputToRenderSamples
    ? `input→render P95 ${snapshot.performance.inputToRenderP95Ms.toFixed(1)}ms · backlog P95 ${inputBacklog.p95Ms.toFixed(1)}ms`
    : inputBacklog.samples ? `collecting input→render · backlog P95 ${inputBacklog.p95Ms.toFixed(1)}ms` : "collecting input latency";
  const viewportCheckpointEvidence = viewportCheckpoints.samples ? `viewport checkpoint P95 ${viewportCheckpoints.p95Ms.toFixed(1)}ms` : "collecting viewport checkpoints";
  const resourceEvidence = snapshot.resources ? `${snapshot.assets?.length ?? 0} assets · ${snapshot.resources.documentNodes}/${snapshot.resources.maxDocumentNodes} nodes · ${(snapshot.resources.documentBytes / 1024 / 1024).toFixed(1)}/${(snapshot.resources.maxDocumentBytes / 1024 / 1024).toFixed(0)} MB document · ${(snapshot.resources.wasmHeapBytes / 1024 / 1024).toFixed(1)}/${(snapshot.resources.maxWasmHeapBytes / 1024 / 1024).toFixed(0)} MB WASM · ${(snapshot.resources.renderSurfaceBytes / 1024 / 1024).toFixed(1)}/${(snapshot.resources.maxRenderSurfaceBytes / 1024 / 1024).toFixed(0)} MB surface · ${(snapshot.resources.gpuSceneBytes / 1024 / 1024).toFixed(1)}/${(snapshot.resources.maxGpuSceneBytes / 1024 / 1024).toFixed(0)} MB GPU scene${snapshot.resources.gpuSceneWithinBudget ? "" : " (Canvas fallback)"}` : "collecting resource evidence";
  const setActiveTool = useCallback((next: ToolKind) => {
    if (safeMode) return;
    if (!writerRef.current && next !== "select" && next !== "hand") {
      setStatus("Engine worker online · read-only tab");
      return;
    }
    setTool(next);
    post({ type: "tool", tool: next });
  }, [post, safeMode]);
  const pointer = (event: React.PointerEvent<HTMLCanvasElement>, type: "down" | "move" | "up" | "leave") => {
    if (safeMode) return;
    const readOnly = !writerRef.current;
    if (readOnly && tool !== "select" && tool !== "hand") {
      setStatus("Engine worker online · read-only tab");
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const packet: EditorInputEvent = { type: "pointer", event: type, x: event.clientX - rect.left, y: event.clientY - rect.top, shiftKey: event.shiftKey, altKey: event.altKey, button: event.button, occurredAt: Date.now(), ...(readOnly ? { readOnly: true } : {}) };
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
  const drillDownAtCanvasPoint = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const readOnly = !writerRef.current;
    const base = { type: "pointer" as const, x: event.clientX - rect.left, y: event.clientY - rect.top, shiftKey: event.shiftKey, altKey: event.altKey, button: event.button, occurredAt: Date.now(), ...(readOnly ? { readOnly: true as const } : {}) };
    // PointerEvent does not reliably carry a click count. The browser's native
    // double-click event is the authoritative boundary, so replay a no-motion
    // press/release pair with the explicit Group drill-down intent.
    postInput([{ ...base, event: "down", drillDown: true }, { ...base, event: "up" }]);
  };
  const startCanvasTextEdit = async (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canEdit) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point = {
      x: (event.clientX - rect.left - rect.width / 2) / snapshot.viewport.zoom - snapshot.viewport.x,
      y: (event.clientY - rect.top - rect.height / 2) / snapshot.viewport.zoom - snapshot.viewport.y,
    };
    const target = [...snapshot.nodes].reverse().find((node) => textNodeContainsPoint(node, point));
    if (!target) return;
    const fontAssetId = target.textProperties?.runs[0]?.font?.assetId;
    if (fontAssetId) {
      const fontAsset = snapshot.assets?.find((asset) => asset.assetId === fontAssetId);
      if (!fontAsset || !await ensureMainFontFace(snapshot.documentId, fontAsset)) {
        setStatus("Engine worker online · text font unavailable");
        return;
      }
    }
    command({ type: "select", ids: [target.id] });
    canvasTextCommitRef.current = false;
    post({ type: "editing-text", nodeId: target.id });
    const text = target.text ?? "";
    const caret = textCaretAtPoint(target, point);
    setCanvasTextEdit({ nodeId: target.id, draft: text, initialDraft: text, caret, selectionAnchor: caret, rustCaretReady: false });
    requestCanvasCaretLayout(target.id, text, caret);
  };
  const commitCanvasTextEdit = () => {
    if (!canvasTextEdit || canvasTextCommitRef.current || canvasTextIsComposingRef.current) return;
    canvasTextCommitRef.current = true;
    const node = snapshot.nodes.find((candidate) => candidate.id === canvasTextEdit.nodeId);
    if (node && canvasTextEdit.draft !== (node.text ?? "")) {
      command({ type: "update", id: node.id, patch: { text: canvasTextEdit.draft, textProperties: textReplacementProperties(node, canvasTextEdit.draft) } });
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
  const handleCanvasTextBeforeInput = useCallback((editor: HTMLDivElement, input: InputEvent) => {
    const edit = canvasTextEdit;
    if (!edit || canvasTextIsComposingRef.current || !edit.rustCaretReady || !edit.rustCaretLayout) return;
    const selection = contentEditableSelectionOffsets(editor);
    if (!selection) return;
    let replacement = "";
    let next: ReturnType<typeof replaceUtf16SelectionInRustLayout> | undefined;
    switch (input.inputType) {
      case "deleteContentBackward":
        next = deleteUtf16SelectionInRustLayout(edit.draft, selection.anchor, selection.focus, -1, edit.rustCaretLayout);
        break;
      case "deleteContentForward":
        next = deleteUtf16SelectionInRustLayout(edit.draft, selection.anchor, selection.focus, 1, edit.rustCaretLayout);
        break;
      case "insertText":
      case "insertReplacementText":
        if (input.data !== null) {
          replacement = input.data;
          next = replaceUtf16SelectionInRustLayout(edit.draft, selection.anchor, selection.focus, replacement, edit.rustCaretLayout);
        }
        break;
      case "insertLineBreak":
      case "insertParagraph":
        replacement = "\n";
        next = replaceUtf16SelectionInRustLayout(edit.draft, selection.anchor, selection.focus, replacement, edit.rustCaretLayout);
        break;
      default:
        return;
    }
    if (!next) return;
    input.preventDefault();
    replaceContentEditableRange(editor, next.replacedStart, next.replacedEnd, replacement);
    setCanvasTextEdit((current) => current && current.nodeId === edit.nodeId && current.draft === edit.draft
      ? { ...current, draft: next.draft, caret: next.caret, selectionAnchor: next.selectionAnchor, rustCaretReady: false, rustCaretLayout: undefined }
      : current);
    requestCanvasCaretLayout(edit.nodeId, next.draft, next.caret);
  }, [canvasTextEdit, requestCanvasCaretLayout]);
  const canvasTextNode = canvasTextEdit ? snapshot.nodes.find((node) => node.id === canvasTextEdit.nodeId && node.kind === "text") : undefined;
  useEffect(() => {
    const editor = canvasTextEditorRef.current;
    if (!editor || !canvasTextEdit) return;
    const listener = (event: InputEvent) => handleCanvasTextBeforeInput(editor, event);
    editor.addEventListener("beforeinput", listener);
    return () => editor.removeEventListener("beforeinput", listener);
  }, [canvasTextEdit, handleCanvasTextBeforeInput]);
  const canvasTextStyle = canvasTextNode ? (() => {
    const primary = canvasTextNode.textProperties?.runs[0];
    const fontFamily = primary?.font ? `"${fontFamilyForAsset(primary.font.assetId)}", ` : "";
    const fontSize = primary?.fontSize ?? 31;
    const lineHeight = canvasTextNode.textProperties?.paragraph.lineHeight ?? DEFAULT_TEXT_LINE_HEIGHT;
    return {
    left: `calc(50% + ${(canvasTextNode.x + snapshot.viewport.x) * snapshot.viewport.zoom}px)`,
    top: `calc(50% + ${(canvasTextNode.y + snapshot.viewport.y) * snapshot.viewport.zoom}px)`,
    width: `${Math.max(1, canvasTextNode.width * snapshot.viewport.zoom)}px`,
    height: `${Math.max(1, canvasTextNode.height * snapshot.viewport.zoom)}px`,
    fontSize: `${fontSize * snapshot.viewport.zoom}px`,
    lineHeight: `${lineHeight * snapshot.viewport.zoom}px`,
    fontFamily: `${fontFamily}${canvasDesignTokens.typography.canvasText.family}`,
    fontWeight: primary?.fontWeight ?? canvasDesignTokens.typography.canvasText.weight,
    fontStyle: primary?.italic ? "italic" : "normal",
    fontSynthesis: "none",
    letterSpacing: `${(primary?.letterSpacing ?? 0) * snapshot.viewport.zoom}px`,
    color: canvasTextNode.fill,
    textAlign: canvasTextNode.textProperties?.paragraph.alignment === "justify" ? "left" : canvasTextNode.textProperties?.paragraph.alignment ?? "left",
    transform: `rotate(${canvasTextNode.rotation}deg)`,
    transformOrigin: "center center",
  } as const;
  })() : undefined;
  const canvasTextEditParagraphs = canvasTextNode && canvasTextEdit
    ? textParagraphRanges(canvasTextEdit.initialDraft).map((paragraph) => ({
      ...paragraph,
      spans: styledTextSpans(canvasTextEdit.initialDraft, paragraph.start, paragraph.end, canvasTextNode.textProperties),
    }))
    : [];
  const update = (patch: Partial<CanvasNode>) => {
    if (patch.strokeWidth !== undefined && (!Number.isFinite(patch.strokeWidth) || patch.strokeWidth < 0)) return;
    if (patch.rotation !== undefined && !Number.isFinite(patch.rotation)) return;
    if (selected) command({ type: "update", id: selected.id, patch: resolveTextAutoSizePatch(selected, patch) });
  };
  const updateSelection = (patch: Partial<CanvasNode>) => {
    if (patch.strokeWidth !== undefined && (!Number.isFinite(patch.strokeWidth) || patch.strokeWidth < 0)) return;
    if (patch.rotation !== undefined && !Number.isFinite(patch.rotation)) return;
    if (selectedNodes.length === 1) { update(patch); return; }
    if (safeMode || !writerRef.current || selectedNodes.length < 2) return;
    // The queue resolves this array as one Core batch, so a multi-select edit
    // has one revision and one Undo item. Each node gets its own text-safe
    // projection rather than borrowing a value from the first selected node.
    transactionQueueRef.current?.enqueue(selectedNodes.map((node) => ({
      type: "update" as const,
      id: node.id,
      patch: resolveTextAutoSizePatch(node, patch),
    })));
  };
  const updateSelectionGeometry = (patch: Partial<Pick<CanvasNode, "x" | "y" | "width" | "height">>) => {
    if (safeMode || !writerRef.current || selectedNodes.length < 2) return;
    const current = snapshotRef.current;
    const resolved = selectionGeometryPatches(current.nodes, current.selectedIds, patch);
    if (!resolved) return;
    transactionQueueRef.current?.enqueue(resolved.selection.ids.map((id) => ({
      type: "update" as const,
      id,
      patch: resolved.patches.get(id)!,
    })));
  };
  const updateSelectionStrokeWeight = (index: number, value: number) => {
    if (!Number.isFinite(value) || value < 0 || safeMode || !writerRef.current || selectedNodes.length < 2 || !selectedNodes.every((node) => node.kind === "frame" || node.kind === "rectangle")) return;
    transactionQueueRef.current?.enqueue(selectedNodes.map((node) => {
      const weights = [...resolvedStrokeWeights(node)] as [number, number, number, number];
      weights[index] = value;
      return { type: "update" as const, id: node.id, patch: { strokeWeights: weights } };
    }));
  };
  const useSelectionUniformStrokeWeights = () => {
    if (safeMode || !writerRef.current || selectedNodes.length < 2 || !selectedNodes.every((node) => node.kind === "frame" || node.kind === "rectangle")) return;
    transactionQueueRef.current?.enqueue(selectedNodes.map((node) => ({ type: "update" as const, id: node.id, patch: { strokeWeights: undefined } })));
  };
  const updateSelectionCornerRadius = (index: number, value: number) => {
    if (!Number.isFinite(value) || value < 0 || safeMode || !writerRef.current || selectedNodes.length < 2 || !selectedNodes.every((node) => node.kind === "frame" || node.kind === "rectangle" || node.kind === "section")) return;
    transactionQueueRef.current?.enqueue(selectedNodes.map((node) => {
      const radii = [...resolvedCornerRadii(node)] as [number, number, number, number];
      radii[index] = value;
      return { type: "update" as const, id: node.id, patch: { cornerRadii: radii } };
    }));
  };
  const useSelectionUniformCornerRadius = () => {
    if (safeMode || !writerRef.current || selectedNodes.length < 2 || !selectedNodes.every((node) => node.kind === "frame" || node.kind === "rectangle" || node.kind === "section")) return;
    transactionQueueRef.current?.enqueue(selectedNodes.map((node) => ({ type: "update" as const, id: node.id, patch: { cornerRadii: undefined } })));
  };
  const updateSelectionConstraint = (axis: "horizontal" | "vertical", value: ConstraintType) => {
    if (safeMode || !writerRef.current || selectedNodes.length < 2 || !selectedNodes.every((node) => hasFrameConstraintScope(snapshotRef.current.nodes, node))) return;
    transactionQueueRef.current?.enqueue(selectedNodes.map((node) => ({
      type: "update" as const,
      id: node.id,
      patch: { constraints: { ...(node.constraints ?? { horizontal: "min" as const, vertical: "min" as const }), [axis]: value } },
    })));
  };
  const removeSelectionConstraints = () => {
    if (safeMode || !writerRef.current || selectedNodes.length < 2 || !selectedNodes.every((node) => hasFrameConstraintScope(snapshotRef.current.nodes, node))) return;
    transactionQueueRef.current?.enqueue(selectedNodes.map((node) => ({ type: "update" as const, id: node.id, patch: { constraints: undefined } })));
  };
  const selectCreationTool = useCallback((kind: Exclude<NodeKind, "image" | "group">) => setActiveTool(kind), [setActiveTool]);
  const selectLayer = useCallback((id: string, options?: { additive?: boolean }) => {
    const selected = snapshotRef.current.selectedIds;
    command({ type: "select", ids: resolveCanvasObjectSelection(selected, id, Boolean(options?.additive)) });
  }, [command]);
  const dropLayer = useCallback((draggedId: string, target?: { beforeId?: string; parentId?: string }) => {
    const current = snapshotRef.current;
    const pageNodes = current.nodes.filter((node) => (node.pageId ?? defaultPageId) === current.activePageId);
    const moving = current.selectedIds.includes(draggedId) ? current.selectedIds : [draggedId];
    if (target?.parentId) {
      command({ type: "reparent", ids: moving, parentId: target.parentId });
      return;
    }
    const resolved = resolveLayerDrop(pageNodes, moving, target?.beforeId);
    if (resolved) command({ type: "reposition", positionIds: [...resolved.positionIds].map(([id, positionId]) => ({ id, positionId })) });
  }, [command]);
  const nestLayer = useCallback((id: string, intent: LayerNestingIntent) => {
    const current = snapshotRef.current;
    const pageNodes = current.nodes.filter((node) => (node.pageId ?? defaultPageId) === current.activePageId);
    const target = layerKeyboardNestingTarget(pageNodes, id, intent);
    if (target) command({ type: "reparent", ids: [target.id], parentId: target.parentId });
  }, [command]);
  const renameLayer = useCallback((id: string, name: string) => {
    const next = name.trim();
    if (next) command({ type: "update", id, patch: { name: next } });
  }, [command]);
  const createFrame = useCallback(() => selectCreationTool("frame"), [selectCreationTool]);
  const createRectangle = useCallback(() => selectCreationTool("rectangle"), [selectCreationTool]);
  const createText = useCallback(() => selectCreationTool("text"), [selectCreationTool]);
  const groupSelected = useCallback(() => command({ type: "group", ids: snapshotRef.current.selectedIds }), [command]);
  const ungroupSelected = useCallback(() => {
    const current = snapshotRef.current;
    const group = current.selectedIds.length === 1 ? current.nodes.find((node) => node.id === current.selectedIds[0]) : undefined;
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
  const selectPage = useCallback((id: string) => {
    if (id === snapshotRef.current.activePageId) return;
    // A page switch cannot preserve a DOM host that is no longer on the active
    // canvas. Discard its uncommitted presentation draft rather than allowing
    // a stale selection to be committed into another page.
    canvasTextCommitRef.current = true;
    canvasTextIsComposingRef.current = false;
    pendingCanvasCaretLayoutsRef.current.clear();
    needsCanvasTextCaretRecoveryRef.current = false;
    post({ type: "editing-text" });
    setCanvasTextEdit(undefined);
    command({ type: "select-page", id });
  }, [command, post]);
  const createPage = useCallback(() => command({ type: "create-page", id: createId(), name: `Page ${snapshot.pages.length + 1}` }), [command, snapshot.pages.length]);
  const exportActivePageAsSvg = useCallback(() => {
    const current = snapshotRef.current;
    const result = exportPageToSvg(current.nodes, { pageId: current.activePageId, defaultPageId });
    const page = current.pages.find((candidate) => candidate.id === current.activePageId);
    const anchor = document.createElement("a");
    const url = URL.createObjectURL(new Blob([result.svg], { type: "image/svg+xml;charset=utf-8" }));
    anchor.href = url;
    anchor.download = `${svgFileStem(page?.name ?? "page")}.svg`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus(result.warnings.length ? "SVG exported · image fallback retained" : "SVG exported");
  }, []);
  const importAsset = useCallback(async (file: File) => {
    if (!canEdit) return;
    assetUploadAbortRef.current?.abort();
    const controller = new AbortController();
    assetUploadAbortRef.current = controller;
    setAssetImporting(true);
    const kind = file.type.startsWith("font/") || /\.(?:woff2?|ttf|otf)$/i.test(file.name) ? "font" : "raster-image" as const;
    let decodedRaster: DecodedRaster | undefined;
    try {
      setAssetStatus("Checking file");
      await waitForStabilityAssetReadDelay(controller.signal);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (controller.signal.aborted) throw new DOMException("The asset import was cancelled.", "AbortError");
      const probe = await probeAssetInWorker(kind, file.type, bytes, { signal: controller.signal });
      if (controller.signal.aborted) throw new DOMException("The asset import was cancelled.", "AbortError");
      if (!probe.admission.accepted) throw new Error(`ASSET_REJECTED_${probe.admission.reason}`);
      if (kind === "raster-image") {
        if (!probe.rasterDimensions) throw new Error("ASSET_REJECTED_CORRUPT_DATA");
        setAssetStatus("Decoding image");
        decodedRaster = await decodeRasterInWorker(probe.admission.mime, bytes, probe.rasterDimensions, { signal: controller.signal });
      }
      const transport = new AssetApiTransport({ baseUrl: assetApiUrl, tenantId: localDevTenantId, actorId: localDevActorId });
      setAssetStatus("Uploading asset");
      const uploaded = await transport.upload({ sessionId: createId(), kind, mediaType: probe.admission.mime, bytes, signal: controller.signal });
      if (controller.signal.aborted) throw new DOMException("The asset import was cancelled.", "AbortError");
      await transport.grantDocumentWriter(snapshot.documentId);
      await transport.attachToDocument(snapshot.documentId, uploaded.assetId);
      if (snapshot.assets?.some((asset) => asset.assetId.replaceAll("-", "") === uploaded.assetId.replaceAll("-", ""))) {
        const existing = snapshot.assets.find((asset) => asset.assetId.replaceAll("-", "") === uploaded.assetId.replaceAll("-", ""));
        if (kind === "font" && (!existing || !await ensureMainFontFace(snapshot.documentId, existing))) throw new Error("FONT_LOAD_FAILED");
        setAssetStatus(`${kind === "font" ? "Font" : "Image"} already available`);
        setStatus("Engine worker online · resource already registered");
        if (kind === "raster-image") {
          const placement = { assetId: uploaded.assetId, width: decodedRaster?.metadata.decoded.width, height: decodedRaster?.metadata.decoded.height };
          const target = imageFillTarget(snapshotRef.current.nodes, snapshotRef.current.selectedIds);
          transactionQueueRef.current?.enqueue([target
            ? { type: "update", id: target.id, patch: { assetId: placement.assetId } }
            : { type: "create", node: importedImageNode(placement, snapshotRef.current.viewport) },
          ]);
          setAssetStatus(target ? "Image applied as fill" : "Image added");
        }
        decodedRaster?.bitmap.close();
        decodedRaster = undefined;
        return;
      }
      if (kind === "raster-image") pendingImagePlacementRef.current = {
        assetId: uploaded.assetId,
        width: decodedRaster?.metadata.decoded.width,
        height: decodedRaster?.metadata.decoded.height,
        targetId: imageFillTarget(snapshot.nodes, snapshot.selectedIds)?.id,
      };
      const asset: DocumentAsset = {
        assetId: uploaded.assetId, contentHash: uploaded.contentHash, mediaType: uploaded.mediaType, byteLength: uploaded.byteLength,
        ...(probe.rasterDimensions ? { pixelWidth: probe.rasterDimensions.width, pixelHeight: probe.rasterDimensions.height } : {}),
      };
      if (kind === "font") {
        setAssetStatus("Loading font");
        const mainBytes = new Uint8Array(bytes).buffer;
        if (!await ensureMainFontFace(snapshot.documentId, asset, mainBytes)) throw new Error("FONT_LOAD_FAILED");
      }
      post({ type: "register-asset", transactionId: createId(), asset });
      if (decodedRaster) {
        post({ type: "asset-bytes", assetId: uploaded.assetId, mediaType: uploaded.mediaType, bytes: bytes.buffer, decodedBitmap: decodedRaster.bitmap }, [bytes.buffer, decodedRaster.bitmap]);
        decodedRaster = undefined;
      } else {
        post({ type: "asset-bytes", assetId: uploaded.assetId, mediaType: uploaded.mediaType, bytes: bytes.buffer }, [bytes.buffer]);
      }
      setAssetStatus(`${kind === "font" ? "Font" : "Image"} added`);
      setStatus("Engine worker online · resource registration queued");
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") {
        setAssetStatus("Import canceled");
        setStatus("Engine worker online · resource import canceled");
        return;
      }
      const code = reason instanceof Error ? reason.message.replace(/^ASSET_REJECTED_/, "") : "UPLOAD_FAILED";
      setAssetStatus(importFailureMessage(code));
    } finally {
      decodedRaster?.bitmap.close();
      if (assetUploadAbortRef.current === controller) assetUploadAbortRef.current = null;
      setAssetImporting(false);
    }
  }, [canEdit, ensureMainFontFace, post, snapshot.assets, snapshot.documentId, snapshot.nodes, snapshot.selectedIds]);
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
    <main className="editor-shell">
      <header className="topbar">
        {workspaceHref ? <button className="editor-back-button" type="button" onClick={() => window.location.assign(workspaceHref)} aria-label="返回工作区"><span aria-hidden="true">←</span><span>返回工作区</span></button> : <div className="brand"><span className="brand-mark">M</span><span>MAKE / FIGMA</span><small>alpha 01</small></div>}
        <div className="document-name"><span className="sync-dot" />{renameMode ? <input aria-label="文档名称" autoFocus maxLength={100} value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} onBlur={commitDocumentName} onKeyDown={(event) => { if (event.key === "Enter") commitDocumentName(); if (event.key === "Escape") { setNameDraft(documentName); setRenameMode(false); } }} /> : <button type="button" onClick={() => onRenameDocument && setRenameMode(true)} title={onRenameDocument ? "重命名文档" : undefined}>{documentName}</button>} <span>• saved locally</span></div>
        <div className="top-actions">
          <div className="access-toggle" role="group" aria-label="Document access mode">
            <button type="button" aria-pressed={accessPreference === "view"} onClick={() => setAccessMode("view")}>只读</button>
            <button type="button" aria-pressed={accessPreference === "edit"} onClick={() => setAccessMode("edit")} disabled={safeMode}>编辑</button>
            <span className={`access-state ${canEdit ? "is-editable" : ""}`} aria-live="polite">{accessLabel}</span>
          </div>
          <span className="engine-status">{snapshot.renderer} · {snapshot.gpu?.webgpu === "ready" ? snapshot.resources?.gpuSceneWithinBudget === false ? "GPU scene resource fallback" : snapshot.gpu.recoveryAttempts ? `WebGPU scene recovered (${snapshot.gpu.recoveryAttempts})` : "WebGPU scene active" : snapshot.gpu?.webgpu === "recovering" ? "recovering WebGPU scene" : snapshot.gpu?.webgpu === "unavailable" ? snapshot.gpu.recoveryAttempts ? `WebGPU recovery exhausted · ${snapshot.gpu.webgl2Available ? "WebGL2 available" : "GPU fallback"}` : (snapshot.gpu.webgl2Available ? "WebGL2 available" : "GPU fallback") : "checking GPU"}{snapshot.gpu?.developmentSimulation ? ` · device-loss simulation ${snapshot.gpu.developmentSimulation.completedLosses}/${snapshot.gpu.developmentSimulation.requestedLosses}` : ""} · {snapshot.documentCore} · {writerMode === "owner" ? "local writer" : writerMode === "read-only" ? "read-only tab" : "acquiring writer lock"} · {status}{storageNotice ? ` · ${storageNotice}` : ""}</span>
          <input ref={assetInputRef} className="asset-file-input" type="file" accept="image/png,image/jpeg,image/webp,font/woff2,font/woff,font/ttf,font/otf,.woff2,.woff,.ttf,.otf" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ""; if (file) void importAsset(file); }} />
          <button className="quiet-button" disabled={!canEdit} title={assetStatus ?? "Import image or font"} onClick={() => assetImporting ? assetUploadAbortRef.current?.abort() : openAssetPicker()}>{assetImporting ? "Cancel import" : "Import"}</button>
          {assetStatus && <span className={`asset-import-status ${assetStatus.startsWith("Import failed") ? "is-error" : ""}`} role="status" aria-live="polite">{assetStatus}</span>}
          <button className="quiet-button" title="Export active page as SVG" onClick={exportActivePageAsSvg}>Export SVG</button>
          <button className="quiet-button" disabled={!canEdit} onClick={() => command({ type: "reset" })}>Reset demo</button>
          <button className="publish-button">Share <span>↗</span></button>
        </div>
      </header>

      <aside className="tool-rail" aria-label="Canvas tools">
        {tools.map((item) => <IconButton key={item.id} label={`${item.label} (${item.key})${item.id !== "select" && item.id !== "hand" ? " · Enter creates at centre" : ""}`} active={tool === item.id} disabled={safeMode || (!canEdit && item.id !== "select" && item.id !== "hand")} onClick={() => setActiveTool(item.id)}><span>{item.glyph}</span><i>{item.key}</i></IconButton>)}
        <div className="rail-spacer" />
        <IconButton label="Zoom in" disabled={safeMode} onClick={() => { const input: EditorInputEvent = { type: "wheel", x: window.innerWidth / 2, y: window.innerHeight / 2, deltaX: 0, deltaY: -100, ctrlKey: true, occurredAt: Date.now() }; const batcher = inputBatcherRef.current; if (batcher) batcher.enqueue(input); else postInput([input]); }}>+</IconButton>
      </aside>

      <LayerPanel nodes={snapshot.nodes.filter((node) => (node.pageId ?? defaultPageId) === snapshot.activePageId)} pages={snapshot.pages} activePageId={snapshot.activePageId} selectedIds={snapshot.selectedIds} canEdit={canEdit} onSelect={selectLayer} onDrop={dropLayer} onNest={nestLayer} onRename={renameLayer} onReorder={reorderSelectedLayers} onSelectPage={selectPage} onCreatePage={createPage} onCreateFrame={createFrame} onCreateRectangle={createRectangle} onCreateText={createText} onGroup={groupSelected} onUngroup={ungroupSelected} />

      <section className="canvas-wrap" aria-label="Design canvas">
        <canvas key={`editor-canvas-${canvasGeneration}`} ref={canvasRef} className="design-canvas" onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); pointer(event, "down"); }} onPointerMove={(event) => pointer(event, "move")} onPointerLeave={(event) => pointer(event, "leave")} onPointerUp={(event) => { pointer(event, "up"); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={(event) => { pointer(event, "up"); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onDoubleClick={(event) => { drillDownAtCanvasPoint(event); void startCanvasTextEdit(event); }} />
        {canvasTextEdit && canvasTextNode && canvasTextStyle && <div ref={canvasTextEditorRef} className="canvas-text-editor" role="textbox" aria-label="Canvas text content" aria-multiline="true" data-rust-caret={canvasTextEdit.rustCaretReady ? "ready" : "pending"} autoFocus contentEditable suppressContentEditableWarning spellCheck={false} style={canvasTextStyle} onCompositionStart={() => { canvasTextIsComposingRef.current = true; pendingCanvasCaretLayoutsRef.current.clear(); setCanvasTextEdit((current) => current ? { ...current, rustCaretReady: false, rustCaretLayout: undefined } : current); }} onCompositionEnd={(event) => { canvasTextIsComposingRef.current = false; const text = event.currentTarget.innerText; const caret = contentEditableCaretOffset(event.currentTarget); setCanvasTextEdit((current) => current ? { ...current, draft: text, caret, selectionAnchor: caret, rustCaretReady: false, rustCaretLayout: undefined } : current); requestCanvasCaretLayout(canvasTextNode.id, text, caret); }} onInput={(event) => { const text = event.currentTarget.innerText; const caret = contentEditableCaretOffset(event.currentTarget); setCanvasTextEdit((current) => current ? { ...current, draft: text, caret, selectionAnchor: caret, rustCaretReady: false, rustCaretLayout: undefined } : current); if (!canvasTextIsComposingRef.current) requestCanvasCaretLayout(canvasTextNode.id, text, caret); }} onBlur={commitCanvasTextEdit} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); cancelCanvasTextEdit(); } else if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); commitCanvasTextEdit(); } else if (!canvasTextIsComposingRef.current && !event.altKey && !event.metaKey && !event.ctrlKey && (event.key === "ArrowLeft" || event.key === "ArrowRight") && canvasTextEdit.rustCaretLayout) { const selection = contentEditableSelectionOffsets(event.currentTarget); if (!selection) return; event.preventDefault(); const direction = event.key === "ArrowLeft" ? -1 : 1; const anchor = snapUtf16CaretToRustLayout(canvasTextEdit.draft, selection.anchor, canvasTextEdit.rustCaretLayout); const focus = snapUtf16CaretToRustLayout(canvasTextEdit.draft, selection.focus, canvasTextEdit.rustCaretLayout); const nextCaret = !event.shiftKey && anchor !== focus ? direction < 0 ? Math.min(anchor, focus) : Math.max(anchor, focus) : moveUtf16CaretInRustLayout(canvasTextEdit.draft, focus, direction, canvasTextEdit.rustCaretLayout); const nextAnchor = event.shiftKey ? anchor : nextCaret; placeContentEditableSelection(event.currentTarget, nextAnchor, nextCaret); setCanvasTextEdit((current) => current ? { ...current, caret: nextCaret, selectionAnchor: nextAnchor } : current); } }}>{canvasTextEditParagraphs.map((paragraph, index) => <div key={`${paragraph.start}-${paragraph.end}`} className="canvas-text-paragraph" dir={paragraph.direction} style={{ marginBottom: index < canvasTextEditParagraphs.length - 1 ? `${(canvasTextNode.textProperties?.paragraph.paragraphSpacing ?? 0) * snapshot.viewport.zoom}px` : 0, textAlign: paragraph.direction === "rtl" ? "right" : canvasTextNode.textProperties?.paragraph.alignment === "justify" ? "left" : canvasTextNode.textProperties?.paragraph.alignment ?? "left" }}>{paragraph.spans.length ? paragraph.spans.map((span) => {
          const family = span.style.font ? `"${fontFamilyForAsset(span.style.font.assetId)}", ` : "";
          return <span key={`${span.start}-${span.end}`} style={{ fontFamily: `${family}${canvasDesignTokens.typography.canvasText.family}`, fontSize: `${span.style.fontSize * snapshot.viewport.zoom}px`, fontWeight: span.style.fontWeight, fontStyle: span.style.italic ? "italic" : "normal", fontSynthesis: "none", letterSpacing: `${span.style.letterSpacing * snapshot.viewport.zoom}px` }}>{span.text}</span>;
        }) : paragraph.text || "\u200b"}</div>)}</div>}
        <div className="canvas-caption"><span>WORLD</span><b>{Math.round(snapshot.viewport.zoom * 100)}%</b><span>⌘ + scroll to zoom</span><span aria-label="Render evidence" data-render-performance={renderPerformanceEvidence} data-render-diagnostics={JSON.stringify(snapshot.diagnostics ?? { total: 0, byCategory: {}, recent: [] })} data-engine-recoveries={workerRecoveryCount}>{renderEvidence}</span><span aria-label="Main thread responsiveness" data-main-thread-long-tasks={JSON.stringify(mainThreadLongTasks)}>{mainThreadEvidence}</span><span aria-label="Frame interval evidence" data-frame-intervals={JSON.stringify(frameIntervals)}>{frameEvidence}</span><span aria-label="Input backlog evidence" data-input-backlog={JSON.stringify(inputBacklog)}>{inputBacklogEvidence}</span>{!deterministicEvidenceCapture && <span aria-label="Viewport checkpoint evidence" data-viewport-checkpoints={JSON.stringify(viewportCheckpoints)}>{viewportCheckpointEvidence}</span>}<span aria-label="Resource evidence">{resourceEvidence}</span><span aria-label="Canonical document hash" data-document-id={snapshot.documentId} data-document-revision={snapshot.revision} data-document-hash={snapshot.documentHash ?? ""}>{snapshot.documentHash ? `hash ${snapshot.documentHash.slice(0, 12)}` : "hash pending"}</span></div>
        {error && <div className="engine-error" role="alert">{error}</div>}
      </section>

      <aside className="inspector panel" aria-label="Properties">
        <div className="panel-heading"><span>Inspect</span><span className="revision">r{snapshot.revision}</span></div>
        {selected ? <Inspector node={selected} sceneNodes={snapshot.nodes} assets={snapshot.assets ?? []} fontAvailability={snapshot.fontAvailability} onUpdate={update} readOnly={!canEdit} /> : selectedNodes.length > 1 ? <MultiInspector nodes={selectedNodes} sceneNodes={snapshot.nodes} onUpdate={updateSelection} onUpdateGeometry={updateSelectionGeometry} onUpdateStrokeWeight={updateSelectionStrokeWeight} onUseUniformStrokeWeights={useSelectionUniformStrokeWeights} onUpdateCornerRadius={updateSelectionCornerRadius} onUseUniformCornerRadius={useSelectionUniformCornerRadius} onUpdateConstraint={updateSelectionConstraint} onRemoveConstraints={removeSelectionConstraints} readOnly={!canEdit} /> : <div className="empty-inspector">Select an object to reveal its geometry, fill and layer settings.</div>}
        <div className="history-actions"><button disabled={!canEdit || snapshot.selectedIds.length < 2} onClick={groupSelected}>Group ⌘G</button><button disabled={!canEdit || selected?.kind !== "group"} onClick={ungroupSelected}>Ungroup ⇧⌘G</button><button disabled={!canEdit || snapshot.selectedIds.length === 0} onClick={() => command({ type: "duplicate", ids: snapshot.selectedIds })}>Duplicate ⌘D</button><button disabled={!canEdit || !snapshot.canUndo} onClick={() => command({ type: "undo" })}>↶ Undo</button><button disabled={!canEdit || !snapshot.canRedo} onClick={() => command({ type: "redo" })}>Redo ↷</button></div>
      </aside>
    </main>
  );
}

function MultiInspector({ nodes, sceneNodes, onUpdate, onUpdateGeometry, onUpdateStrokeWeight, onUseUniformStrokeWeights, onUpdateCornerRadius, onUseUniformCornerRadius, onUpdateConstraint, onRemoveConstraints, readOnly }: { nodes: readonly CanvasNode[]; sceneNodes: readonly CanvasNode[]; onUpdate: (patch: Partial<CanvasNode>) => void; onUpdateGeometry: (patch: Partial<Pick<CanvasNode, "x" | "y" | "width" | "height">>) => void; onUpdateStrokeWeight: (index: number, value: number) => void; onUseUniformStrokeWeights: () => void; onUpdateCornerRadius: (index: number, value: number) => void; onUseUniformCornerRadius: () => void; onUpdateConstraint: (axis: "horizontal" | "vertical", value: ConstraintType) => void; onRemoveConstraints: () => void; readOnly: boolean }) {
  const rotation = mixedSelectionValue(nodes.map((node) => node.rotation));
  const opacity = mixedSelectionValue(nodes.map((node) => node.opacity));
  const visible = mixedSelectionValue(nodes.map((node) => node.visible !== false));
  const locked = mixedSelectionValue(nodes.map((node) => Boolean(node.locked)));
  const capabilities = mixedInspectorCapabilities(nodes);
  const supportsStrokeWidth = capabilities.strokeWidth;
  const strokeWidth = mixedSelectionValue(nodes.map((node) => node.strokeWidth));
  const supportsStrokeAlign = capabilities.strokeAlign;
  const strokeAlign = mixedSelectionValue(nodes.map((node) => node.strokeAlign ?? "inside"));
  const strokeWeights = capabilities.perSideStroke ? strokeWeightSelection(nodes) : undefined;
  const cornerRadii = capabilities.corners ? cornerRadiusSelection(nodes) : undefined;
  const cornerSmoothing = capabilities.corners ? cornerSmoothingSelection(nodes) : undefined;
  const constraints = nodes.every((node) => hasFrameConstraintScope(sceneNodes, node)) ? constraintSelection(nodes) : undefined;
  const lineAppearance = capabilities.lineStroke ? lineSelectionAppearance(nodes) : undefined;
  const strokeAppearance = capabilities.strokeDetails ? strokeSelectionAppearance(nodes) : undefined;
  const sectionContentsHidden = capabilities.sectionContents
    ? mixedSelectionValue(nodes.map((node) => Boolean(node.contentsHidden)))
    : undefined;
  const frameClipsContent = capabilities.frameClip
    ? mixedSelectionValue(nodes.map((node) => node.clipsContent !== false))
    : undefined;
  const selectionGeometry = resolveMultiResizeSelection(sceneNodes, nodes.map((node) => node.id));
  const supportsFill = capabilities.fill;
  const simpleFill = supportsFill && nodes.every((node) => !node.fills?.length && !node.fillGradient);
  const simpleStroke = supportsStrokeWidth && nodes.every((node) => !node.strokes?.length && !node.strokeGradient);
  const fill = mixedSelectionValue(nodes.map((node) => node.fill));
  const stroke = mixedSelectionValue(nodes.map((node) => node.stroke));
  const selectionField = (value: number): MixedSelectionValue<number> => ({ kind: "same", value: Math.round(value * 100) / 100 });
  const numericField = (label: string, value: MixedSelectionValue<number>, unit: string, apply: (value: number) => void, minimum?: number) => <label className="field"><span>{label}</span><div><input aria-label={`Selection ${label.toLowerCase()}`} disabled={readOnly} inputMode="decimal" value={value.kind === "same" ? value.value : ""} placeholder={value.kind === "mixed" ? "Mixed" : undefined} onChange={(event) => {
    const raw = event.target.value.trim();
    const next = Number(raw);
    if (raw && Number.isFinite(next) && (minimum === undefined || next >= minimum)) apply(next);
  }} /><em>{unit}</em></div></label>;
  return <div className="inspector-content multi-inspector">
    <div className="selection-title" role="status" aria-live="polite"><span className="node-icon">◫</span><strong>{nodes.length} layers selected</strong></div>
    {selectionGeometry && <section><h2>Geometry</h2><div className="field-grid">{numericField("X", selectionField(selectionGeometry.bounds.x), "px", (value) => onUpdateGeometry({ x: value }))}{numericField("Y", selectionField(selectionGeometry.bounds.y), "px", (value) => onUpdateGeometry({ y: value }))}{numericField("W", selectionField(selectionGeometry.bounds.width), "px", (value) => onUpdateGeometry({ width: value }), .001)}{numericField("H", selectionField(selectionGeometry.bounds.height), "px", (value) => onUpdateGeometry({ height: value }), .001)}</div></section>}
    <section><h2>Selection</h2><div className="field-grid">{numericField("Rotation", rotation, "°", (value) => onUpdate({ rotation: value }))}<label className="field"><span>Opacity</span><div><input aria-label="Selection opacity" disabled={readOnly} inputMode="decimal" value={opacity.kind === "same" ? Math.round(opacity.value * 100) : ""} placeholder={opacity.kind === "mixed" ? "Mixed" : undefined} onChange={(event) => {
      const raw = event.target.value.trim();
      const value = Number(raw);
      if (raw && Number.isFinite(value) && value >= 0 && value <= 100) onUpdate({ opacity: value / 100 });
    }} /><em>%</em></div></label>{supportsStrokeWidth && numericField("Stroke width", strokeWidth, "px", (value) => onUpdate({ strokeWidth: value }), 0)}{supportsStrokeAlign && <label className="field"><span>Stroke align</span><div><select aria-label="Selection stroke align" disabled={readOnly} value={strokeAlign.kind === "same" ? strokeAlign.value : ""} onChange={(event) => { const value = event.target.value; if (value === "inside" || value === "center" || value === "outside") onUpdate({ strokeAlign: value }); }}><option value="" disabled>Mixed</option><option value="inside">Inside</option><option value="center">Center</option><option value="outside">Outside</option></select></div></label>}</div></section>
    {strokeWeights && <section><h2>Stroke weights</h2><div className="field-grid">{numericField("Top weight", strokeWeights.top, "px", (value) => onUpdateStrokeWeight(0, value), 0)}{numericField("Right weight", strokeWeights.right, "px", (value) => onUpdateStrokeWeight(1, value), 0)}{numericField("Bottom weight", strokeWeights.bottom, "px", (value) => onUpdateStrokeWeight(2, value), 0)}{numericField("Left weight", strokeWeights.left, "px", (value) => onUpdateStrokeWeight(3, value), 0)}</div><button type="button" disabled={readOnly || !strokeWeights.hasExplicitWeights} onClick={onUseUniformStrokeWeights}>Use uniform width</button></section>}
    {cornerRadii && <section><h2>Corner radii</h2><div className="field-grid">{numericField("Top left radius", cornerRadii.topLeft, "px", (value) => onUpdateCornerRadius(0, value), 0)}{numericField("Top right radius", cornerRadii.topRight, "px", (value) => onUpdateCornerRadius(1, value), 0)}{numericField("Bottom right radius", cornerRadii.bottomRight, "px", (value) => onUpdateCornerRadius(2, value), 0)}{numericField("Bottom left radius", cornerRadii.bottomLeft, "px", (value) => onUpdateCornerRadius(3, value), 0)}</div><button type="button" disabled={readOnly || !cornerRadii.hasExplicitRadii} onClick={onUseUniformCornerRadius}>Use uniform radius</button></section>}
    {cornerSmoothing && <section><h2>Corner smoothing</h2><label className="field"><span>Amount</span><div><input aria-label="Selection corner smoothing" disabled={readOnly} inputMode="decimal" value={cornerSmoothing.kind === "same" ? Math.round(cornerSmoothing.value * 100) : ""} placeholder={cornerSmoothing.kind === "mixed" ? "Mixed" : undefined} onChange={(event) => { const raw = event.target.value.trim(); const value = Number(raw); if (raw && Number.isFinite(value) && value >= 0 && value <= 100) onUpdate({ cornerSmoothing: value / 100 }); }} /><em>%</em></div></label><button type="button" disabled={readOnly || (cornerSmoothing.kind === "same" && cornerSmoothing.value === 0)} onClick={() => onUpdate({ cornerSmoothing: undefined })}>Use circular corners</button></section>}
    {constraints && <section><h2>Constraints</h2><div className="field-grid"><SelectionConstraintField label="Selection horizontal constraint" value={constraints.horizontal} readOnly={readOnly} onChange={(value) => onUpdateConstraint("horizontal", value)} /><SelectionConstraintField label="Selection vertical constraint" value={constraints.vertical} readOnly={readOnly} onChange={(value) => onUpdateConstraint("vertical", value)} /></div><button type="button" disabled={readOnly || !constraints.hasExplicitConstraints} onClick={onRemoveConstraints}>Remove constraints</button></section>}
    {strokeAppearance && <section><h2>{lineAppearance ? "Line stroke" : "Stroke details"}</h2><div className="field-grid">{lineAppearance && <><LineSelectionCap label="Selection start cap" value={lineAppearance.strokeCapStart} readOnly={readOnly} onChange={(value) => onUpdate({ strokeCapStart: value })} /><LineSelectionCap label="Selection end cap" value={lineAppearance.strokeCapEnd} readOnly={readOnly} onChange={(value) => onUpdate({ strokeCapEnd: value })} /></>}<label className="field"><span>Join</span><div><select aria-label="Selection stroke join" disabled={readOnly} value={strokeAppearance.strokeJoin.kind === "same" ? strokeAppearance.strokeJoin.value : ""} onChange={(event) => { const value = event.target.value; if (value === "miter" || value === "bevel" || value === "round") onUpdate({ strokeJoin: value }); }}><option value="" disabled>Mixed</option><option value="miter">Miter</option><option value="bevel">Bevel</option><option value="round">Round</option></select></div></label>{numericField("Miter limit", strokeAppearance.strokeMiterLimit, "", (value) => onUpdate({ strokeMiterLimit: value }), 1)}<LineSelectionDash value={strokeAppearance.strokeDashPattern} readOnly={readOnly} onChange={(value) => onUpdate({ strokeDashPattern: value })} /></div></section>}
    <section><h2>Paint</h2><div className="field-grid">{simpleFill ? <label className="field"><span>Fill</span><div><input aria-label="Selection fill" disabled={readOnly} value={fill.kind === "same" ? fill.value : ""} placeholder={fill.kind === "mixed" ? "Mixed" : undefined} onChange={(event) => { const color = documentColorFromCssHex(event.target.value); if (color) onUpdate({ fill: event.target.value, fills: undefined, fillGradient: undefined }); }} /></div></label> : <p className="mixed-not-applicable">Fill layers: select one compatible layer to edit gradients or Paint Stack.</p>}{simpleStroke ? <label className="field"><span>Stroke</span><div><input aria-label="Selection stroke" disabled={readOnly} value={stroke.kind === "same" ? stroke.value : ""} placeholder={stroke.kind === "mixed" ? "Mixed" : undefined} onChange={(event) => { const color = documentColorFromCssHex(event.target.value); if (color) onUpdate({ stroke: event.target.value, strokes: undefined, strokeGradient: undefined }); }} /></div></label> : <p className="mixed-not-applicable">Stroke layers: select one compatible layer to edit gradients or Paint Stack.</p>}</div></section>
    <section><h2>Layer</h2>{frameClipsContent && <MixedToggle label="Clip content" value={frameClipsContent} readOnly={readOnly} onChange={(value) => onUpdate({ clipsContent: value })} />}{sectionContentsHidden && <MixedToggle label="Hide contents" value={sectionContentsHidden} readOnly={readOnly} onChange={(value) => onUpdate({ contentsHidden: value })} />}<MixedToggle label="Visible" value={visible} readOnly={readOnly} onChange={(value) => onUpdate({ visible: value })} /><MixedToggle label="Lock editing" value={locked} readOnly={readOnly} onChange={(value) => onUpdate({ locked: value })} /></section>
  </div>;
}

function LineSelectionCap({ label, value, readOnly, onChange }: { label: string; value: MixedSelectionValue<NonNullable<CanvasNode["strokeCapStart"]>>; readOnly: boolean; onChange: (value: NonNullable<CanvasNode["strokeCapStart"]>) => void }) {
  return <label className="field"><span>{label.replace("Selection ", "")}</span><div><select aria-label={label} disabled={readOnly} value={value.kind === "same" ? value.value : ""} onChange={(event) => {
    const next = event.target.value;
    if (["none", "round", "square", "arrowLines", "arrowEquilateral", "triangleFilled", "diamondFilled", "circleFilled"].includes(next)) onChange(next as NonNullable<CanvasNode["strokeCapStart"]>);
  }}><option value="" disabled>Mixed</option><option value="none">None</option><option value="round">Round</option><option value="square">Square</option><option value="arrowLines">Arrow lines</option><option value="arrowEquilateral">Arrow</option><option value="triangleFilled">Triangle</option><option value="diamondFilled">Diamond</option><option value="circleFilled">Circle</option></select></div></label>;
}

function LineSelectionDash({ value, readOnly, onChange }: { value: MixedSelectionValue<string>; readOnly: boolean; onChange: (value: number[]) => void }) {
  const canonical = value.kind === "same" ? value.value : "";
  const [draft, setDraft] = useState(canonical);
  useEffect(() => setDraft(canonical), [canonical]);
  const commit = () => {
    const pattern = parseLineDashPattern(draft);
    if (pattern) onChange(pattern);
    else setDraft(canonical);
  };
  return <label className="field"><span>Dash</span><div><input aria-label="Selection stroke dash pattern" disabled={readOnly} placeholder={value.kind === "mixed" ? "Mixed" : "8, 4"} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></div></label>;
}

function SelectionConstraintField({ label, value, readOnly, onChange }: { label: string; value: MixedSelectionValue<ConstraintSelectionValue>; readOnly: boolean; onChange: (value: ConstraintType) => void }) {
  return <label className="field"><span>{label.replace("Selection ", "")}</span><div><select aria-label={label} disabled={readOnly} value={value.kind === "same" ? value.value : ""} onChange={(event) => {
    const next = event.target.value;
    if (next === "min" || next === "center" || next === "max" || next === "stretch" || next === "scale") onChange(next);
  }}><option value="" disabled>Mixed</option><option value="none" disabled>No constraints</option><option value="min">Left / Top</option><option value="center">Center</option><option value="max">Right / Bottom</option><option value="stretch">Left &amp; right / Top &amp; bottom</option><option value="scale">Scale</option></select></div></label>;
}

function MixedToggle({ label, value, readOnly, onChange }: { label: string; value: MixedSelectionValue<boolean>; readOnly: boolean; onChange: (value: boolean) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = value.kind === "mixed";
  }, [value]);
  return <label className="toggle"><input ref={inputRef} aria-label={value.kind === "mixed" ? `${label} mixed` : label} disabled={readOnly} type="checkbox" checked={value.kind === "same" && value.value} onChange={(event) => onChange(event.target.checked)} />{label}{value.kind === "mixed" && <em>Mixed</em>}</label>;
}

function Inspector({ node, sceneNodes, assets, fontAvailability, onUpdate, readOnly }: { node: CanvasNode; sceneNodes: readonly CanvasNode[]; assets: DocumentAsset[]; fontAvailability?: EditorSnapshot["fontAvailability"]; onUpdate: (patch: Partial<CanvasNode>) => void; readOnly: boolean }) {
  const field = (label: string, key: keyof CanvasNode, value: string | number, unit = "") => <label className="field"><span>{label}</span><div><input aria-label={label} readOnly={readOnly} inputMode={typeof value === "number" ? "decimal" : undefined} value={value} onChange={(event) => {
    if (typeof value !== "number") {
      const resetStack = key === "fill" ? { fills: undefined } : key === "stroke" ? { strokes: undefined } : {};
      onUpdate({ [key]: event.target.value, ...resetStack });
      return;
    }
    const raw = event.target.value.trim();
    const parsed = Number(raw);
    if (!raw || !Number.isFinite(parsed)) return;
    onUpdate({ [key]: parsed / (key === "opacity" ? 100 : 1) });
  }} /><em>{unit}</em></div></label>;
  const gradientCss = node.fillGradient ? `linear-gradient(${node.fillGradient.stops.map((stop) => `${colorCss(stop.color)} ${Math.round(stop.position * 100)}%`).join(", ")})` : undefined;
  const imageAsset = node.assetId ? assets.find((asset) => asset.assetId === node.assetId) : undefined;
  const updateGradient = (gradient: DocumentLinearGradient) => onUpdate({ fillGradient: gradient });
  const createGradient = () => {
    const fillColor = node.fillColor ?? documentColorFromCssHex(node.fill);
    if (fillColor) updateGradient(createDefaultLinearGradient(fillColor));
  };
  const updateGradientColor = (index: number, value: string) => {
    const color = documentColorFromCssHex(value);
    if (!node.fillGradient || !color) return;
    updateGradient({ ...node.fillGradient, stops: node.fillGradient.stops.map((stop, stopIndex) => stopIndex === index ? { ...stop, color: { ...color, alpha: stop.color.alpha } } : stop) });
  };
  const updateGradientPosition = (index: number, value: number) => {
    if (!node.fillGradient) return;
    const lower = index === 0 ? 0 : node.fillGradient.stops[index - 1].position;
    const upper = index === node.fillGradient.stops.length - 1 ? 1 : node.fillGradient.stops[index + 1].position;
    const position = Math.max(lower, Math.min(upper, value));
    updateGradient({ ...node.fillGradient, stops: node.fillGradient.stops.map((stop, stopIndex) => stopIndex === index ? { ...stop, position } : stop) });
  };
  const addGradientStop = () => {
    if (!node.fillGradient || node.fillGradient.stops.length >= 16) return;
    let insertion = 0;
    let largestGap = -1;
    for (let index = 0; index < node.fillGradient.stops.length - 1; index += 1) {
      const gap = node.fillGradient.stops[index + 1].position - node.fillGradient.stops[index].position;
      if (gap > largestGap) { largestGap = gap; insertion = index; }
    }
    if (largestGap <= 0) return;
    const left = node.fillGradient.stops[insertion];
    const nextStop = { position: left.position + largestGap / 2, color: structuredClone(left.color) };
    updateGradient({ ...node.fillGradient, stops: [...node.fillGradient.stops.slice(0, insertion + 1), nextStop, ...node.fillGradient.stops.slice(insertion + 1)] });
  };
  const removeGradientStop = (index: number) => {
    if (!node.fillGradient || node.fillGradient.stops.length <= 2) return;
    updateGradient({ ...node.fillGradient, stops: node.fillGradient.stops.filter((_, stopIndex) => stopIndex !== index) });
  };
  const setGradientDirection = (start: [number, number], end: [number, number]) => node.fillGradient && updateGradient({ ...node.fillGradient, start, end });
  return <div className="inspector-content">
    <div className="selection-title" role="status" aria-live="polite"><span className={`node-icon ${node.kind}`}>{node.kind === "ellipse" ? "○" : node.kind === "line" ? "／" : node.kind === "text" ? "T" : node.kind === "frame" ? "#" : node.kind === "group" ? "◇" : node.kind === "section" ? "§" : node.kind === "image" ? "▧" : "□"}</span><input readOnly={readOnly} value={node.name} aria-label="Layer name" onChange={(event) => onUpdate({ name: event.target.value })} /></div>
    <section><h2>Geometry</h2><div className="field-grid">{field("X", "x", node.x)}{field("Y", "y", node.y)}{field("W", "width", Math.round(node.width))}{node.kind !== "line" && field("H", "height", Math.round(node.height))}{field("Rotation", "rotation", Math.round(node.rotation), "°")}</div></section>
        {node.kind === "line" ? <section><h2>Appearance</h2>{field("Stroke", "stroke", node.stroke)}{field("Stroke width", "strokeWidth", node.strokeWidth, "px")}<label className="field"><span>Start cap</span><div><select aria-label="Start cap" disabled={readOnly} value={node.strokeCapStart ?? "none"} onChange={(event) => onUpdate({ strokeCapStart: event.target.value as NonNullable<CanvasNode["strokeCapStart"]> })}><option value="none">None</option><option value="round">Round</option><option value="square">Square</option><option value="arrowLines">Arrow lines</option><option value="arrowEquilateral">Arrow</option><option value="triangleFilled">Triangle</option><option value="diamondFilled">Diamond</option><option value="circleFilled">Circle</option></select></div></label><label className="field"><span>End cap</span><div><select aria-label="End cap" disabled={readOnly} value={node.strokeCapEnd ?? "none"} onChange={(event) => onUpdate({ strokeCapEnd: event.target.value as NonNullable<CanvasNode["strokeCapEnd"]> })}><option value="none">None</option><option value="round">Round</option><option value="square">Square</option><option value="arrowLines">Arrow lines</option><option value="arrowEquilateral">Arrow</option><option value="triangleFilled">Triangle</option><option value="diamondFilled">Diamond</option><option value="circleFilled">Circle</option></select></div></label>{field("Opacity", "opacity", Math.round(node.opacity * 100), "%")}</section> : supportsGenericAppearanceInspector(node.kind) && <section><h2>Appearance</h2>{node.assetId && <div className="image-fill-summary"><div className="image-fill-preview" /><div><strong>Image fill</strong><span>{imageAsset?.pixelWidth && imageAsset?.pixelHeight ? `${imageAsset.pixelWidth} × ${imageAsset.pixelHeight}` : node.assetId.slice(0, 8)}</span></div><button type="button" aria-label="Remove image fill" disabled={readOnly} onClick={() => onUpdate({ assetId: undefined })}>Remove</button></div>}{node.fillGradient ? <div className="gradient-summary"><div className="gradient-preview" style={{ background: gradientCss }} /><div><strong>Linear gradient</strong><span>{node.fillGradient.stops.length} color stops</span></div><div className="gradient-directions" aria-label="Gradient direction"><button type="button" aria-pressed={sameDirection(node.fillGradient, [0, 0], [1, 0])} disabled={readOnly} onClick={() => setGradientDirection([0, 0], [1, 0])}>Horizontal</button><button type="button" aria-pressed={sameDirection(node.fillGradient, [0, 0], [0, 1])} disabled={readOnly} onClick={() => setGradientDirection([0, 0], [0, 1])}>Vertical</button><button type="button" aria-pressed={sameDirection(node.fillGradient, [0, 0], [1, 1])} disabled={readOnly} onClick={() => setGradientDirection([0, 0], [1, 1])}>Diagonal</button></div><div className="gradient-stops">{node.fillGradient.stops.map((stop, index) => <label key={`${stop.position}-${index}`} className="gradient-stop"><span>Stop {index + 1}</span><input aria-label={`Gradient stop ${index + 1} color`} disabled={readOnly} type="color" value={opaqueColorCss(stop.color)} onChange={(event) => updateGradientColor(index, event.target.value)} /><input aria-label={`Gradient stop ${index + 1} position`} disabled={readOnly} type="range" min={index === 0 ? 0 : node.fillGradient!.stops[index - 1].position} max={index === node.fillGradient!.stops.length - 1 ? 1 : node.fillGradient!.stops[index + 1].position} step="0.01" value={stop.position} onChange={(event) => updateGradientPosition(index, Number(event.target.value))} /><em>{Math.round(stop.position * 100)}%</em><button type="button" aria-label={`Remove gradient stop ${index + 1}`} disabled={readOnly || node.fillGradient!.stops.length <= 2} onClick={() => removeGradientStop(index)}>−</button></label>)}</div><button type="button" aria-label="Add gradient stop" disabled={readOnly || node.fillGradient.stops.length >= 16} onClick={addGradientStop}>Add stop</button><button type="button" disabled={readOnly} onClick={() => onUpdate({ fill: node.fill })}>Replace with solid</button></div> : <>{field("Fill", "fill", node.fill)}<div className="color-preview" style={{ background: node.fill }} /><button className="add-gradient-button" type="button" disabled={readOnly} onClick={createGradient}>Add linear gradient</button></>}{node.kind !== "text" && <>{field("Stroke", "stroke", node.stroke)}{field("Stroke width", "strokeWidth", node.strokeWidth, "px")}</>}{supportsCornerRadiusInspector(node.kind) && field("Radius", "radius", node.radius ?? 0, "px")}{field("Opacity", "opacity", Math.round(node.opacity * 100), "%")}</section>}
    {supportsStrokeDetailsInspector(node.kind) && <StrokeDetailsInspector node={node} onUpdate={onUpdate} readOnly={readOnly} />}
    {supportsPaintStackInspector(node.kind) && <PaintStackInspector node={node} onUpdate={onUpdate} readOnly={readOnly} />}
    {hasFrameConstraintScope(sceneNodes, node) && <FrameConstraintsInspector node={node} onUpdate={onUpdate} readOnly={readOnly} />}
    {supportsPerSideStrokeInspector(node.kind) && <PerSideStrokeInspector node={node} onUpdate={onUpdate} readOnly={readOnly} />}
    {supportsStrokeAlignInspector(node) && <StrokeAlignInspector node={node} onUpdate={onUpdate} readOnly={readOnly} />}
    {(node.kind === "frame" || node.kind === "rectangle" || node.kind === "section") && <CornerRadiiInspector node={node} onUpdate={onUpdate} readOnly={readOnly} />}
    {(node.kind === "frame" || node.kind === "rectangle" || node.kind === "section") && <CornerSmoothingInspector node={node} onUpdate={onUpdate} readOnly={readOnly} />}
    {node.kind === "ellipse" && <EllipseArcInspector node={node} onUpdate={onUpdate} readOnly={readOnly} />}
    {node.kind === "text" && <TextInspector node={node} assets={assets} fontAvailability={fontAvailability} onUpdate={onUpdate} readOnly={readOnly} />}
    <section><h2>Layer</h2>{node.kind === "frame" && <label className="toggle"><input disabled={readOnly} type="checkbox" checked={node.clipsContent !== false} onChange={(event) => onUpdate({ clipsContent: event.target.checked })} />Clip content</label>}{node.kind === "section" && <label className="toggle"><input disabled={readOnly} type="checkbox" checked={Boolean(node.contentsHidden)} onChange={(event) => onUpdate({ contentsHidden: event.target.checked })} />Hide contents</label>}<label className="toggle"><input disabled={readOnly} type="checkbox" checked={node.visible !== false} onChange={(event) => onUpdate({ visible: event.target.checked })} />Visible</label><label className="toggle"><input disabled={readOnly} type="checkbox" checked={Boolean(node.locked)} onChange={(event) => onUpdate({ locked: event.target.checked })} />Lock editing</label></section>
  </div>;
}

function StrokeDetailsInspector({ node, onUpdate, readOnly }: { node: CanvasNode; onUpdate: (patch: Partial<CanvasNode>) => void; readOnly: boolean }) {
  const [dash, setDash] = useState((node.strokeDashPattern ?? []).join(", "));
  useEffect(() => setDash((node.strokeDashPattern ?? []).join(", ")), [node.id, node.strokeDashPattern]);
  const commitDash = () => {
    const pattern = parseLineDashPattern(dash);
    if (!pattern) {
      setDash((node.strokeDashPattern ?? []).join(", "));
      return;
    }
    onUpdate({ strokeDashPattern: pattern });
  };
  return <section><h2>Stroke details</h2>
    <label className="field"><span>Join</span><div><select aria-label="Stroke join" disabled={readOnly} value={node.strokeJoin ?? "miter"} onChange={(event) => onUpdate({ strokeJoin: event.target.value as NonNullable<CanvasNode["strokeJoin"]> })}><option value="miter">Miter</option><option value="bevel">Bevel</option><option value="round">Round</option></select></div></label>
    <label className="field"><span>Miter limit</span><div><input aria-label="Miter limit" disabled={readOnly} inputMode="decimal" value={node.strokeMiterLimit ?? 10} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value) && value >= 1) onUpdate({ strokeMiterLimit: value }); }} /></div></label>
    <label className="field"><span>Dash</span><div><input aria-label="Stroke dash pattern" disabled={readOnly} placeholder="8, 4" value={dash} onChange={(event) => setDash(event.target.value)} onBlur={commitDash} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></div></label>
  </section>;
}

function FrameConstraintsInspector({ node, onUpdate, readOnly }: { node: CanvasNode; onUpdate: (patch: Partial<CanvasNode>) => void; readOnly: boolean }) {
  const constraints = node.constraints ?? { horizontal: "min" as const, vertical: "min" as const };
  const update = (axis: "horizontal" | "vertical", value: typeof constraints.horizontal) => onUpdate({ constraints: { ...constraints, [axis]: value } });
  return <section><h2>Constraints</h2><div className="field-grid"><label className="field"><span>Horizontal</span><div><select aria-label="Horizontal constraint" disabled={readOnly} value={constraints.horizontal} onChange={(event) => update("horizontal", event.target.value as typeof constraints.horizontal)}><option value="min">Left</option><option value="center">Center</option><option value="max">Right</option><option value="stretch">Left &amp; right</option><option value="scale">Scale</option></select></div></label><label className="field"><span>Vertical</span><div><select aria-label="Vertical constraint" disabled={readOnly} value={constraints.vertical} onChange={(event) => update("vertical", event.target.value as typeof constraints.vertical)}><option value="min">Top</option><option value="center">Center</option><option value="max">Bottom</option><option value="stretch">Top &amp; bottom</option><option value="scale">Scale</option></select></div></label></div>{node.constraints && <button type="button" disabled={readOnly} onClick={() => onUpdate({ constraints: undefined })}>Remove constraints</button>}</section>;
}

function PaintStackInspector({ node, onUpdate, readOnly }: { node: CanvasNode; onUpdate: (patch: Partial<CanvasNode>) => void; readOnly: boolean }) {
  const paintStack = (key: "fills" | "strokes") => node[key] ?? [];
  const updateStack = (key: "fills" | "strokes", paints: DocumentPaint[] | undefined) => onUpdate({ [key]: paints } as Partial<CanvasNode>);
  const renderStack = (kind: "fill" | "stroke") => {
    const key = kind === "fill" ? "fills" : "strokes";
    const legacy = kind === "fill" ? node.fill : node.stroke;
    const paints = paintStack(key);
    const title = kind === "fill" ? "Fill layers" : "Stroke layers";
    const singular = kind === "fill" ? "fill" : "stroke";
    const updatePaint = (index: number, next: DocumentPaint) => updateStack(key, paints.map((paint, paintIndex) => paintIndex === index ? next : paint));
    const paintColor = (paint: DocumentPaint): DocumentColor => paint.color ?? documentColorFromCssHex(paint.css) ?? { space: "srgb", components: [0, 0, 0], alpha: 1 };
    const updateSolid = (index: number, paint: DocumentPaint, css: string) => {
      const color = documentColorFromCssHex(css);
      if (!color) return;
      updatePaint(index, { ...paint, css, color, gradient: undefined });
    };
    const updateGradient = (index: number, paint: DocumentPaint, gradient: DocumentLinearGradient) => updatePaint(index, {
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
      for (let stopIndex = 0; stopIndex < gradient.stops.length - 1; stopIndex += 1) {
        const gap = gradient.stops[stopIndex + 1].position - gradient.stops[stopIndex].position;
        if (gap > largestGap) { largestGap = gap; insertion = stopIndex; }
      }
      if (largestGap <= 0) return;
      const left = gradient.stops[insertion];
      const nextStop = { position: left.position + largestGap / 2, color: structuredClone(left.color) };
      updateGradient(index, paint, { ...gradient, stops: [...gradient.stops.slice(0, insertion + 1), nextStop, ...gradient.stops.slice(insertion + 1)] });
    };
    return <div className="paint-stack" key={key}>
      <div className="paint-stack-heading"><strong>{title}</strong><span>{paints.length ? `${paints.length} layers` : "Single value"}</span></div>
      {paints.length > 0 && <div className="paint-stack-layers">{paints.map((paint, index) => {
        const gradient = paint.gradient;
        const layerLabel = `${title} ${index + 1}`;
        return <div className="paint-stack-layer" key={`${index}-${paint.css}`}>
          <div className="paint-layer-heading"><span>{index + 1}</span><select aria-label={`${layerLabel} type`} disabled={readOnly} value={gradient ? "gradient" : "solid"} onChange={(event) => {
            if (event.target.value === "gradient") {
              const color = paintColor(paint);
              updateGradient(index, paint, createDefaultLinearGradient(color));
            } else if (gradient) {
              const color = gradient.stops[0].color;
              updatePaint(index, { ...paint, css: colorCss(color), color, gradient: undefined });
            }
          }}><option value="solid">Solid</option><option value="gradient">Linear gradient</option></select><button type="button" aria-label={`Remove ${singular} layer ${index + 1}`} disabled={readOnly || paints.length <= 1} onClick={() => updateStack(key, paints.filter((_, paintIndex) => paintIndex !== index))}>−</button></div>
          {gradient ? <div className="paint-layer-gradient"><div className="paint-layer-gradient-preview" style={{ background: gradientCss(gradient) }} /><div className="gradient-directions" aria-label={`${layerLabel} direction`}><button type="button" aria-pressed={sameDirection(gradient, [0, 0], [1, 0])} disabled={readOnly} onClick={() => updateGradient(index, paint, { ...gradient, start: [0, 0], end: [1, 0] })}>Horizontal</button><button type="button" aria-pressed={sameDirection(gradient, [0, 0], [0, 1])} disabled={readOnly} onClick={() => updateGradient(index, paint, { ...gradient, start: [0, 0], end: [0, 1] })}>Vertical</button><button type="button" aria-pressed={sameDirection(gradient, [0, 0], [1, 1])} disabled={readOnly} onClick={() => updateGradient(index, paint, { ...gradient, start: [0, 0], end: [1, 1] })}>Diagonal</button></div><div className="gradient-stops">{gradient.stops.map((stop, stopIndex) => <label key={`${stop.position}-${stopIndex}`} className="gradient-stop"><span>Stop {stopIndex + 1}</span><input aria-label={`${layerLabel} gradient stop ${stopIndex + 1} color`} disabled={readOnly} type="color" value={opaqueColorCss(stop.color)} onChange={(event) => { const color = documentColorFromCssHex(event.target.value); if (color) updateGradient(index, paint, { ...gradient, stops: gradient.stops.map((current, currentIndex) => currentIndex === stopIndex ? { ...current, color: { ...color, alpha: current.color.alpha } } : current) }); }} /><input aria-label={`${layerLabel} gradient stop ${stopIndex + 1} position`} disabled={readOnly} type="range" min={stopIndex === 0 ? 0 : gradient.stops[stopIndex - 1].position} max={stopIndex === gradient.stops.length - 1 ? 1 : gradient.stops[stopIndex + 1].position} step="0.01" value={stop.position} onChange={(event) => { const lower = stopIndex === 0 ? 0 : gradient.stops[stopIndex - 1].position; const upper = stopIndex === gradient.stops.length - 1 ? 1 : gradient.stops[stopIndex + 1].position; const position = Math.max(lower, Math.min(upper, Number(event.target.value))); updateGradient(index, paint, { ...gradient, stops: gradient.stops.map((current, currentIndex) => currentIndex === stopIndex ? { ...current, position } : current) }); }} /><em>{Math.round(stop.position * 100)}%</em><button type="button" aria-label={`Remove ${layerLabel} gradient stop ${stopIndex + 1}`} disabled={readOnly || gradient.stops.length <= 2} onClick={() => updateGradient(index, paint, { ...gradient, stops: gradient.stops.filter((_, currentIndex) => currentIndex !== stopIndex) })}>−</button></label>)}</div><button type="button" className="paint-layer-add-stop" aria-label={`Add ${layerLabel} gradient stop`} disabled={readOnly || gradient.stops.length >= 16} onClick={() => addGradientStop(index, paint)}>Add stop</button></div> : <label className="paint-layer-solid"><span>Color</span><input aria-label={layerLabel} disabled={readOnly} value={paint.css} onChange={(event) => updateSolid(index, paint, event.target.value)} /><input aria-label={`${layerLabel} color`} disabled={readOnly} type="color" value={opaqueColorCss(paintColor(paint))} onChange={(event) => updateSolid(index, paint, event.target.value)} /></label>}
        </div>;
      })}</div>}
      <div className="paint-stack-actions">{paints.length === 0 ? <button type="button" disabled={readOnly} onClick={() => updateStack(key, [{ css: legacy, color: documentColorFromCssHex(legacy) }])}>Create {singular} stack</button> : <><button type="button" disabled={readOnly || paints.length >= 16} onClick={() => updateStack(key, [...paints, structuredClone(paints[paints.length - 1])])}>Add layer</button><button type="button" disabled={readOnly} onClick={() => updateStack(key, undefined)}>Use single {singular}</button></>}</div>
    </div>;
  };
  return <section className="paint-stacks"><h2>Paint layers</h2>{node.kind !== "line" && renderStack("fill")}{renderStack("stroke")}</section>;
}

function PerSideStrokeInspector({ node, onUpdate, readOnly }: { node: CanvasNode; onUpdate: (patch: Partial<CanvasNode>) => void; readOnly: boolean }) {
  const weights = node.strokeWeights ?? [node.strokeWidth, node.strokeWidth, node.strokeWidth, node.strokeWidth] as [number, number, number, number];
  const updateWeight = (index: number, value: string) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    const next = [...weights] as [number, number, number, number];
    next[index] = parsed;
    onUpdate({ strokeWeights: next });
  };
  return <section><h2>Stroke weights</h2>
    <div className="field-grid">{(["Top", "Right", "Bottom", "Left"] as const).map((label, index) => <label className="field" key={label}><span>{label}</span><div><input aria-label={`${label} stroke weight`} disabled={readOnly} inputMode="decimal" value={weights[index]} onChange={(event) => updateWeight(index, event.target.value)} /><em>px</em></div></label>)}</div>
    <button type="button" disabled={readOnly || !node.strokeWeights} onClick={() => onUpdate({ strokeWeights: undefined })}>Use uniform width</button>
  </section>;
}

function StrokeAlignInspector({ node, onUpdate, readOnly }: { node: CanvasNode; onUpdate: (patch: Partial<CanvasNode>) => void; readOnly: boolean }) {
  return <section><h2>Stroke align</h2><label className="field"><span>Align</span><div><select aria-label="Stroke align" disabled={readOnly} value={node.strokeAlign ?? "inside"} onChange={(event) => onUpdate({ strokeAlign: event.target.value as NonNullable<CanvasNode["strokeAlign"]> })}><option value="inside">Inside</option><option value="center">Center</option><option value="outside">Outside</option></select></div></label></section>;
}

function CornerRadiiInspector({ node, onUpdate, readOnly }: { node: CanvasNode; onUpdate: (patch: Partial<CanvasNode>) => void; readOnly: boolean }) {
  const radii = node.cornerRadii ?? [node.radius, node.radius, node.radius, node.radius] as [number, number, number, number];
  const updateRadius = (index: number, raw: string) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return;
    const next = [...radii] as [number, number, number, number];
    next[index] = value;
    onUpdate({ cornerRadii: next });
  };
  return <section><h2>Independent corners</h2>
    <div className="field-grid">{(["Top left", "Top right", "Bottom right", "Bottom left"] as const).map((label, index) => <label className="field" key={label}><span>{label}</span><div><input aria-label={`${label} corner radius`} disabled={readOnly} inputMode="decimal" value={radii[index]} onChange={(event) => updateRadius(index, event.target.value)} /><em>px</em></div></label>)}</div>
    <button type="button" disabled={readOnly || !node.cornerRadii} onClick={() => onUpdate({ cornerRadii: undefined })}>Use uniform radius</button>
  </section>;
}

function CornerSmoothingInspector({ node, onUpdate, readOnly }: { node: CanvasNode; onUpdate: (patch: Partial<CanvasNode>) => void; readOnly: boolean }) {
  const smoothing = node.cornerSmoothing ?? 0;
  return <section><h2>Corner smoothing</h2><label className="field"><span>Amount</span><div><input aria-label="Corner smoothing" disabled={readOnly} type="range" min="0" max="1" step="0.01" value={smoothing} onChange={(event) => onUpdate({ cornerSmoothing: Number(event.target.value) })} /><em>{Math.round(smoothing * 100)}%</em></div></label><button type="button" disabled={readOnly || smoothing === 0} onClick={() => onUpdate({ cornerSmoothing: undefined })}>Use circular corners</button></section>;
}

function EllipseArcInspector({ node, onUpdate, readOnly }: { node: CanvasNode; onUpdate: (patch: Partial<CanvasNode>) => void; readOnly: boolean }) {
  const arc = node.arcData ?? { startingAngle: 0, endingAngle: 360, innerRadius: 0 };
  const update = (key: keyof typeof arc, raw: string) => { const value = Number(raw); if (!Number.isFinite(value) || (key === "innerRadius" && (value < 0 || value >= 1))) return; onUpdate(ellipseArcUpdatePatch(node, { [key]: value })); };
  return <section><h2>Arc</h2><div className="field-grid"><label className="field"><span>Start</span><div><input aria-label="Arc start angle" disabled={readOnly} inputMode="decimal" value={arc.startingAngle} onChange={(event) => update("startingAngle", event.target.value)} /><em>°</em></div></label><label className="field"><span>End</span><div><input aria-label="Arc end angle" disabled={readOnly} inputMode="decimal" value={arc.endingAngle} onChange={(event) => update("endingAngle", event.target.value)} /><em>°</em></div></label><label className="field"><span>Inner</span><div><input aria-label="Arc inner radius" disabled={readOnly} inputMode="decimal" value={arc.innerRadius} onChange={(event) => update("innerRadius", event.target.value)} /></div></label></div><button type="button" disabled={readOnly || !node.arcData} onClick={() => onUpdate({ arcData: undefined })}>Reset ellipse</button></section>;
}

function TextInspector({ node, assets, fontAvailability, onUpdate, readOnly }: { node: CanvasNode; assets: DocumentAsset[]; fontAvailability?: EditorSnapshot["fontAvailability"]; onUpdate: (patch: Partial<CanvasNode>) => void; readOnly: boolean }) {
  const properties: DocumentTextProperties = node.textProperties ?? {
    runs: [],
    paragraph: { alignment: "left", lineHeight: DEFAULT_TEXT_LINE_HEIGHT, paragraphSpacing: 0 },
    autoSize: "fixed",
    fallbackFonts: [],
  };
  const primary = properties.runs[0];
  const variationAxesCanonical = formatFontVariationAxes(primary?.font?.variationAxes);
  const [textDraft, setTextDraft] = useState(node.text ?? "");
  const isComposingText = useRef(false);
  useEffect(() => {
    if (!isComposingText.current) setTextDraft(node.text ?? "");
  }, [node.id, node.text]);
  const fontStatus = primary?.font ? fontAvailability?.[primary.font.assetId] ?? "idle" : undefined;
  const fontAssets = assets.filter((asset) => asset.mediaType.startsWith("font/"));
  const updateProperties = (next: DocumentTextProperties) => onUpdate({ textProperties: next });
  const updateRun = (patch: Partial<NonNullable<DocumentTextProperties["runs"][number]>>) => {
    const textLength = new TextEncoder().encode(node.text ?? "").byteLength;
    const current = primary ?? { start: 0, end: textLength, fontSize: 31, fontWeight: 500, italic: false, letterSpacing: 0 };
    updateProperties({ ...properties, runs: textLength ? [{ ...current, ...patch, start: 0, end: textLength }] : [] });
  };
  const numeric = (value: string, apply: (number: number) => void) => {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) apply(parsed);
  };
  const commitText = (text: string) => {
    if (text === (node.text ?? "")) return;
    onUpdate({ text, textProperties: textReplacementProperties(node, text) });
  };
  return <section className="text-properties"><h2>Content</h2>
    <textarea
      readOnly={readOnly}
      value={textDraft}
      onCompositionStart={() => { isComposingText.current = true; }}
      onCompositionEnd={(event) => {
        isComposingText.current = false;
        const text = event.currentTarget.value;
        setTextDraft(text);
        commitText(text);
      }}
      onChange={(event) => {
        const text = event.target.value;
        setTextDraft(text);
        if (!isComposingText.current) commitText(text);
      }}
      onBlur={(event) => {
        if (!isComposingText.current) commitText(event.currentTarget.value);
      }}
      aria-label="Text content"
    />
    <div className="field-grid">
      <label className="field"><span>Font</span><div><select aria-label="Font" disabled={readOnly} value={primary?.font?.assetId ?? ""} onChange={(event) => updateRun({ font: event.target.value ? { assetId: event.target.value, faceIndex: primary?.font?.faceIndex ?? 0, variationAxes: primary?.font?.variationAxes } : undefined })}><option value="">System fallback</option>{fontAssets.map((asset) => <option value={asset.assetId} key={asset.assetId}>{asset.assetId.slice(0, 8)}</option>)}</select></div></label>
      <label className="field"><span>Size</span><div><input aria-label="Font size" disabled={readOnly} inputMode="decimal" value={primary?.fontSize ?? 31} onChange={(event) => numeric(event.target.value, (fontSize) => updateRun({ fontSize }))} /><em>px</em></div></label>
      <label className="field"><span>Weight</span><div><input aria-label="Font weight" disabled={readOnly} inputMode="numeric" value={primary?.fontWeight ?? 500} onChange={(event) => numeric(event.target.value, (fontWeight) => updateRun({ fontWeight }))} /></div></label>
      <VariationAxesField key={`${node.id}:${primary?.font?.assetId ?? "none"}:${primary?.font?.faceIndex ?? 0}:${variationAxesCanonical}`} font={primary?.font} readOnly={readOnly} onChange={(font) => updateRun({ font })} />
      <label className="field"><span>Tracking</span><div><input aria-label="Letter spacing" disabled={readOnly} inputMode="decimal" value={primary?.letterSpacing ?? 0} onChange={(event) => numeric(event.target.value, (letterSpacing) => updateRun({ letterSpacing }))} /><em>px</em></div></label>
      <label className="field"><span>Line height</span><div><input aria-label="Line height" disabled={readOnly} inputMode="decimal" value={properties.paragraph.lineHeight ?? DEFAULT_TEXT_LINE_HEIGHT} onChange={(event) => { const raw = event.target.value.trim(); if (!raw) updateProperties({ ...properties, paragraph: { ...properties.paragraph, lineHeight: undefined } }); else numeric(raw, (lineHeight) => { if (lineHeight > 0) updateProperties({ ...properties, paragraph: { ...properties.paragraph, lineHeight } }); }); }} /><em>px</em></div></label>
      <label className="field"><span>Paragraph</span><div><input aria-label="Paragraph spacing" disabled={readOnly} inputMode="decimal" value={properties.paragraph.paragraphSpacing} onChange={(event) => numeric(event.target.value, (paragraphSpacing) => { if (paragraphSpacing >= 0) updateProperties({ ...properties, paragraph: { ...properties.paragraph, paragraphSpacing } }); })} /><em>px</em></div></label>
    </div>
    <div className="text-controls">
      <label>Align <select aria-label="Text alignment" disabled={readOnly} value={properties.paragraph.alignment} onChange={(event) => updateProperties({ ...properties, paragraph: { ...properties.paragraph, alignment: event.target.value as DocumentTextProperties["paragraph"]["alignment"] } })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option><option value="justify">Justify</option></select></label>
      <label>Auto size <select aria-label="Text auto size" disabled={readOnly} value={properties.autoSize} onChange={(event) => updateProperties({ ...properties, autoSize: event.target.value as DocumentTextProperties["autoSize"] })}><option value="fixed">Fixed</option><option value="height">Auto height</option><option value="widthAndHeight">Auto width &amp; height</option></select></label>
      <label>Fallback <select aria-label="Fallback font" disabled={readOnly} value={properties.fallbackFonts?.[0]?.assetId ?? ""} onChange={(event) => updateProperties({ ...properties, fallbackFonts: event.target.value ? [{ assetId: event.target.value, faceIndex: 0 }] : [] })}><option value="">None</option>{fontAssets.filter((asset) => asset.assetId !== primary?.font?.assetId).map((asset) => <option value={asset.assetId} key={asset.assetId}>{asset.assetId.slice(0, 8)}</option>)}</select></label>
      <label className="toggle"><input aria-label="Italic" disabled={readOnly} type="checkbox" checked={primary?.italic ?? false} onChange={(event) => updateRun({ italic: event.target.checked })} />Italic</label>
    </div>
    {fontStatus && <p className="font-status" role="status">Font {fontStatus === "ready" ? "loaded" : fontStatus === "loading" ? "loading" : fontStatus === "unavailable" ? "unavailable — system fallback" : "not loaded"}</p>}
  </section>;
}

function VariationAxesField({ font, readOnly, onChange }: { font?: DocumentFontReference; readOnly: boolean; onChange: (font: DocumentFontReference) => void }) {
  const [draft, setDraft] = useState(() => formatFontVariationAxes(font?.variationAxes));
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
  return <label className="field"><span>Variations</span><div><input aria-label="Variable font axes" disabled={readOnly || !font} placeholder="wght=650, wdth=92" value={draft} onChange={(event) => { setDraft(event.target.value); setError(undefined); }} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } }} /></div>{error && <em role="alert">{error}</em>}</label>;
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

function sameDirection(gradient: DocumentLinearGradient, start: [number, number], end: [number, number]) {
  return gradient.start[0] === start[0] && gradient.start[1] === start[1] && gradient.end[0] === end[0] && gradient.end[1] === end[1];
}

function svgFileStem(value: string) {
  const stem = value.trim().replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "");
  return stem || "makefigma-page";
}
