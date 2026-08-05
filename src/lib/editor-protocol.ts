import type { EditorErrorCode } from "./editor-error";

export type { EditorErrorCode } from "./editor-error";

export type ToolKind = "select" | "frame" | "rectangle" | "ellipse" | "text" | "hand";
export type NodeKind = "frame" | "rectangle" | "ellipse" | "text" | "image";
/** A deterministic capture may opt out of the otherwise automatic WebGPU spike. */
export type RendererPreference = "auto" | "canvas2d";

/** Explicit non-premultiplied Canonical color. `fill` remains the Canvas/CSS display fallback. */
export interface DocumentColor {
  space: "srgb" | "display-p3" | "linear-srgb";
  components: [number, number, number];
  alpha: number;
}

export interface DocumentLinearGradient {
  start: [number, number];
  end: [number, number];
  stops: Array<{ position: number; color: DocumentColor }>;
}

/** A content-addressed font face; font bytes are held by the Asset Service. */
export interface DocumentFontReference {
  assetId: string;
  faceIndex: number;
  variationAxes?: Array<{ tag: string; value: number }>;
}

export interface DocumentTextProperties {
  runs: Array<{
    /** UTF-8 byte offsets, always aligned to Unicode scalar boundaries. */
    start: number;
    end: number;
    font?: DocumentFontReference;
    fontSize: number;
    fontWeight: number;
    italic: boolean;
    letterSpacing: number;
  }>;
  paragraph: {
    alignment: "left" | "center" | "right" | "justify";
    lineHeight?: number;
    paragraphSpacing: number;
  };
  autoSize: "fixed" | "height" | "widthAndHeight";
  fallbackFonts?: DocumentFontReference[];
}

export interface CanvasNode {
  id: string;
  /** Canonical Page ownership. Records written before Phase 1 omit this and
   * migrate deterministically to Page 1 in the Rust bridge. */
  pageId?: string;
  name: string;
  kind: NodeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  fill: string;
  fillColor?: DocumentColor;
  fillGradient?: DocumentLinearGradient;
  /** Canonical sibling-order key, opaque to presentation components. */
  positionId?: string;
  stroke: string;
  /** Canonical stroke Paint projection; `stroke` is only its CSS fallback. */
  strokeColor?: DocumentColor;
  strokeGradient?: DocumentLinearGradient;
  strokeWidth: number;
  radius: number;
  opacity: number;
  text?: string;
  /** Optional canonical text style record; omission means the stable default. */
  textProperties?: DocumentTextProperties;
  /** Present only for a canonical Image node. Asset bytes remain external. */
  assetId?: string;
  locked?: boolean;
  visible?: boolean;
}

export interface CanvasPage {
  id: string;
  name: string;
  positionId: string;
}

/** Durable, byte-free metadata for an admitted Asset Service object. */
export interface DocumentAsset {
  assetId: string;
  contentHash: string;
  mediaType: string;
  byteLength: number;
  pixelWidth?: number;
  pixelHeight?: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface DiagnosticEvent {
  sequence: number;
  atMs: number;
  category: "lifecycle" | "renderer" | "transaction" | "recovery" | "storage";
  code: string;
  documentRevision?: number;
  transactionId?: string;
  details?: Readonly<Record<string, string | number | boolean>>;
}

export interface RenderPerformanceSummary {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  cullingP95Ms: number;
  gpuPrepareP95Ms: number;
  overlayP95Ms: number;
  imageBitmapP95Ms: number;
  compositeP95Ms: number;
  candidateNodesP95: number;
  visibleNodesP95: number;
  gpuUploadBytesP95: number;
  rendersPerInputFrameMax: number;
}

export interface ViewportCheckpointMessage {
  type: "viewport-checkpoint";
  viewport: Viewport;
  documentHash: string;
  coreRevision: number;
}

export interface ViewportRecord {
  format: "viewport-record-v1";
  viewport: Viewport;
  documentHash: string;
  coreRevision: number;
}

/** New snapshots carry no rendering data outside the Core. Optional legacy fields
 * remain readable solely so v1–v8 local records can be migrated without loss. */
export type PresentationNode = Pick<CanvasNode, "id"> & Partial<Pick<CanvasNode, "stroke" | "strokeWidth" | "text" | "rotation">>;

export type CoreJournalOperation =
  | { type: "create"; node: CanvasNode }
  | { type: "update"; id: string; patch: Partial<CanvasNode> }
  | { type: "reposition"; positionIds: Array<{ id: string; positionId: string }> }
  | { type: "delete"; ids: string[] }
  | { type: "move"; updates: Array<Pick<CanvasNode, "id" | "x" | "y" | "width" | "height">> }
  | { type: "restore-core"; coreSnapshot: string };

/** An accepted Core operation retained until its resulting snapshot is durable. */
export interface LocalJournalEntry {
  format: "rust-core-operation-v1";
  id: string;
  baseRevision: number;
  acceptedRevision: number;
  operation: CoreJournalOperation;
  fallbackCoreSnapshot: string;
  presentation: PresentationNode[];
  viewport: Viewport;
}

/** A local-first operation awaiting a server-side accepted revision. Its envelope
 * is generated from schemas/proto and remains opaque to IndexedDB persistence. */
export interface PendingRemoteOperation {
  format: "pending-operation-v1";
  operationId: string;
  transactionId: string;
  documentId: string;
  baseRevision: number;
  envelope: Uint8Array;
  payloadHash: string;
  localDocumentHash: string;
  createdAtMs: number;
  attempts: number;
  /** A non-accepted server outcome is durable UI state. It is never resent until
   * a reconciler explicitly replaces it with a new operation. */
  reconciliation?: Extract<PendingOperationResolution, { kind: "transformed" | "conflict" | "rejected" }>;
  lastAttemptAtMs?: number;
}

export type PendingOperationResolution =
  | { kind: "accepted"; acceptedRevision: number; documentHash?: string }
  | { kind: "transformed"; acceptedRevision: number; documentHash?: string; diagnostic: string }
  | { kind: "conflict"; diagnostic: string }
  | { kind: "rejected"; diagnostic: string };

/** Durable local record. `coreSnapshot` is generated and validated by Rust/WASM;
 * presentation is an empty forward-compatible slot after the v9 migration. */
export interface CoreLocalSnapshot {
  format: "rust-core-v1";
  coreRevision: number;
  coreSnapshot: string;
  /** Canonical Core hash used only to associate the independent viewport record. */
  documentHash?: string;
  viewport: Viewport;
  presentation: PresentationNode[];
  /** Read from the separate IndexedDB journal store; never written into the snapshot. */
  journal?: LocalJournalEntry[];
  /** Set only during local recovery when the active manifest target failed validation. */
  recoveredFromPrevious?: boolean;
}

/** Transitional reader for records written before the Rust Core snapshot existed. */
export interface LegacyProjectionSnapshot {
  format: "legacy-projection-v0";
  nodes: CanvasNode[];
  viewport: Viewport;
}

/** A deterministic stress fixture. It validates in Core but is not persisted as
 * a second full browser Snapshot. */
export interface BenchmarkProjectionSnapshot {
  format: "benchmark-projection-v1";
  nodes: CanvasNode[];
  viewport: Viewport;
}

export type LocalDocumentSnapshot = CoreLocalSnapshot | LegacyProjectionSnapshot | BenchmarkProjectionSnapshot;

export interface EditorSnapshot {
  /** Stable Canonical Document identity, projected by the Rust/WASM snapshot. */
  documentId: string;
  revision: number;
  /** SHA-256 of the Core semantic state, excluding UI projection and history caches. */
  documentHash?: string;
  memory?: { nodeCount: number; nodeBytes: number; maxDocumentBytes: number; undoItems: number; undoBytes: number; redoItems: number; redoBytes: number; dedupeItems: number; dedupeBytes: number; operationDedupeItems: number; operationDedupeBytes: number };
  resources?: { documentNodes: number; maxDocumentNodes: number; documentBytes: number; maxDocumentBytes: number; wasmHeapBytes: number; maxWasmHeapBytes: number; renderSurfaceBytes: number; maxRenderSurfaceBytes: number; gpuSceneBytes: number; maxGpuSceneBytes: number; gpuSceneWithinBudget: boolean };
  /** Ephemeral, privacy-safe Engine Worker evidence; it never enters the document snapshot. */
  diagnostics?: { total: number; recent: readonly DiagnosticEvent[] };
  performance?: RenderPerformanceSummary;
  nodes: CanvasNode[];
  assets?: DocumentAsset[];
  /** Runtime-only FontFace loading state. It never enters Canonical snapshots. */
  fontAvailability?: Record<string, "idle" | "loading" | "ready" | "unavailable">;
  pages: CanvasPage[];
  activePageId: string;
  selectedIds: string[];
  viewport: Viewport;
  canUndo: boolean;
  canRedo: boolean;
  /** WebGPU scene primitives are composited onto the Canvas 2D grid/text overlay. */
  renderer: "Canvas 2D" | "WebGPU + Canvas 2D overlay";
  gpu?: { webgpu: "checking" | "ready" | "recovering" | "unavailable"; webgl2Available: boolean; recoveryAttempts: number };
  documentCore: "Starting Rust/WASM bridge" | "Rust/WASM bridge ready" | "TypeScript document prototype";
  localSnapshot?: CoreLocalSnapshot;
  localJournalEntry?: LocalJournalEntry;
}

export type EditorCommand =
  | { type: "create-page"; id: string; name: string }
  | { type: "select-page"; id: string }
  | { type: "create"; node: CanvasNode }
  | { type: "update"; id: string; patch: Partial<CanvasNode> }
  | { type: "reposition"; positionIds: Array<{ id: string; positionId: string }> }
  | { type: "select"; ids: string[] }
  | { type: "delete"; ids: string[] }
  | { type: "duplicate"; ids: string[] }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "reset" }
  | { type: "hydrate"; snapshot: LocalDocumentSnapshot };

/** A user intent. Core-edit batches are resolved in the Engine Worker and committed
 * atomically by Rust; selection, viewport and control commands stay out-of-band. */
export interface EditorTransaction {
  id: string;
  baseRevision: number;
  commands: EditorCommand[];
}

/** High-frequency browser input carried in a transferable binary batch. */
export type EditorInputEvent =
  /** Read-only followers may point-select and pan, but must never begin a document mutation. */
  | { type: "pointer"; event: "down" | "move" | "up" | "leave"; x: number; y: number; shiftKey: boolean; button: number; readOnly?: true }
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number; ctrlKey: boolean };

export type MainToWorker =
  | { type: "init"; canvas: OffscreenCanvas; width: number; height: number; dpr: number; rendererPreference: RendererPreference; simulateGpuLosses: number; simulateGpuLossAfterImage: boolean }
  | { type: "resize"; width: number; height: number; dpr: number }
  | { type: "tool"; tool: ToolKind }
  /** Requests a durable Core snapshot after a burst of ephemeral viewport input. */
  | { type: "checkpoint" }
  /** Asks the Engine Worker for the canonical Protobuf snapshot used only to
   * establish/recover the remote document root. */
  | { type: "remote-bootstrap" }
  /** Delivers a server-owned Protobuf snapshot for Rust/WASM validation and
   * reconciliation. It is never decoded into a TypeScript document model. */
  | { type: "remote-hydrate"; snapshot: Uint8Array }
  /** Commits an already admitted, document-attached AssetId into the canonical
   * Resource Index and queues its own opaque remote operation. */
  | { type: "register-asset"; transactionId: string; asset: DocumentAsset }
  /** Browser-owned bytes may seed a freshly imported image bitmap. They are
   * transient and are never retained in a document snapshot. */
  | { type: "asset-bytes"; assetId: string; mediaType: string; bytes: ArrayBuffer }
  /** Transient presentation state. The Canvas renderer omits this glyph layer
   * while the DOM editor draws the same text, avoiding the double-rendered
   * visual jump that browsers otherwise introduce on focus. */
  | { type: "editing-text"; nodeId?: string }
  /** Development-only fault injection, issued after a confirmed Core snapshot. */
  | { type: "simulate-crash" }
  | { type: "transaction"; transaction: EditorTransaction }
  | { type: "command"; command: EditorCommand }
  | EditorInputEvent
  | { type: "input"; buffer: ArrayBuffer }
  | { type: "key"; key: string; metaKey: boolean; shiftKey: boolean };

export type WorkerToMain =
  | { type: "snapshot"; snapshot: EditorSnapshot }
  | { type: "remote-bootstrap"; documentId: string; revision: number; snapshot: Uint8Array }
  /** A committed local Core batch represented as an opaque Protobuf envelope.
   * The main thread must durably append it before attempting network delivery. */
  | { type: "remote-operation"; operation: PendingRemoteOperation }
  /** Lightweight high-frequency projection update; never contains durable document data. */
  | { type: "view-state"; viewport: Viewport; selectedIds: string[]; performance: RenderPerformanceSummary; viewportChanged: boolean }
  /** A durable viewport payload deliberately separated from the full Core snapshot. */
  | ViewportCheckpointMessage
  | { type: "ready" }
  /** Worker-confirmed tool state, used for one-shot canvas creation. */
  | { type: "tool"; tool: ToolKind }
  | { type: "ack"; transactionId: string; acceptedRevision?: number; errorCode?: "REVISION_CONFLICT" | "INVALID_TRANSACTION" | "RESOURCE_LIMIT" }
  | { type: "error"; code: EditorErrorCode; safeMessage: string; retryable: boolean; documentRevision: number; diagnosticId: number; transactionId?: string };

export const createId = () => crypto.randomUUID();

/** Parses only the legacy hex syntax accepted by the Rust/WASM projection bridge. */
export function documentColorFromCssHex(value: string): DocumentColor | undefined {
  const hex = value.startsWith("#") ? value.slice(1) : "";
  const expanded = hex.length === 3 || hex.length === 4
    ? [...hex].map((component) => component + component).join("")
    : hex;
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(expanded)) return undefined;
  const red = Number.parseInt(expanded.slice(0, 2), 16);
  const green = Number.parseInt(expanded.slice(2, 4), 16);
  const blue = Number.parseInt(expanded.slice(4, 6), 16);
  const alpha = expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) : 255;
  return { space: "srgb", components: [red / 255, green / 255, blue / 255], alpha: alpha / 255 };
}

export function createNode(kind: NodeKind, x: number, y: number): CanvasNode {
  const presets: Record<NodeKind, Pick<CanvasNode, "name" | "width" | "height" | "fill" | "stroke" | "radius" | "text">> = {
    frame: { name: "Frame", width: 320, height: 220, fill: "#fbfbf8", stroke: "#d4d5cb", radius: 10 },
    rectangle: { name: "Rectangle", width: 180, height: 120, fill: "#e6edff", stroke: "#0048FF", radius: 12 },
    ellipse: { name: "Ellipse", width: 140, height: 140, fill: "#ffd8b7", stroke: "#bd6332", radius: 0 },
    text: { name: "Text", width: 220, height: 44, fill: "#23251f", stroke: "transparent", radius: 0, text: "Type something" },
    image: { name: "Image", width: 320, height: 220, fill: "#e6edff", stroke: "#0048FF", radius: 10 },
  };
  const preset = presets[kind];
  return { id: createId(), kind, x, y, rotation: 0, strokeWidth: 1, opacity: 1, visible: true, ...preset, fillColor: documentColorFromCssHex(preset.fill) };
}
