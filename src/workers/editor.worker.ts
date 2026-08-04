/// <reference lib="webworker" />

import type { CanvasNode, CoreJournalOperation, CoreLocalSnapshot, EditorCommand, EditorSnapshot, LocalJournalEntry, MainToWorker, PresentationNode, RendererPreference, ToolKind, WorkerToMain } from "@/lib/editor-protocol";
import { createDiagnosticRecorder } from "@/lib/diagnostics";
import { findTopmostHit } from "@/lib/hit-test";
import { createRenderPerformanceSampler } from "@/lib/performance-sampling";
import { admitRenderSurface, MAX_RENDER_SURFACE_BYTES } from "@/lib/render-surface-budget";
import { assessWasmHeap, MAX_WASM_HEAP_BYTES } from "@/lib/wasm-heap-budget";
import { createNode, documentColorFromCssHex } from "@/lib/editor-protocol";
import { sampleLinearGradientForCanvas } from "@/lib/color-rendering";
import { layoutText, resolveTextRenderMetrics } from "@/lib/text-layout";
import { GpuSceneResourceLimitError, MAX_GPU_SCENE_RESOURCE_BYTES, WebGpuSceneRenderer } from "@/lib/webgpu-scene";
import { decodeInputBatch } from "@/lib/input-transfer";
import { resolveCoreBatch, type CoreProjectionNode } from "@/lib/transaction-batch";
import { migrateLegacyCoreRotationSnapshot } from "@/lib/legacy-rotation-migration";
import { classifyEditorError, editorError, type EditorErrorCode } from "@/lib/editor-error";
import { resetDocumentProjection } from "@/lib/document-reset";
import { resolveInsideRoundedRect } from "@/lib/rounded-rect";
import { clampCanvasZoom, resolveVisibleCanvasGridStep, shouldRenderCanvasGrid, snapCanvasPoint } from "@/lib/canvas-grid";
import { toolAfterLayerCreated } from "@/lib/creation-tool";
import { resolveMarqueeSelection, rotatedNodeBounds, selectNodesInMarquee } from "@/lib/marquee-selection";
import { selectionDimensions, selectionTitle } from "@/lib/selection-label";
import { resolveCanvasObjectSelection } from "@/lib/canvas-selection";

declare const self: DedicatedWorkerGlobalScope;

type Drag =
  | { mode: "draw"; startX: number; startY: number; node: CanvasNode }
  | { mode: "move"; startX: number; startY: number; before: CanvasNode[]; initial: Map<string, Pick<CanvasNode, "x" | "y">> }
  | { mode: "pan"; startX: number; startY: number }
  | { mode: "select"; startX: number; startY: number; currentX: number; currentY: number; initialSelection: string[]; additive: boolean };
type WasmProjectionNode = CoreProjectionNode;
type WasmProjectionSnapshot = { schemaVersion: number; revision: number; canUndo: boolean; canRedo: boolean; nodes: WasmProjectionNode[] };
type WasmDocumentEngine = {
  readonly revision: bigint;
  readonly can_undo: boolean;
  readonly can_redo: boolean;
  canonical_hash(): string;
  memory_stats_json(): string;
  create_node(transactionId: string, baseRevision: bigint, nodeId: string, kind: string, name: string, x: number, y: number, width: number, height: number, rotation: number, fill: string, stroke: string, strokeWidth: number, opacity: number, cornerRadius: number, visible: boolean, locked: boolean, text: string): bigint;
  seed_node(transactionId: string, baseRevision: bigint, nodeId: string, kind: string, name: string, x: number, y: number, width: number, height: number, rotation: number, fill: string, stroke: string, strokeWidth: number, opacity: number, cornerRadius: number, visible: boolean, locked: boolean, text: string): bigint;
  rename_node(transactionId: string, baseRevision: bigint, nodeId: string, name: string): bigint;
  update_node(transactionId: string, baseRevision: bigint, nodeId: string, name: string, x: number, y: number, width: number, height: number, rotation: number, fill: string, stroke: string, strokeWidth: number, opacity: number, cornerRadius: number, visible: boolean, locked: boolean, text: string): bigint;
  delete_nodes(transactionId: string, baseRevision: bigint, nodeIds: string): bigint;
  move_nodes(transactionId: string, baseRevision: bigint, updatesJson: string): bigint;
  apply_transaction_json(transactionId: string, baseRevision: bigint, commandsJson: string): bigint;
  undo(): bigint;
  redo(): bigint;
  snapshot_json(): string;
  load_snapshot_json(value: string): bigint;
  seed_batch_json(value: string): bigint;
};

let canvas: OffscreenCanvas | undefined;
let context: OffscreenCanvasRenderingContext2D | null = null;
let width = 0;
let height = 0;
let dpr = 1;
let tool: ToolKind = "select";
let nodes: CanvasNode[] = starterNodes();
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
let drag: Drag | undefined;
let documentCore: EditorSnapshot["documentCore"] = "Starting Rust/WASM bridge";
let wasmDocument: WasmDocumentEngine | undefined;
let bridgeLoadSequence = 0;
let gpuStatus: NonNullable<EditorSnapshot["gpu"]>["webgpu"] = "checking";
let webgl2Available = false;
let gpuProbeSequence = 0;
let gpuRecoveryAttempts = 0;
let gpuRenderer: WebGpuSceneRenderer | undefined;
let rendererPreference: RendererPreference = "auto";
let simulatedGpuLossesRequested = 0;
let simulatedGpuLosses = 0;
let gpuSceneBytes = 0;
let gpuSceneWithinBudget = true;
let gpuSceneLimitReported = false;
let renderSurfaceBytes = 0;
let wasmMemory: WebAssembly.Memory | undefined;
let wasmRuntimePromise: Promise<typeof import("@/wasm/generated/editor_wasm")> | undefined;
let wasmHeapOverBudget = false;
const diagnostics = createDiagnosticRecorder();
const renderPerformance = createRenderPerformanceSampler();

function starterNodes(): CanvasNode[] {
  return [
    { id: "00000000-0000-4000-8000-000000000001", name: "Product card", kind: "frame", x: -250, y: -170, width: 500, height: 340, rotation: 0, fill: "#fbfbf8", stroke: "#d4d5cb", strokeWidth: 1, radius: 18, opacity: 1, visible: true },
    { id: "00000000-0000-4000-8000-000000000002", name: "Sun disc", kind: "ellipse", x: -194, y: -112, width: 130, height: 130, rotation: 0, fill: "#f6ad62", stroke: "#b4612d", strokeWidth: 1, radius: 0, opacity: 1, visible: true },
    { id: "00000000-0000-4000-8000-000000000003", name: "Signal", kind: "rectangle", x: 48, y: -92, width: 150, height: 46, rotation: 0, fill: "#e1dcff", stroke: "#6657b7", strokeWidth: 1, radius: 23, opacity: 1, visible: true },
    { id: "00000000-0000-4000-8000-000000000004", name: "Headline", kind: "text", x: -194, y: 65, width: 370, height: 64, rotation: 0, fill: "#20221c", stroke: "transparent", strokeWidth: 0, radius: 0, opacity: 1, text: "Design, with intent.", visible: true },
  ];
}

function cloneDocument() { return structuredClone(nodes); }
function emit(message: WorkerToMain) { self.postMessage(message); }
function emitError(error: unknown, code?: EditorErrorCode, transactionId?: string) {
  const classified = code ? editorError(code) : classifyEditorError(error);
  const diagnostic = diagnostics.record({ category: "lifecycle", code: `ENGINE_${classified.code}`, documentRevision: revision, details: { errorCode: classified.code } });
  emit({ type: "error", ...classified, documentRevision: revision, diagnosticId: diagnostic.sequence, transactionId });
}
function emitSnapshot(localJournalEntry?: LocalJournalEntry, persistable = true) {
  const localSnapshot = persistable && wasmDocument ? { format: "rust-core-v1", coreRevision: Number(wasmDocument.revision), coreSnapshot: wasmDocument.snapshot_json(), viewport: { ...viewport }, presentation: nodes.map(presentationNode) } satisfies CoreLocalSnapshot : undefined;
  const memory = wasmDocument ? JSON.parse(wasmDocument.memory_stats_json()) as EditorSnapshot["memory"] : undefined;
  const wasmHeap = assessWasmHeap(wasmMemory?.buffer.byteLength ?? 0);
  if (!wasmHeap.withinBudget && wasmHeap.reason === "RESOURCE_LIMIT" && !wasmHeapOverBudget) {
    wasmHeapOverBudget = true;
    diagnostics.record({ category: "lifecycle", code: "WASM_HEAP_SOFT_LIMIT" });
  }
  if (wasmHeap.withinBudget) wasmHeapOverBudget = false;
  emit({ type: "snapshot", snapshot: { revision, documentHash: wasmDocument?.canonical_hash(), memory, resources: { documentNodes: memory?.nodeCount ?? nodes.length, maxDocumentNodes: 100_000, documentBytes: memory?.nodeBytes ?? 0, maxDocumentBytes: memory?.maxDocumentBytes ?? 256 * 1024 * 1024, wasmHeapBytes: wasmHeap.bytes, maxWasmHeapBytes: MAX_WASM_HEAP_BYTES, renderSurfaceBytes, maxRenderSurfaceBytes: MAX_RENDER_SURFACE_BYTES, gpuSceneBytes, maxGpuSceneBytes: MAX_GPU_SCENE_RESOURCE_BYTES, gpuSceneWithinBudget }, diagnostics: diagnostics.summary(), performance: renderPerformance.summary(), nodes, selectedIds, viewport, canUndo: undoOrder.length > 0, canRedo: redoOrder.length > 0, renderer: gpuRenderer && gpuSceneWithinBudget ? "WebGPU + Canvas 2D overlay" : "Canvas 2D", gpu: { webgpu: gpuStatus, webgl2Available, recoveryAttempts: gpuRecoveryAttempts }, documentCore, localSnapshot, localJournalEntry } });
}
function emitViewState(viewportChanged = false) {
  emit({ type: "view-state", viewport: { ...viewport }, selectedIds: [...selectedIds], performance: renderPerformance.summary(), viewportChanged });
}
function setRenderSurface(nextWidth: number, nextHeight: number, nextDpr: number) {
  const admission = admitRenderSurface(nextWidth, nextHeight, nextDpr);
  if (!admission.accepted) {
    diagnostics.record({ category: "renderer", code: "RENDER_SURFACE_REJECTED" });
    emitError(undefined, "RESOURCE_LIMIT");
    emitSnapshot(undefined, false);
    return false;
  }
  width = nextWidth;
  height = nextHeight;
  dpr = nextDpr;
  renderSurfaceBytes = admission.bytes;
  if (canvas && (canvas.width !== admission.pixelWidth || canvas.height !== admission.pixelHeight)) {
    canvas.width = Math.max(1, admission.pixelWidth);
    canvas.height = Math.max(1, admission.pixelHeight);
  }
  return true;
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
    gpuSceneBytes = 0;
    gpuSceneWithinBudget = true;
    gpuSceneLimitReported = false;
    gpuStatus = "ready";
    diagnostics.record({ category: "renderer", code: "WEBGPU_SCENE_READY" });
    render();
    emitSnapshot(undefined, false);
    if (simulatedGpuLosses < simulatedGpuLossesRequested) {
      simulatedGpuLosses += 1;
      diagnostics.record({ category: "renderer", code: "WEBGPU_DEVICE_LOSS_SIMULATION", details: { loss: simulatedGpuLosses } });
      setTimeout(() => {
        if (sequence === gpuProbeSequence && gpuRenderer === renderer) renderer.destroy();
      }, 100);
    }
    void renderer.deviceLost.then(() => {
      if (sequence !== gpuProbeSequence) return;
      gpuRenderer = undefined;
      gpuSceneBytes = 0;
      if (gpuRecoveryAttempts >= 1) {
        gpuStatus = "unavailable";
        diagnostics.record({ category: "renderer", code: "WEBGPU_RECOVERY_EXHAUSTED" });
        emitSnapshot(undefined, false);
        return;
      }
      gpuRecoveryAttempts += 1;
      gpuStatus = "recovering";
      emitSnapshot(undefined, false);
      setTimeout(() => { void probeGpuDevice(true); }, 250);
    });
  } catch {
    if (sequence !== gpuProbeSequence) return;
    gpuRenderer?.destroy();
    gpuRenderer = undefined;
    gpuSceneBytes = 0;
    gpuStatus = "unavailable";
    diagnostics.record({ category: "renderer", code: "WEBGPU_SCENE_FAILED" });
    emitSnapshot(undefined, false);
  }
}
function presentationNode(node: CanvasNode): PresentationNode {
  return { id: node.id };
}
function journalEntry(operation: CoreJournalOperation, baseRevision: number, id = crypto.randomUUID()): LocalJournalEntry | undefined {
  if (!wasmDocument) return undefined;
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
    id: node.id, name: node.name, kind: node.kind, x: node.x, y: node.y, width: node.width, height: node.height,
    rotation: node.rotation, fill: node.fill, fillColor: node.fillColor, fillGradient: node.fillGradient, positionId: node.positionId,
    stroke: node.stroke, strokeColor: node.strokeColor, strokeGradient: node.strokeGradient, strokeWidth: node.strokeWidth,
    radius: node.cornerRadius, opacity: node.opacity, text: node.text, visible: node.visible, locked: node.locked,
  };
}
function syncProjectionFromWasm(rememberExisting = true) {
  if (!wasmDocument) return;
  if (rememberExisting) rememberProjection();
  const snapshot = JSON.parse(wasmDocument.snapshot_json()) as WasmProjectionSnapshot;
  nodes = snapshot.nodes.map((node) => {
    const previous = preservedProjectionNodes.get(node.id);
    const projected = canvasNodeFromProjection(node);
    if (snapshot.schemaVersion < 3) projected.text = previous?.text;
    preservedProjectionNodes.set(projected.id, presentationNode(projected));
    return projected;
  });
  selectedIds = selectedIds.filter((id) => nodes.some((node) => node.id === id));
  revision = snapshot.revision;
}
function replayJournalEntry(engine: WasmDocumentEngine, entry: LocalJournalEntry) {
  if (entry.acceptedRevision <= Number(engine.revision)) return;
  try {
    if (entry.baseRevision !== Number(engine.revision)) throw new Error("JOURNAL_REVISION_CONFLICT");
    const operation = entry.operation;
    if (operation.type === "create" || operation.type === "update" || operation.type === "delete") {
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
async function loadDocumentBridge(localSnapshot?: CoreLocalSnapshot) {
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
      const hydrated = resolveCoreBatch([], nodes.map((node) => ({ type: "create" as const, node })));
      if (!hydrated) throw new Error("INVALID_LEGACY_PROJECTION");
      engine.seed_batch_json(JSON.stringify(hydrated.batch));
    }
    if (loadSequence !== bridgeLoadSequence) return;
    wasmDocument = engine;
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
    } else syncProjectionFromWasm();
    render();
    // Do not report Canvas/WASM hydration as editing latency. The next render is
    // triggered by steady-state user input, resize, or a confirmed UI action.
    renderPerformance.start();
    documentCore = "Rust/WASM bridge ready";
    diagnostics.record({ category: "lifecycle", code: "WASM_BRIDGE_READY", documentRevision: revision });
  } catch {
    if (loadSequence !== bridgeLoadSequence) return;
    wasmDocument = undefined;
    documentCore = "TypeScript document prototype";
    diagnostics.record({ category: "recovery", code: "WASM_BRIDGE_FALLBACK" });
    renderPerformance.start();
  }
  emitSnapshot();
}
async function loadWasmRuntime(): Promise<typeof import("@/wasm/generated/editor_wasm")> {
  if (!wasmRuntimePromise) {
    wasmRuntimePromise = import("@/wasm/generated/editor_wasm").then(async (wasm) => {
      await wasm.default();
      return wasm;
    });
  }
  try {
    return await wasmRuntimePromise;
  } catch (error) {
    wasmRuntimePromise = undefined;
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
      wasmDocument.create_node(crypto.randomUUID(), wasmDocument.revision, command.node.id, command.node.kind, command.node.name, command.node.x, command.node.y, command.node.width, command.node.height, command.node.rotation, command.node.fill, command.node.stroke, command.node.strokeWidth, command.node.opacity, command.node.radius, command.node.visible !== false, Boolean(command.node.locked), command.node.text ?? "");
    }
    if (command.type === "update" && ("name" in command.patch || "x" in command.patch || "y" in command.patch || "width" in command.patch || "height" in command.patch || "rotation" in command.patch || "fill" in command.patch || "stroke" in command.patch || "strokeWidth" in command.patch || "opacity" in command.patch || "radius" in command.patch || "text" in command.patch || "visible" in command.patch || "locked" in command.patch)) {
      const previous = nodes.find((node) => node.id === command.id);
      if (!previous) throw new Error("MISSING_NODE");
      const next = { ...previous, ...command.patch };
      wasmDocument.update_node(crypto.randomUUID(), wasmDocument.revision, command.id, next.name, next.x, next.y, next.width, next.height, next.rotation, next.fill, next.stroke, next.strokeWidth, next.opacity, next.radius, next.visible !== false, Boolean(next.locked), next.text ?? "");
    }
    if (command.type === "delete") {
      wasmDocument.delete_nodes(crypto.randomUUID(), wasmDocument.revision, command.ids.join(","));
    }
    return true;
  } catch (error) {
    emitError(error);
    return false;
  }
}
function isWasmDocumentCommand(command: EditorCommand) {
  return Boolean(wasmDocument) && (command.type === "create" || command.type === "delete" || (command.type === "update" && ("name" in command.patch || "x" in command.patch || "y" in command.patch || "width" in command.patch || "height" in command.patch || "rotation" in command.patch || "fill" in command.patch || "stroke" in command.patch || "strokeWidth" in command.patch || "opacity" in command.patch || "radius" in command.patch || "text" in command.patch || "visible" in command.patch || "locked" in command.patch)));
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
  wasmDocument = undefined;
  documentCore = "Starting Rust/WASM bridge";
  const reset = resetDocumentProjection(starterNodes());
  nodes = reset.nodes;
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
function commit(mutator: () => void, appliedByWasm = false, operation?: CoreJournalOperation, baseRevision?: number, advancesRevision = true) {
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
  else if (advancesRevision) revision += 1;
  render();
  emitSnapshot(operation && baseRevision !== undefined ? journalEntry(operation, baseRevision) : undefined);
}
function toWorld(x: number, y: number) { return { x: (x - width / 2) / viewport.zoom - viewport.x, y: (y - height / 2) / viewport.zoom - viewport.y }; }
function toScreen(x: number, y: number) { return { x: (x + viewport.x) * viewport.zoom + width / 2, y: (y + viewport.y) * viewport.zoom + height / 2 }; }
function frameNameLabelGeometry(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode) {
  const bounds = rotatedNodeBounds(node);
  const point = toScreen(bounds.x, bounds.y);
  ctx.save();
  ctx.font = '600 11px "Avenir Next", "Helvetica Neue", sans-serif';
  const textWidth = ctx.measureText(node.name).width;
  ctx.restore();
  return { x: Math.max(0, Math.min(point.x, width - textWidth)), baselineY: Math.max(11, Math.min(point.y - 4, height)), width: textWidth, height: 13 };
}
function hitFrameName(screenX: number, screenY: number) {
  if (!context) return undefined;
  return [...nodes].reverse().find((node) => {
    if (node.kind !== "frame" || node.visible === false || node.locked) return false;
    const label = frameNameLabelGeometry(context!, node);
    return screenX >= label.x && screenX <= label.x + label.width && screenY >= label.baselineY - label.height && screenY <= label.baselineY;
  });
}
function hit(worldX: number, worldY: number) {
  const node = findTopmostHit(nodes, { x: worldX, y: worldY });
  if (node) return node;
  const screen = toScreen(worldX, worldY);
  return hitFrameName(screen.x, screen.y);
}
function renderGrid(ctx: OffscreenCanvasRenderingContext2D) {
  if (!shouldRenderCanvasGrid(viewport.zoom)) return;
  const gap = resolveVisibleCanvasGridStep(viewport.zoom) * viewport.zoom;
  ctx.strokeStyle = "rgba(45, 48, 37, .075)";
  ctx.lineWidth = 1;
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
function hasVisibleStroke(node: CanvasNode): boolean {
  if (node.opacity <= 0 || node.strokeWidth <= 0) return false;
  if (node.strokeGradient) return node.strokeGradient.stops.some((stop) => stop.color.alpha > 0);
  const alpha = (node.strokeColor ?? documentColorFromCssHex(node.stroke))?.alpha;
  return alpha === undefined ? node.stroke !== "transparent" : alpha > 0;
}
function roundedRectPath(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}
function renderNode(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode) {
  if (node.visible === false) return;
  const point = toScreen(node.x, node.y);
  const w = node.width * viewport.zoom;
  const h = node.height * viewport.zoom;
  ctx.save();
  ctx.globalAlpha = node.opacity;
  ctx.translate(point.x + w / 2, point.y + h / 2);
  ctx.rotate(node.rotation * Math.PI / 180);
  ctx.translate(-w / 2, -h / 2);
  const paint = fillStyle(ctx, node, w, h);
  if (node.kind === "ellipse") {
    const geometry = resolveInsideRoundedRect(w, h, 0, node.strokeWidth * viewport.zoom);
    ctx.beginPath(); ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    if (hasVisibleStroke(node) && geometry.insideStrokeWidth > 0) {
      ctx.fillStyle = strokeStyle(ctx, node, w, h);
      ctx.fill();
      if (geometry.innerWidth > 0 && geometry.innerHeight > 0) {
        ctx.beginPath(); ctx.ellipse(w / 2, h / 2, geometry.innerWidth / 2, geometry.innerHeight / 2, 0, 0, Math.PI * 2);
        ctx.fillStyle = paint;
        ctx.fill();
      }
    } else {
      ctx.fillStyle = paint;
      ctx.fill();
    }
  } else if (node.kind === "text") {
    const textMetrics = resolveTextRenderMetrics(node.width, node.height, viewport.zoom);
    ctx.fillStyle = paint;
    ctx.font = `650 ${textMetrics.fontSize}px "Avenir Next", "Helvetica Neue", sans-serif`;
    ctx.textBaseline = "top";
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, textMetrics.width, textMetrics.height); ctx.clip();
    layoutText({ text: node.text ?? "Text", maxWidth: Math.max(1, textMetrics.width), measure: (value) => ctx.measureText(value).width }).forEach((line, index) => {
      const lineY = index * textMetrics.lineHeight;
      if (lineY < textMetrics.height) {
        ctx.direction = line.direction;
        ctx.textAlign = line.direction === "rtl" ? "right" : "left";
        ctx.fillText(line.text, line.direction === "rtl" ? textMetrics.width : 0, lineY);
      }
    });
    ctx.restore();
  } else {
    const geometry = resolveInsideRoundedRect(w, h, node.radius * viewport.zoom, node.strokeWidth * viewport.zoom);
    if (hasVisibleStroke(node) && geometry.insideStrokeWidth > 0) {
      roundedRectPath(ctx, 0, 0, w, h, geometry.outerRadius);
      ctx.fillStyle = strokeStyle(ctx, node, w, h);
      ctx.fill();
      if (geometry.innerWidth > 0 && geometry.innerHeight > 0) {
        roundedRectPath(ctx, geometry.innerX, geometry.innerY, geometry.innerWidth, geometry.innerHeight, geometry.innerRadius);
        ctx.fillStyle = paint;
        ctx.fill();
      }
    } else {
      roundedRectPath(ctx, 0, 0, w, h, geometry.outerRadius);
      ctx.fillStyle = paint;
      ctx.fill();
    }
  }
  ctx.restore();
}
function renderSelection(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode) {
  if (!selectedIds.includes(node.id)) return;
  const point = toScreen(node.x, node.y);
  const w = node.width * viewport.zoom;
  const h = node.height * viewport.zoom;
  ctx.save();
  ctx.translate(point.x + w / 2, point.y + h / 2);
  ctx.rotate(node.rotation * Math.PI / 180);
  ctx.translate(-w / 2, -h / 2);
  ctx.strokeStyle = "#5442a9"; ctx.lineWidth = 1; ctx.setLineDash([5, 4]); ctx.strokeRect(.5, .5, Math.max(0, w - 1), Math.max(0, h - 1)); ctx.setLineDash([]);
  ctx.restore();
}
function renderFrameName(ctx: OffscreenCanvasRenderingContext2D, node: CanvasNode) {
  if (node.kind !== "frame" || node.visible === false || selectedIds.includes(node.id)) return;
  const label = frameNameLabelGeometry(ctx, node);
  ctx.save();
  ctx.font = '600 11px "Avenir Next", "Helvetica Neue", sans-serif';
  ctx.fillStyle = "#23251f";
  ctx.textBaseline = "bottom";
  ctx.fillText(node.name, label.x, label.baselineY);
  ctx.restore();
}
function renderSelectionLabel(ctx: OffscreenCanvasRenderingContext2D) {
  const selectedNodes = nodes.filter((node) => node.visible !== false && selectedIds.includes(node.id));
  const title = selectionTitle(selectedNodes);
  if (selectedNodes.length === 0) return;
  const screenBounds = selectedNodes.map((node) => {
    const bounds = rotatedNodeBounds(node);
    const point = toScreen(bounds.x, bounds.y);
    return { left: point.x, top: point.y, right: point.x + bounds.width * viewport.zoom, bottom: point.y + bounds.height * viewport.zoom };
  });
  const leftEdge = Math.min(...screenBounds.map((bounds) => bounds.left));
  const topEdge = Math.min(...screenBounds.map((bounds) => bounds.top));
  const rightEdge = Math.max(...screenBounds.map((bounds) => bounds.right));
  const bottomEdge = Math.max(...screenBounds.map((bounds) => bounds.bottom));
  const dimensions = selectedNodes.length === 1
    ? selectionDimensions(selectedNodes[0].width, selectedNodes[0].height)
    : selectionDimensions((rightEdge - leftEdge) / viewport.zoom, (bottomEdge - topEdge) / viewport.zoom);
  const labelHeight = 20;
  const horizontalInset = 7;
  ctx.save();
  ctx.font = '600 11px "Avenir Next", "Helvetica Neue", sans-serif';
  if (title) {
    const titleWidth = ctx.measureText(title).width;
    const titleX = Math.max(0, Math.min(leftEdge, width - titleWidth));
    const titleY = Math.max(11, Math.min(topEdge - 4, height));
    ctx.fillStyle = "#5442a9";
    ctx.textBaseline = "bottom";
    ctx.fillText(title, titleX, titleY);
  }
  const labelWidth = Math.ceil(ctx.measureText(dimensions).width) + horizontalInset * 2;
  const labelX = Math.max(0, Math.min((leftEdge + rightEdge - labelWidth) / 2, width - labelWidth));
  const labelY = Math.max(0, Math.min(bottomEdge + 2, height - labelHeight));
  ctx.beginPath();
  ctx.roundRect(labelX, labelY, labelWidth, labelHeight, 3);
  ctx.fillStyle = "#5442a9";
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  ctx.fillText(dimensions, labelX + horizontalInset, labelY + labelHeight / 2);
  ctx.restore();
}
function updateMarqueeSelection(activeDrag: Extract<Drag, { mode: "select" }>, endX: number, endY: number) {
  activeDrag.currentX = endX;
  activeDrag.currentY = endY;
  const marqueeIds = selectNodesInMarquee(nodes, { x: activeDrag.startX, y: activeDrag.startY }, { x: endX, y: endY });
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
  ctx.fillStyle = "rgba(84, 66, 169, .10)";
  ctx.strokeStyle = "#5442a9";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.fillRect(x, y, marqueeWidth, marqueeHeight);
  ctx.strokeRect(x + .5, y + .5, marqueeWidth, marqueeHeight);
  ctx.restore();
}
function render() {
  if (!context || !canvas) return;
  const startedAt = performance.now();
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#eeeee8";
  context.fillRect(0, 0, width, height);
  let gpuRenderedNodeIds: ReadonlySet<string> | undefined;
  if (gpuRenderer) {
    try {
      const result = gpuRenderer.render({ nodes, viewport, width, height, dpr });
      context.drawImage(result.bitmap, 0, 0, width, height);
      result.bitmap.close();
      gpuRenderedNodeIds = result.renderedNodeIds;
      gpuSceneBytes = result.resourceBytes;
      gpuSceneWithinBudget = true;
      gpuSceneLimitReported = false;
    } catch (error) {
      if (error instanceof GpuSceneResourceLimitError) {
        gpuSceneBytes = error.admission.resourceBytes;
        gpuSceneWithinBudget = false;
        if (!gpuSceneLimitReported) diagnostics.record({ category: "renderer", code: "GPU_SCENE_RESOURCE_LIMIT" });
        gpuSceneLimitReported = true;
      } else {
        gpuSceneBytes = 0;
        gpuSceneWithinBudget = true;
        gpuRenderer.destroy();
        gpuRenderer = undefined;
        gpuStatus = "unavailable";
        diagnostics.record({ category: "renderer", code: "WEBGPU_SCENE_RENDER_FAILED" });
      }
    }
  }
  nodes.forEach((node) => { if (!gpuRenderedNodeIds?.has(node.id)) renderNode(context!, node); });
  nodes.forEach((node) => renderFrameName(context!, node));
  nodes.forEach((node) => renderSelection(context!, node));
  renderSelectionLabel(context);
  renderMarquee(context);
  renderGrid(context);
  renderPerformance.record(performance.now() - startedAt);
}
function dispatch(command: EditorCommand) {
  const baseRevision = wasmDocument ? Number(wasmDocument.revision) : undefined;
  if (!admitToWasm(command)) return;
  const appliedByWasm = isWasmDocumentCommand(command);
  switch (command.type) {
    case "create": {
      commit(() => { nodes.push(command.node); selectedIds = [command.node.id]; }, appliedByWasm, appliedByWasm ? { type: "create", node: command.node } : undefined, baseRevision);
      const nextTool = toolAfterLayerCreated(tool);
      if (nextTool !== tool) { tool = nextTool; emit({ type: "tool", tool }); }
      break;
    }
    case "update": commit(() => { nodes = nodes.map((node) => node.id === command.id ? { ...node, ...command.patch } : node); }, appliedByWasm, appliedByWasm ? { type: "update", id: command.id, patch: command.patch } : undefined, baseRevision); break;
    case "select": selectedIds = command.ids; render(); emitViewState(); break;
    case "delete": commit(() => { nodes = nodes.filter((node) => !command.ids.includes(node.id)); selectedIds = []; }, appliedByWasm, appliedByWasm ? { type: "delete", ids: command.ids } : undefined, baseRevision); break;
    case "duplicate": {
      if (!wasmDocument) {
        commit(() => { const copies = nodes.filter((node) => command.ids.includes(node.id)).map((node, index) => ({ ...node, id: crypto.randomUUID(), name: `${node.name} copy`, x: node.x + 24 + index * 8, y: node.y + 24 + index * 8 })); nodes.push(...copies); selectedIds = copies.map((node) => node.id); });
        break;
      }
      const resolved = resolveCoreBatch(nodes, [command]);
      if (!resolved) { emitError(undefined, "INVALID_COMMAND"); break; }
      const duplicateBaseRevision = Number(wasmDocument.revision);
      try {
        wasmDocument.apply_transaction_json(crypto.randomUUID(), wasmDocument.revision, JSON.stringify(resolved.batch));
        recordHistory("core");
        syncProjectionFromWasm(false);
        selectedIds = resolved.createdIds;
        render();
        emitSnapshot(journalEntry({ type: "restore-core", coreSnapshot: wasmDocument.snapshot_json() }, duplicateBaseRevision));
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
      wasmDocument.undo(); redoOrder.push(kind); syncProjectionFromWasm(); selectedIds = []; render(); emitSnapshot(journalEntry({ type: "restore-core", coreSnapshot: wasmDocument.snapshot_json() }, undoBaseRevision)); break;
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
      wasmDocument.redo(); undoOrder.push(kind); syncProjectionFromWasm(); selectedIds = []; render(); emitSnapshot(journalEntry({ type: "restore-core", coreSnapshot: wasmDocument.snapshot_json() }, redoBaseRevision)); break;
    }
    case "reset": resetDocumentToStarterNodes(); break;
    case "hydrate": {
      if (command.snapshot.format === "rust-core-v1") {
        viewport = { ...command.snapshot.viewport };
        void loadDocumentBridge(command.snapshot);
      } else {
        nodes = normalizeIds(command.snapshot.nodes);
        viewport = command.snapshot.viewport;
        render();
        emitSnapshot();
        void loadDocumentBridge();
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
  const controlCommand = transaction.commands.length === 1 && ["select", "undo", "redo", "reset", "hydrate"].includes(transaction.commands[0].type);
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
  const resolved = resolveCoreBatch(nodes, transaction.commands);
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
  if (event.event === "down") {
    if (tool === "hand" || event.button === 1) { drag = { mode: "pan", startX: event.x, startY: event.y }; return; }
    if (tool !== "select") {
      if (event.readOnly) { render(); emitViewState(); return; }
      const snapped = snapCanvasPoint(world);
      const node = createNode(tool, snapped.x, snapped.y);
      node.width = 4;
      node.height = 4;
      drag = { mode: "draw", startX: snapped.x, startY: snapped.y, node };
      return;
    }
    const target = hit(world.x, world.y);
    if (!target) {
      drag = { mode: "select", startX: world.x, startY: world.y, currentX: world.x, currentY: world.y, initialSelection: event.shiftKey ? [...selectedIds] : [], additive: event.shiftKey };
      if (!event.shiftKey) selectedIds = [];
      render();
      emitViewState();
      return;
    }
    selectedIds = resolveCanvasObjectSelection(selectedIds, target.id, event.shiftKey);
    if (target && !event.readOnly) drag = { mode: "move", startX: world.x, startY: world.y, before: cloneDocument(), initial: new Map(nodes.filter((node) => selectedIds.includes(node.id)).map((node) => [node.id, { x: node.x, y: node.y }])) };
    render(); emitViewState(); return;
  }
  if (!drag) return;
  const activeDrag = drag;
  if (event.readOnly && activeDrag.mode !== "pan" && activeDrag.mode !== "select") {
    // A lease can expire mid-drag. Restore the pre-drag projection instead of
    // leaving an uncommitted visual move in a follower tab.
    if (activeDrag.mode === "move" && activeDrag.before) {
      nodes = activeDrag.before;
      render();
      emitSnapshot(undefined, false);
    }
    if (event.event === "up") drag = undefined;
    return;
  }
  if (event.event === "move") {
    if (activeDrag.mode === "pan") { viewport.x += (event.x - activeDrag.startX) / viewport.zoom; viewport.y += (event.y - activeDrag.startY) / viewport.zoom; activeDrag.startX = event.x; activeDrag.startY = event.y; render(); emitViewState(true); }
    if (activeDrag.mode === "select") {
      updateMarqueeSelection(activeDrag, world.x, world.y);
      render();
      emitViewState();
    }
    if (activeDrag.mode === "draw" && activeDrag.node) {
      const end = snapCanvasPoint(world);
      activeDrag.node.x = Math.min(activeDrag.startX, end.x);
      activeDrag.node.y = Math.min(activeDrag.startY, end.y);
      activeDrag.node.width = Math.max(4, Math.abs(end.x - activeDrag.startX));
      activeDrag.node.height = Math.max(4, Math.abs(end.y - activeDrag.startY));
      render(); renderNode(context!, activeDrag.node);
    }
    if (activeDrag.mode === "move" && activeDrag.initial) {
      const dx = world.x - activeDrag.startX;
      const dy = world.y - activeDrag.startY;
      nodes = nodes.map((node) => {
        const start = activeDrag.initial?.get(node.id);
        return start ? { ...node, ...snapCanvasPoint({ x: start.x + dx, y: start.y + dy }) } : node;
      });
      render();
    }
  }
  if (event.event === "up") {
    if (activeDrag.mode === "select") {
      updateMarqueeSelection(activeDrag, world.x, world.y);
      drag = undefined;
      render();
      emitViewState();
      return;
    }
    if (activeDrag.mode === "draw" && activeDrag.node) { dispatch({ type: "create", node: activeDrag.node }); }
    if (activeDrag.mode === "move" && activeDrag.before) {
      if (wasmDocument) {
        try {
          const updates = nodes.filter((node) => activeDrag.initial?.has(node.id)).map(({ id, x, y, width, height }) => ({ id, x, y, width, height }));
          const baseRevision = Number(wasmDocument.revision);
          wasmDocument.move_nodes(crypto.randomUUID(), wasmDocument.revision, JSON.stringify(updates));
          recordHistory("core");
          syncProjectionFromWasm();
          render();
          emitSnapshot(journalEntry({ type: "move", updates }, baseRevision));
        } catch (error) {
          nodes = activeDrag.before;
          emitError(error);
          render();
          emitSnapshot();
        }
      } else { history.push({ nodes: activeDrag.before, advancesRevision: true }); recordHistory("local"); revision += 1; render(); emitSnapshot(); }
    }
    drag = undefined;
  }
}
function wheel(event: Extract<MainToWorker, { type: "wheel" }>) {
  if (event.ctrlKey) { const before = toWorld(event.x, event.y); viewport.zoom = clampCanvasZoom(viewport.zoom * (event.deltaY > 0 ? .9 : 1.1)); const after = toWorld(event.x, event.y); viewport.x += after.x - before.x; viewport.y += after.y - before.y; }
  else { viewport.x -= event.deltaX / viewport.zoom; viewport.y -= event.deltaY / viewport.zoom; }
  render(); emitViewState(true);
}
self.onmessage = ({ data }: MessageEvent<MainToWorker>) => {
  try {
    if (data.type === "init") { canvas = data.canvas; rendererPreference = data.rendererPreference; simulatedGpuLossesRequested = Math.min(2, Math.max(0, data.simulateGpuLosses)); context = canvas.getContext("2d"); setRenderSurface(data.width, data.height, data.dpr); diagnostics.record({ category: "lifecycle", code: "ENGINE_WORKER_READY" }); render(); emit({ type: "ready" }); emitSnapshot(); void loadDocumentBridge(); void probeGpuDevice(); }
    else if (data.type === "resize") { if (setRenderSurface(data.width, data.height, data.dpr)) render(); }
    else if (data.type === "tool") { tool = data.tool; }
    else if (data.type === "checkpoint") emitSnapshot();
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
      } else events.forEach((event) => { if (event.type === "pointer") pointer(event); else wheel(event); });
    }
    else if (data.type === "pointer") pointer(data);
    else if (data.type === "wheel") wheel(data);
    else if (data.type === "key") {
      if (data.metaKey && data.key.toLowerCase() === "z") dispatch({ type: data.shiftKey ? "redo" : "undo" });
      else if (data.metaKey && data.key.toLowerCase() === "d") dispatch({ type: "duplicate", ids: selectedIds });
      else if (data.key === "Backspace") dispatch({ type: "delete", ids: selectedIds });
    }
  } catch (error) { emitError(error); }
};
