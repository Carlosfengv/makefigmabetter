import type { EditorErrorCode } from "./editor-error";

export type { EditorErrorCode } from "./editor-error";

export type ToolKind = "select" | "frame" | "section" | "rectangle" | "ellipse" | "line" | "arrow" | "text" | "hand";
export type NodeKind = "frame" | "group" | "section" | "rectangle" | "ellipse" | "line" | "text" | "image";
/** Canonical Figma-compatible endpoint decoration for open paths. */
export type StrokeCap = "none" | "round" | "square" | "arrowLines" | "arrowEquilateral" | "diamondFilled" | "triangleFilled" | "circleFilled";
/** Figma-compatible corner treatment for stroked paths. */
export type StrokeJoin = "miter" | "bevel" | "round";
export type StrokeAlign = "center" | "inside" | "outside";
/** Per-axis Figma Frame resize behavior; absence retains legacy no-constraint semantics. */
export type ConstraintType = "min" | "center" | "max" | "stretch" | "scale";
export interface DocumentConstraints { horizontal: ConstraintType; vertical: ConstraintType; }
/** Stable line-height for text records that predate an explicit paragraph value. */
export const DEFAULT_TEXT_LINE_HEIGHT = 20;
/** A deterministic capture may opt out of the otherwise automatic WebGPU spike. */
export type RendererPreference = "auto" | "canvas2d";
/** Development-only fault injection for browser evidence. This never enters a
 * document, operation or persisted editor snapshot. */
export type SimulatedGpuFault = "out-of-memory" | "validation" | "upload";

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
/** One ordered paint layer. `css` is the deterministic Canvas fallback while
 * `color`/`gradient` retain the canonical projection for round-tripping. */
export interface DocumentPaint {
  css: string;
  color?: DocumentColor;
  gradient?: DocumentLinearGradient;
}
export interface EllipseArcData { startingAngle: number; endingAngle: number; innerRadius: number; }
export interface RelativeTransform { a: number; b: number; c: number; d: number; e: number; f: number; }

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
    /** Optional only for legacy snapshots; omission resolves to 20px. */
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
  /** Structural parent. World-relative geometry preserves visual placement
   * during the first Group hierarchy slice. */
  parentId?: string;
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
  /** Empty retains the legacy singular fill fields; otherwise composites in order. */
  fills?: DocumentPaint[];
  /** Canonical sibling-order key, opaque to presentation components. */
  positionId?: string;
  stroke: string;
  /** Canonical stroke Paint projection; `stroke` is only its CSS fallback. */
  strokeColor?: DocumentColor;
  strokeGradient?: DocumentLinearGradient;
  /** Empty retains the legacy singular stroke fields; otherwise composites in order. */
  strokes?: DocumentPaint[];
  strokeWidth: number;
  strokeCapStart?: StrokeCap;
  strokeCapEnd?: StrokeCap;
  strokeJoin?: StrokeJoin;
  /** Default 10 preserves the historical Canvas 2D rendering contract. */
  strokeMiterLimit?: number;
  /** Alternating painted/gap lengths in document pixels. */
  strokeDashPattern?: number[];
  /** Frame/Rectangle-only top, right, bottom, left stroke widths. */
  strokeWeights?: [number, number, number, number];
  strokeAlign?: StrokeAlign;
  arcData?: EllipseArcData;
  /** Frame/Rectangle/Section-only TL/TR/BR/BL radii; absence uses `radius`. */
  cornerRadii?: [number, number, number, number];
  /** Frame/Rectangle/Section-only continuous-corner factor in [0, 1]. */
  cornerSmoothing?: number;
  constraints?: DocumentConstraints;
  /** Dual-read WP3 migration field. Absence retains legacy world x/y/rotation. */
  relativeTransform?: RelativeTransform;
  radius: number;
  opacity: number;
  text?: string;
  /** Optional canonical text style record; omission means the stable default. */
  textProperties?: DocumentTextProperties;
  /** Present only for a canonical Image node. Asset bytes remain external. */
  assetId?: string;
  locked?: boolean;
  visible?: boolean;
  /** Section-only: hides descendants while preserving the Section itself. */
  contentsHidden?: boolean;
  /** Frame-only. Omission retains Figma's default: descendants are clipped. */
  clipsContent?: boolean;
  /** Forward-compatibility payloads owned by newer engine versions. The browser
   * treats this as an opaque read-only pass-through: bytes are preserved verbatim
   * across every snapshot and operation boundary and never surfaced in the
   * Inspector. serde_json encodes each Rust `Vec<u8>` as a number array (P0-2). */
  extensions?: Record<string, number[]>;
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

/** A fully resolved Core mutation. It is intentionally byte-free so a pending
 * remote operation can be reapplied to a newer canonical snapshot after a
 * rejected base revision. */
export type CoreProjectionNode = Pick<CanvasNode, "id" | "pageId" | "parentId" | "name" | "kind" | "x" | "y" | "width" | "height" | "rotation" | "fill" | "fillColor" | "fillGradient" | "fills" | "positionId" | "stroke" | "strokeColor" | "strokeGradient" | "strokes" | "strokeWidth" | "strokeCapStart" | "strokeCapEnd" | "strokeJoin" | "strokeMiterLimit" | "strokeDashPattern" | "strokeWeights" | "strokeAlign" | "arcData" | "cornerRadii" | "cornerSmoothing" | "constraints" | "relativeTransform" | "opacity" | "visible" | "locked" | "contentsHidden" | "clipsContent" | "assetId" | "textProperties" | "extensions"> & { cornerRadius: number; text: string };
export type CoreBatchCommand =
  | { type: "create"; node: CoreProjectionNode }
  /** Explicit history replay; only a Core tombstone may be restored. */
  | { type: "restore"; node: CoreProjectionNode }
  | { type: "update"; node: CoreProjectionNode }
  | { type: "reposition"; positionIds: Array<{ id: string; positionId: string }> }
  | { type: "reparent"; parentIds: Array<{ id: string; parentId?: string; positionId: string }> }
  | { type: "delete"; ids: string[] };

/** The Worker-owned clipboard. It holds captured subtree projections by value,
 * carrying image references only as AssetIds — never raw bytes — so a paste into
 * another document must re-validate each AssetId against that document's
 * Resource Index before instantiating the node (P0-1). */
export interface EditorClipboard {
  /** Current durable schema version, guarding a stale cross-tab payload. */
  schemaVersion: number;
  /** Layer-ordered top-level roots to instantiate, in this capture. */
  rootIds: string[];
  /** Every node of every captured subtree, parent-before-child. */
  nodes: CanvasNode[];
  /** Distinct image AssetIds the capture references, for paste re-validation. */
  assetIds: string[];
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
  /** Browser input timestamp through completed Worker render. */
  inputToRenderSamples: number;
  inputToRenderP95Ms: number;
}

/** Rust-owned legal caret stops for an active DOM text-edit session. This is
 * transient input state; neither offsets nor selections enter Canonical state. */
export interface RustTextCaretLayout {
  carets: Array<{ byteOffset: number; lineIndex: number }>;
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
  | { type: "reparent"; ids: string[]; parentId?: string }
  | { type: "group"; ids: string[] }
  | { type: "ungroup"; id: string }
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

/** Keeps enough concrete local intent to derive a new opaque envelope after the
 * server rejects an older base revision. The original envelope remains opaque
 * during normal delivery; this data is used only by explicit reconciliation. */
export type PendingOperationReplay =
  | { kind: "core-batch"; batch: CoreBatchCommand[] }
  | { kind: "create-page"; page: CanvasPage }
  | { kind: "register-resource"; asset: DocumentAsset };

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
  replay?: PendingOperationReplay;
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
  gpu?: {
    webgpu: "checking" | "ready" | "recovering" | "unavailable";
    webgl2Available: boolean;
    recoveryAttempts: number;
    /** Development-only evidence for the bounded Device Lost recovery fixture. */
    developmentSimulation?: { requestedLosses: number; completedLosses: number };
  };
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
  /** Move selected hierarchy roots under a new parent while preserving world space. */
  | { type: "reparent"; ids: string[]; parentId?: string }
  | { type: "group"; ids: string[] }
  | { type: "ungroup"; id: string }
  | { type: "select"; ids: string[] }
  | { type: "delete"; ids: string[] }
  | { type: "duplicate"; ids: string[] }
  /** Captures the selected hierarchy roots into the Worker-owned clipboard.
   * Never carries raw asset bytes: image nodes reference an AssetId that paste
   * re-validates against the target document's Resource Index. */
  | { type: "copy"; ids: string[] }
  /** Copy followed by an atomic delete of the same subtree roots. */
  | { type: "cut"; ids: string[] }
  /** Instantiates the clipboard subtree under the current container or page
   * root, remapping every node to a fresh ID. No-op on an empty clipboard. */
  | { type: "paste" }
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
  | { type: "pointer"; event: "down" | "move" | "up" | "leave"; x: number; y: number; shiftKey: boolean; altKey: boolean; button: number; readOnly?: true; /** A repeated press selects through a Group instead of its container. */ drillDown?: true; /** Unix epoch milliseconds, never Canonical document data. */ occurredAt?: number }
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number; ctrlKey: boolean; /** Unix epoch milliseconds, never Canonical document data. */ occurredAt?: number };

export type MainToWorker =
  | { type: "init"; canvas: OffscreenCanvas; width: number; height: number; dpr: number; documentId?: string; rendererPreference: RendererPreference; simulateGpuLosses: number; simulateGpuLossAfterImage: boolean; simulateGpuFault?: SimulatedGpuFault }
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
  /** Applies a server snapshot, then replays every still-valid concrete local
   * pending intent before generating a replacement remote sequence. */
  | { type: "remote-reconcile"; snapshot: Uint8Array; operations: PendingRemoteOperation[] }
  /** Commits an already admitted, document-attached AssetId into the canonical
   * Resource Index and queues its own opaque remote operation. */
  | { type: "register-asset"; transactionId: string; asset: DocumentAsset }
  /** Browser-owned bytes may seed a freshly imported image bitmap. They are
   * transient and are never retained in a document snapshot. */
  | { type: "asset-bytes"; assetId: string; mediaType: string; bytes: ArrayBuffer; decodedBitmap?: ImageBitmap }
  /** Transient presentation state. The Canvas renderer omits this glyph layer
   * while the DOM editor draws the same text, avoiding the double-rendered
   * visual jump that browsers otherwise introduce on focus. */
  | { type: "editing-text"; nodeId?: string }
  /** Worker-owned Rust layout request used to legalize DOM caret offsets. */
  | { type: "text-caret-layout"; requestId: string; nodeId: string; text: string }
  /** Development-only fault injection, issued after a confirmed Core snapshot. */
  | { type: "simulate-crash" }
  | { type: "transaction"; transaction: EditorTransaction }
  | { type: "command"; command: EditorCommand }
  | EditorInputEvent
  | { type: "input"; buffer: ArrayBuffer }
  | {
      type: "key";
      key: string;
      metaKey: boolean;
      shiftKey: boolean;
      /** Resolved in the browser so the Worker never guesses platform shortcuts. */
      alternativeUngroup: boolean;
    };

export type WorkerToMain =
  | { type: "snapshot"; snapshot: EditorSnapshot }
  | { type: "remote-bootstrap"; documentId: string; revision: number; snapshot: Uint8Array }
  /** Requests an authorized destructive replacement of the remote demo root. */
  | { type: "remote-reset"; documentId: string; revision: number; snapshot: Uint8Array }
  /** A committed local Core batch represented as an opaque Protobuf envelope.
   * The main thread must durably append it before attempting network delivery. */
  | { type: "remote-operation"; operation: PendingRemoteOperation }
  /** A complete conflict/rejection reconciliation result. The main thread must
   * atomically replace the listed old queue IDs with these new envelopes before
   * resuming ordered delivery. */
  | { type: "remote-reconciled"; removeOperationIds: string[]; replacements: PendingRemoteOperation[]; discardedOperationIds: string[]; coreRejectedOperationIds: string[]; blockedOperationIds: string[]; rejectionDiagnostics: string[] }
  | { type: "text-caret-layout"; requestId: string; nodeId: string; text: string; layout?: RustTextCaretLayout }
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
    // Group is not a drawing tool. This neutral value is only used while an
    // atomic Group command derives its real bounds from child nodes.
    group: { name: "Group", width: 1, height: 1, fill: "transparent", stroke: "transparent", radius: 0 },
    section: { name: "Section", width: 640, height: 360, fill: "#f8fafc", stroke: "#94a3b8", radius: 12 },
    rectangle: { name: "Rectangle", width: 180, height: 120, fill: "#e6edff", stroke: "#0048FF", radius: 12 },
    ellipse: { name: "Ellipse", width: 140, height: 140, fill: "#ffd8b7", stroke: "#bd6332", radius: 0 },
    line: { name: "Line", width: 160, height: 0, fill: "transparent", stroke: "#0048FF", radius: 0 },
    text: { name: "Text", width: 220, height: 44, fill: "#23251f", stroke: "transparent", radius: 0, text: "Type something" },
    image: { name: "Image", width: 320, height: 220, fill: "#e6edff", stroke: "#0048FF", radius: 10 },
  };
  const preset = presets[kind];
  return { id: createId(), kind, x, y, rotation: 0, strokeWidth: 1, strokeCapStart: "none", strokeCapEnd: "none", strokeJoin: "miter", strokeMiterLimit: 10, strokeDashPattern: [], strokeAlign: "inside", opacity: 1, visible: true, ...preset, fillColor: documentColorFromCssHex(preset.fill) };
}
