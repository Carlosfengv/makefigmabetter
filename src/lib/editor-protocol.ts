import type { EditorErrorCode } from "./editor-error";
import type {
  FigmaRestAssetRequest,
  FigmaRestAuthorizedAsset,
  FigmaRestImportPlan,
} from "./figma-rest-import";

export type { EditorErrorCode } from "./editor-error";

export type ToolKind = "select" | "frame" | "section" | "rectangle" | "ellipse" | "polygon" | "star" | "vector" | "pen" | "line" | "arrow" | "text" | "slice" | "hand";
export type NodeKind = "frame" | "group" | "section" | "rectangle" | "ellipse" | "polygon" | "star" | "vector" | "booleanOperation" | "slice" | "line" | "text" | "image" | "codeBlock" | "component" | "instance" | "slot" | "componentSet" | "connector" | "embed" | "highlight" | "interactiveSlideElement" | "linkUnfurl" | "media" | "shapeWithText" | "slideGrid" | "slide" | "slideRow" | "stamp" | "sticky" | "table" | "tableCell" | "textPath" | "transformGroup" | "washiTape" | "widget";
/** Figma may append languages without a Plugin API major-version change, so
 * source is retained as an open string rather than an exhaustively closed enum. */
export type CodeBlockLanguage = string;
export type DocumentComponentPropertyDefinition = {
  type: "BOOLEAN" | "TEXT" | "INSTANCE_SWAP" | "VARIANT" | "SLOT";
  defaultValue?: string | boolean;
  description?: string;
  variantOptions?: string[];
};
export interface DocumentComponentMetadata {
  /** Local keys default to the Canonical NodeId. Imported remote keys stay
   * visible but mutating APIs reject the remote record. */
  key: string;
  remote: boolean;
  description: string;
  descriptionMarkdown: string;
  documentationLinks: Array<{ uri: string; name?: string }>;
  /** Mirrors Figma's readonly componentPropertyDefinitions; mutation methods
   * are added together with INSTANCE and SLOT semantics. */
  componentPropertyDefinitions: Record<string, DocumentComponentPropertyDefinition>;
}
export interface DocumentInstanceMetadata {
  mainComponentId: string;
  scaleFactor: number;
  componentProperties: Record<string, string | boolean>;
  overrides: Array<{ id: string; overriddenFields: string[] }>;
  isExposedInstance: boolean;
}
export interface DocumentSlotMetadata { propertyName: string; sourceSlotId?: string; }
export interface DocumentComponentSetMetadata extends DocumentComponentMetadata {
  variantGroupProperties: Record<string, { values: string[] }>;
}
export interface DocumentEmbedMetadata { srcUrl: string; canonicalUrl: string | null; title: string | null; provider: string | null; }
export interface DocumentLinkUnfurlMetadata { url: string; title: string | null; description: string | null; provider: string | null; }
export interface DocumentMediaMetadata { hash: string; }
export interface DocumentStickyMetadata { authorVisible: boolean; authorName: string; isWideWidth: boolean; }
export interface DocumentTableMetadata { rowHeights: number[]; columnWidths: number[]; }
export interface DocumentTableCellMetadata { rowIndex: number; columnIndex: number; }
export interface DocumentTextPathMetadata { startSegment: number; startPosition: number; autoRename: boolean; textAlignHorizontal: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED"; textAlignVertical: "TOP" | "CENTER" | "BOTTOM"; }
export type DocumentTransformModifier = Readonly<{ type: "REPEAT"; count: number; unitType: "RELATIVE" | "PIXELS"; offset: number; repeatType: "LINEAR"; axis: "HORIZONTAL" | "VERTICAL" } | { type: "REPEAT"; count: number; unitType: "RELATIVE" | "PIXELS"; offset: number; repeatType: "RADIAL" }>;
export interface DocumentWidgetMetadata { widgetId: string; syncedState: Record<string, unknown>; syncedMap: Record<string, Record<string, unknown>>; }
export type SlideTransitionStyle = "NONE" | "DISSOLVE" | "SLIDE_FROM_LEFT" | "SLIDE_FROM_RIGHT" | "SLIDE_FROM_BOTTOM" | "SLIDE_FROM_TOP" | "PUSH_FROM_LEFT" | "PUSH_FROM_RIGHT" | "PUSH_FROM_BOTTOM" | "PUSH_FROM_TOP" | "MOVE_FROM_LEFT" | "MOVE_FROM_RIGHT" | "MOVE_FROM_TOP" | "MOVE_FROM_BOTTOM" | "SLIDE_OUT_TO_LEFT" | "SLIDE_OUT_TO_RIGHT" | "SLIDE_OUT_TO_TOP" | "SLIDE_OUT_TO_BOTTOM" | "MOVE_OUT_TO_LEFT" | "MOVE_OUT_TO_RIGHT" | "MOVE_OUT_TO_TOP" | "MOVE_OUT_TO_BOTTOM" | "SMART_ANIMATE";
export type SlideTransitionCurve = "EASE_IN" | "EASE_OUT" | "EASE_IN_AND_OUT" | "LINEAR" | "GENTLE" | "QUICK" | "BOUNCY" | "SLOW";
export interface DocumentSlideMetadata { isSkippedSlide: boolean; transition: { style: SlideTransitionStyle; duration: number; curve: SlideTransitionCurve; timing: { type: "ON_CLICK" | "AFTER_DELAY"; delay?: number } }; }
/** Complete ShapeWithText shapeType vocabulary from the current Plugin API
 * typings. REST derives its documented subset below. */
export const SHAPE_WITH_TEXT_TYPES = ["SQUARE", "ELLIPSE", "ROUNDED_RECTANGLE", "DIAMOND", "TRIANGLE_UP", "TRIANGLE_DOWN", "PARALLELOGRAM_RIGHT", "PARALLELOGRAM_LEFT", "ENG_DATABASE", "ENG_QUEUE", "ENG_FILE", "ENG_FOLDER", "TRAPEZOID", "PREDEFINED_PROCESS", "SHIELD", "DOCUMENT_SINGLE", "DOCUMENT_MULTIPLE", "MANUAL_INPUT", "HEXAGON", "CHEVRON", "PENTAGON", "OCTAGON", "STAR", "PLUS", "ARROW_LEFT", "ARROW_RIGHT", "SUMMING_JUNCTION", "OR", "SPEECH_BUBBLE", "INTERNAL_STORAGE"] as const;
export type ShapeWithTextType = typeof SHAPE_WITH_TEXT_TYPES[number];
const SHAPE_WITH_TEXT_TYPE_SET: ReadonlySet<string> = new Set(SHAPE_WITH_TEXT_TYPES);
export function isShapeWithTextType(value: unknown): value is ShapeWithTextType {
  return typeof value === "string" && SHAPE_WITH_TEXT_TYPE_SET.has(value);
}
/** The REST ShapeType catalog currently omits Plugin-only TRIANGLE_UP. Derive
 * the documented 29-value subset from the Canonical/Plugin vocabulary. */
export const FIGMA_REST_SHAPE_WITH_TEXT_TYPES: readonly ShapeWithTextType[] = SHAPE_WITH_TEXT_TYPES.filter((type) => type !== "TRIANGLE_UP");
const FIGMA_REST_SHAPE_WITH_TEXT_TYPE_SET: ReadonlySet<string> = new Set(FIGMA_REST_SHAPE_WITH_TEXT_TYPES);
export function isFigmaRestShapeWithTextType(value: unknown): value is ShapeWithTextType {
  return typeof value === "string" && FIGMA_REST_SHAPE_WITH_TEXT_TYPE_SET.has(value);
}
export interface DocumentConnectorMetadata {
  lineType: "ELBOWED" | "STRAIGHT" | "CURVED";
  start: { endpointNodeId?: string; magnet?: "NONE" | "AUTO" | "TOP" | "RIGHT" | "BOTTOM" | "LEFT" | "CENTER"; x: number; y: number };
  end: { endpointNodeId?: string; magnet?: "NONE" | "AUTO" | "TOP" | "RIGHT" | "BOTTOM" | "LEFT" | "CENTER"; x: number; y: number };
  startStrokeCap: string;
  endStrokeCap: string;
  text: string;
  cornerRadius?: number;
}
/** Canonical Figma-compatible endpoint decoration for open paths. */
export type StrokeCap = "none" | "round" | "square" | "arrowLines" | "arrowEquilateral" | "diamondFilled" | "triangleFilled" | "circleFilled";
/** Figma-compatible corner treatment for stroked paths. */
export type StrokeJoin = "miter" | "bevel" | "round";
export type StrokeAlign = "center" | "inside" | "outside";
/** E1's first cross-renderer compositing subset. */
export type BlendMode = "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten" | "color-dodge" | "color-burn" | "hard-light" | "soft-light" | "difference" | "exclusion" | "hue" | "saturation" | "color" | "luminosity" | "pass-through" | "linear-burn" | "linear-dodge";
/** Per-axis Figma Frame resize behavior; absence retains legacy no-constraint semantics. */
export type ConstraintType = "min" | "center" | "max" | "stretch" | "scale";
export interface DocumentConstraints { horizontal: ConstraintType; vertical: ConstraintType; }
/** Canonical Frame auto-layout configuration. Absence retains legacy manual positioning. */
export type AutoLayoutMode = "none" | "horizontal" | "vertical";
/** `baseline` is valid only as a horizontal Frame's counter-axis alignment. */
export type AutoLayoutAlignment = "start" | "center" | "end" | "spaceBetween" | "baseline";
/** Figma counterAxisAlignContent's Phase 2 wrapped-track subset. */
export type AutoLayoutTrackAlignment = "auto" | "spaceBetween";
export type AutoLayoutSizing = "fixed" | "hug" | "fill";
export interface DocumentAutoLayout {
  mode: AutoLayoutMode;
  padding: [number, number, number, number];
  itemSpacing: number;
  /** Counter-axis gap between wrap tracks. Omission retains legacy itemSpacing. */
  trackSpacing?: number;
  /** Only meaningful when wrap is true; absence is Figma's AUTO behavior. */
  trackAlignment?: AutoLayoutTrackAlignment;
  wrap: boolean;
  primaryAlignment: AutoLayoutAlignment;
  counterAlignment: AutoLayoutAlignment;
  primarySizing: AutoLayoutSizing;
  counterSizing: AutoLayoutSizing;
  /** Direct Auto Layout child cross-axis override; absence inherits parent.
   * Baseline and spaceBetween are Frame-only values. */
  alignSelf?: "start" | "center" | "end";
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  absolute: boolean;
}
export type AutoLayoutPaddingSide = "top" | "right" | "bottom" | "left";
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

export interface DocumentGradientPaint {
  kind: "radial" | "angular" | "diamond";
  /** Figma-compatible node-local normalized coordinates to gradient-space. */
  transform: RelativeTransform;
  stops: Array<{ position: number; color: DocumentColor }>;
}

/** Legacy compatibility projection of the first Drop Shadow effect. */
export interface DocumentDropShadow {
  offsetX: number;
  offsetY: number;
  blurRadius: number;
  spread: number;
  color: DocumentColor;
  visible: boolean;
}
/** A blur of the node's isolated source surface, in document pixels. */
export interface DocumentLayerBlur { radius: number; visible: boolean; }
/** A shadow that is clipped to the node's isolated source alpha. */
export type DocumentInnerShadow = DocumentDropShadow;
/** A blur of already-composited backdrop pixels inside the source alpha. */
export interface DocumentBackgroundBlur { radius: number; visible: boolean; }
/** E1's ordered effect storage. Exactly one effect payload is present. */
export type DocumentEffect = { dropShadow: DocumentDropShadow; layerBlur?: never; innerShadow?: never; backgroundBlur?: never } | { layerBlur: DocumentLayerBlur; dropShadow?: never; innerShadow?: never; backgroundBlur?: never } | { innerShadow: DocumentInnerShadow; dropShadow?: never; layerBlur?: never; backgroundBlur?: never } | { backgroundBlur: DocumentBackgroundBlur; dropShadow?: never; layerBlur?: never; innerShadow?: never };
/** One ordered paint layer. `css` is the deterministic Canvas fallback while
 * `color`/`gradient` retain the canonical projection for round-tripping. */
export interface DocumentPaint {
  css: string;
  color?: DocumentColor;
  gradient?: DocumentLinearGradient;
  gradientPaint?: DocumentGradientPaint;
  /** Present when projected from the versioned Paint Stack. */
  layerOpacity?: number;
  layerBlendMode?: BlendMode;
}
export interface DocumentImagePaint {
  assetId: string;
  scaleMode: "fill" | "fit" | "crop" | "tile";
  transform: RelativeTransform;
  /** Independent Figma ImagePaint quarter-turn. Omitted is canonical zero. */
  rotationDegrees?: 0 | 90 | 180 | 270;
  /** Presence-bearing Figma image adjustments. Every present value is finite
   * and lies in the Plugin API's inclusive -1 through 1 range. */
  filters?: DocumentImageFilters;
}
export interface DocumentImageFilters {
  exposure?: number;
  contrast?: number;
  saturation?: number;
  temperature?: number;
  tint?: number;
  highlights?: number;
  shadows?: number;
}
export type DocumentPaintLayerPaint =
  | { paint: DocumentPaint; image?: never }
  | { image: DocumentImagePaint; paint?: never };
export type DocumentPaintLayer = DocumentPaintLayerPaint & {
  visible: boolean;
  opacity: number;
  blendMode: BlendMode;
};
/** Presence-bearing stack. `layers: []` is explicit no paint; an omitted stack
 * keeps the legacy singular/repeated compatibility fields authoritative. */
export interface DocumentPaintStack { layers: DocumentPaintLayer[]; }
export interface EllipseArcData { startingAngle: number; endingAngle: number; innerRadius: number; }
/** Canonical source for generated regular-shape outlines (ADR 0026). */
export type DocumentParametricShape = { kind: "polygon"; pointCount: number } | { kind: "star"; pointCount: number; innerRatio: number };
/** ADR 0028's durable selector; operands remain the Boolean node's children. */
export type DocumentBooleanOperation = "union" | "intersect" | "subtract" | "exclude";
/** Canonical editable path coordinates are local to their Vector node. */
export interface DocumentVectorPath {
  fillRule: "nonZero" | "evenOdd";
  subpaths: Array<{
    closed: boolean;
    points: Array<{
      id: string;
      x: number;
      y: number;
      handleIn?: { x: number; y: number };
      handleOut?: { x: number; y: number };
      pointType: "corner" | "mirrored" | "asymmetric";
    }>;
  }>;
}
export interface RelativeTransform { a: number; b: number; c: number; d: number; e: number; f: number; }

/** A content-addressed font face; font bytes are held by the Asset Service. */
export interface DocumentFontReference {
  assetId: string;
  faceIndex: number;
  variationAxes?: Array<{ tag: string; value: number }>;
}

export type DocumentTextCase = "original" | "upper" | "lower" | "title" | "smallCaps" | "smallCapsForced";
export type DocumentTextDecoration = "underline" | "strikethrough";
export type DocumentTextDecorationStyle = "wavy" | "dotted";
export type DocumentTextDecorationOffset = Readonly<{ value: number; unit: "pixels" | "percent" }>;
export type DocumentTextDecorationThickness = Readonly<{ value: number; unit: "pixels" | "percent" }>;
export type DocumentTextDecorationColor = Readonly<{
  color: DocumentColor;
  visible: boolean;
  opacity: number;
  blendMode: Exclude<BlendMode, "pass-through">;
}>;
export interface DocumentHyperlinkTarget {
  type: "URL" | "NODE";
  value: string;
}

export interface DocumentTextStyle {
  font?: DocumentFontReference;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  letterSpacing: number;
  /** Omission inherits the Text node's fill. */
  color?: DocumentColor;
  /** Presence is semantic: [] means no glyph paint; omission falls back to
   * the legacy run color and then to the owning Text node fill. */
  fillStack?: DocumentPaintStack;
  /** Omission preserves the legacy/original character presentation. */
  textCase?: DocumentTextCase;
  /** Omission means the range has no hyperlink metadata. */
  hyperlink?: DocumentHyperlinkTarget;
  /** Omission is Figma NONE. */
  textDecoration?: DocumentTextDecoration;
  /** Omission is Figma SOLID when textDecoration is active. */
  textDecorationStyle?: DocumentTextDecorationStyle;
  /** Omission is Figma AUTO when textDecoration is underline. */
  textDecorationOffset?: DocumentTextDecorationOffset;
  /** Omission is Figma AUTO when textDecoration is underline. */
  textDecorationThickness?: DocumentTextDecorationThickness;
  /** Omission is Figma AUTO when textDecoration is underline. */
  textDecorationColor?: DocumentTextDecorationColor;
  /** Omission preserves legacy continuous underlines; true skips descenders. */
  textDecorationSkipInk?: boolean;
  leadingTrim?: "capHeight";
  /** Explicit four-character OpenType feature overrides, keyed by uppercase tag. */
  openTypeFeatures?: Readonly<Record<string, boolean>>;
  /** Linked Figma TextStyle identity; omission means unlinked. */
  textStyleId?: string;
  /** Linked Figma PaintStyle identity for this range's fills. */
  paintStyleId?: string;
}

export interface DocumentTextProperties {
  runs: Array<DocumentTextStyle & {
    /** UTF-8 byte offsets, always aligned to Unicode scalar boundaries. */
    start: number;
    end: number;
  }>;
  paragraph: {
    alignment: "left" | "center" | "right" | "justify";
    /** Optional only for legacy snapshots; omission resolves to 20px. */
    lineHeight?: number;
    /** Omission is the legacy PIXELS interpretation. AUTO omits lineHeight. */
    lineHeightUnit?: "percent" | "auto";
    paragraphSpacing: number;
    /** First-line inset from the paragraph's left edge. */
    paragraphIndent?: number;
    /** Omission is Figma AUTO and preserves legacy document hashes. */
    textWrapStyle?: "balance" | "pretty";
    /** Omission is Figma NONE and preserves legacy document hashes. */
    listType?: "ordered" | "unordered";
    /** Omission is Figma's zero spacing between list items. */
    listSpacing?: number;
    /** Omission/false keeps list markers inside the text box. */
    hangingList?: boolean;
    /** Omission/false keeps boundary punctuation inside the text box. */
    hangingPunctuation?: boolean;
  };
  /** Sparse paragraph-level overrides keyed by UTF-8 paragraph starts. */
  paragraphStyleRuns?: Array<{
    start: number;
    /** Figma list nesting level; explicit zero is meaningful. */
    indentation?: number;
    /** Omission inherits the global list type; "none" explicitly disables it. */
    listType?: "none" | "ordered" | "unordered";
    /** Omission inherits the global spacing; explicit zero disables it. */
    listSpacing?: number;
    /** Omission inherits global paragraphSpacing; explicit zero disables it. */
    paragraphSpacing?: number;
    /** Omission inherits global paragraphIndent; explicit zero disables it. */
    paragraphIndent?: number;
    /** PIXELS/PERCENT value; absence with AUTO unit is meaningful. */
    lineHeight?: number;
    /** Absence with a value means PIXELS; both absent inherit the global style. */
    lineHeightUnit?: "percent" | "auto";
    /** Omission inherits the global style; "auto" explicitly disables it. */
    textWrapStyle?: "auto" | "balance" | "pretty";
  }>;
  autoSize: "fixed" | "height" | "widthAndHeight";
  fallbackFonts?: DocumentFontReference[];
  /** Omission has the same effective behavior as Figma DISABLED. */
  textTruncation?: "disabled" | "ending";
  /** Present only with ending truncation; Figma's public value must be >= 1. */
  maxLines?: number;
  /** Persistent insertion style used when text is empty. */
  baseStyle?: DocumentTextStyle;
}

/** Complete document-owned TextStyle resource. Imported Figma string IDs and
 * published keys are retained without remapping. */
export interface DocumentTextStyleResource {
  id: string;
  key: string;
  name: string;
  description: string;
  remote: boolean;
  style: DocumentTextStyle;
  paragraph: DocumentTextProperties["paragraph"];
}

/** Complete document-owned PaintStyle resource. */
export interface DocumentPaintStyleResource {
  id: string;
  key: string;
  name: string;
  description: string;
  remote: boolean;
  paints: DocumentPaintStack;
}

export type DocumentVariableResolvedType = "BOOLEAN" | "COLOR" | "FLOAT" | "STRING";
export interface DocumentVariableMode { modeId: string; name: string; }
export interface DocumentVariableCollectionResource {
  id: string;
  key: string;
  name: string;
  remote: boolean;
  hiddenFromPublishing: boolean;
  modes: DocumentVariableMode[];
  defaultModeId: string;
}
export type DocumentVariableAlias = { type: "VARIABLE_ALIAS"; id: string };
export type DocumentVariableValue = boolean | number | string | DocumentColor | DocumentVariableAlias;
export interface DocumentVariableResource {
  id: string;
  key: string;
  name: string;
  description: string;
  remote: boolean;
  hiddenFromPublishing: boolean;
  collectionId: string;
  resolvedType: DocumentVariableResolvedType;
  valuesByMode: Record<string, DocumentVariableValue>;
  scopes: string[];
  codeSyntax?: Record<string, string>;
}

/** M3's durable prototype contract.  It intentionally lives beside the Canvas
 * projection rather than in UI state, and is encoded through the Canonical
 * extension map by transaction-batch. */
export type DocumentPrototypeTrigger = { type: "ON_CLICK" | "ON_PRESS" | "ON_HOVER" } | { type: "AFTER_TIMEOUT"; timeout: number };
export type DocumentPrototypeTransition = { type: "NONE" } | { type: "DISSOLVE"; duration: number; easing?: "LINEAR" | "EASE_IN" | "EASE_OUT" | "EASE_IN_AND_OUT" } | { type: "DIRECTIONAL"; direction: "LEFT" | "RIGHT" | "UP" | "DOWN"; duration: number; easing?: "LINEAR" | "EASE_IN" | "EASE_OUT" | "EASE_IN_AND_OUT" } | { type: "SMART_ANIMATE"; duration: number; easing?: "LINEAR" | "EASE_IN" | "EASE_OUT" | "EASE_IN_AND_OUT" };
export type DocumentPrototypeAction = { type: "NODE"; navigation: "NAVIGATE" | "OVERLAY"; destinationId: string | null; transition?: DocumentPrototypeTransition | null; overlayRelativePosition?: { x: number; y: number } } | { type: "CHANGE_TO"; destinationId: string | null; transition?: DocumentPrototypeTransition | null } | { type: "BACK" | "CLOSE" } | { type: "URL"; url: string };
export interface DocumentPrototypeReaction { trigger: DocumentPrototypeTrigger; actions: DocumentPrototypeAction[]; }
export interface DocumentPrototypeMetadata { startingPoint?: boolean; overlay?: { positionType: "CENTER" | "MANUAL"; relativePosition?: { x: number; y: number }; backgroundInteraction: "CLOSE_ON_CLICK_OUTSIDE" | "DO_NOTHING" }; }

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
  fillStack?: DocumentPaintStack;
  /** Canonical identity of the PaintStyle currently applied to fills. */
  fillStyleId?: string;
  /** Canonical sibling-order key, opaque to presentation components. */
  positionId?: string;
  stroke: string;
  /** Canonical stroke Paint projection; `stroke` is only its CSS fallback. */
  strokeColor?: DocumentColor;
  strokeGradient?: DocumentLinearGradient;
  /** Empty retains the legacy singular stroke fields; otherwise composites in order. */
  strokes?: DocumentPaint[];
  strokeStack?: DocumentPaintStack;
  /** Canonical identity of the PaintStyle currently applied to strokes. */
  strokeStyleId?: string;
  /** Deprecated Figma alias for a frame-like node's fill style. */
  backgroundStyleId?: string;
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
  parametricShape?: DocumentParametricShape;
  vectorPath?: DocumentVectorPath;
  booleanOperation?: DocumentBooleanOperation;
  /** Frame/Rectangle/Section-only TL/TR/BR/BL radii; absence uses `radius`. */
  cornerRadii?: [number, number, number, number];
  /** Frame/Rectangle/Section-only continuous-corner factor in [0, 1]. */
  cornerSmoothing?: number;
  constraints?: DocumentConstraints;
  autoLayout?: DocumentAutoLayout;
  /** Dual-read WP3 migration field. Absence retains legacy world x/y/rotation. */
  relativeTransform?: RelativeTransform;
  radius: number;
  opacity: number;
  /** Defaults to normal/source-over for documents authored before E1. */
  blendMode?: BlendMode;
  /** Optional Canonical base effect. Absence means no shadow. */
  dropShadow?: DocumentDropShadow;
  /** Empty retains the legacy base effect; otherwise this ordered stack wins. */
  effectStack?: DocumentEffect[];
  text?: string;
  /** CODE_BLOCK-only. The source itself is stored in `text` so existing Core
   * text-size and persistence limits remain the single durable boundary. */
  codeLanguage?: CodeBlockLanguage;
  componentMetadata?: DocumentComponentMetadata;
  instanceMetadata?: DocumentInstanceMetadata;
  slotMetadata?: DocumentSlotMetadata;
  componentSetMetadata?: DocumentComponentSetMetadata;
  connectorMetadata?: DocumentConnectorMetadata;
  embedMetadata?: DocumentEmbedMetadata;
  highlightHandleMirroring?: "NONE" | "ANGLE" | "ANGLE_AND_LENGTH";
  interactiveSlideElementType?: "POLL" | "EMBED" | "FACEPILE" | "ALIGNMENT" | "YOUTUBE";
  linkUnfurlMetadata?: DocumentLinkUnfurlMetadata;
  mediaMetadata?: DocumentMediaMetadata;
  shapeWithTextType?: ShapeWithTextType;
  slideMetadata?: DocumentSlideMetadata;
  stickyMetadata?: DocumentStickyMetadata;
  tableMetadata?: DocumentTableMetadata;
  tableCellMetadata?: DocumentTableCellMetadata;
  textPathMetadata?: DocumentTextPathMetadata;
  transformModifiers?: DocumentTransformModifier[];
  widgetMetadata?: DocumentWidgetMetadata;
  /** Optional canonical text style record; omission means the stable default. */
  textProperties?: DocumentTextProperties;
  reactions?: DocumentPrototypeReaction[];
  prototypeMetadata?: DocumentPrototypeMetadata;
  /** Present only for a canonical Image node. Asset bytes remain external. */
  assetId?: string;
  locked?: boolean;
  visible?: boolean;
  /** Section-only: hides descendants while preserving the Section itself. */
  contentsHidden?: boolean;
  /** Frame-only. Omission retains Figma's default: descendants are clipped. */
  clipsContent?: boolean;
  /** G4 alpha mask source for following siblings in the same container. */
  isMask?: boolean;
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

/** Immutable OpenType name-table projection for one admitted font face. */
export interface DocumentFontFaceMetadata {
  faceIndex: number;
  family: string;
  style: string;
  /** Sorted, unique localized identities for the same admitted face. */
  aliases?: readonly DocumentFontNameAlias[];
}

export interface DocumentFontNameAlias {
  family: string;
  style: string;
}

/** Durable, byte-free metadata for an admitted Asset Service object. */
export interface DocumentAsset {
  assetId: string;
  contentHash: string;
  mediaType: string;
  byteLength: number;
  pixelWidth?: number;
  pixelHeight?: number;
  fontFaces?: readonly DocumentFontFaceMetadata[];
}

/** A fully resolved Core mutation. It is intentionally byte-free so a pending
 * remote operation can be reapplied to a newer canonical snapshot after a
 * rejected base revision. */
export type CoreProjectionNode = Pick<CanvasNode, "id" | "pageId" | "parentId" | "name" | "kind" | "x" | "y" | "width" | "height" | "rotation" | "fill" | "fillColor" | "fillGradient" | "fills" | "fillStack" | "fillStyleId" | "positionId" | "stroke" | "strokeColor" | "strokeGradient" | "strokes" | "strokeStack" | "strokeStyleId" | "backgroundStyleId" | "strokeWidth" | "strokeCapStart" | "strokeCapEnd" | "strokeJoin" | "strokeMiterLimit" | "strokeDashPattern" | "strokeWeights" | "strokeAlign" | "arcData" | "parametricShape" | "vectorPath" | "booleanOperation" | "cornerRadii" | "cornerSmoothing" | "constraints" | "autoLayout" | "relativeTransform" | "opacity" | "blendMode" | "dropShadow" | "effectStack" | "visible" | "locked" | "contentsHidden" | "clipsContent" | "isMask" | "assetId" | "textProperties" | "extensions"> & { cornerRadius: number; text: string };
export type CoreBatchCommand =
  /** External imports create ordered Pages and their scene tree in the same
   * Canonical transaction; ordinary UI page creation remains a convenience
   * command above this lower-level batch protocol. */
  | { type: "createPage"; page: CanvasPage }
  /** An Asset Service-admitted resource may be registered in the same Core
   * transaction as nodes that first reference it (cross-document paste). */
  | { type: "registerAsset"; asset: DocumentAsset }
  | { type: "registerTextStyle"; style: DocumentTextStyleResource }
  | { type: "registerPaintStyle"; style: DocumentPaintStyleResource }
  | { type: "registerVariableCollection"; collection: DocumentVariableCollectionResource }
  | { type: "registerVariable"; variable: DocumentVariableResource }
  | { type: "setVariable"; variable: DocumentVariableResource }
  | { type: "deleteVariable"; id: string }
  | { type: "setVariableCollection"; collection: DocumentVariableCollectionResource; variables: DocumentVariableResource[] }
  | { type: "deleteVariableCollection"; id: string }
  | { type: "create"; node: CoreProjectionNode }
  /** Explicit history replay; only a Core tombstone may be restored. */
  | { type: "restore"; node: CoreProjectionNode }
  | { type: "update"; node: CoreProjectionNode; /** Figma-compatible resizeWithoutConstraints transport flag. */ ignoreConstraints?: true; /** Persist only text content and any supported TextProperties without replaying geometry. */ plainTextOnly?: true; /** The same TextPath text edit also updated its auto-derived name. */ renameTextPath?: true }
  | { type: "convertToTextPath"; node: CoreProjectionNode }
  | { type: "moveVectorPoint"; id: string; pointId: string; x: number; y: number }
  | { type: "setVectorSubpathClosed"; id: string; subpathIndex: number; closed: boolean }
  | { type: "insertVectorPoint"; id: string; subpathIndex: number; afterPointId?: string; point: DocumentVectorPath["subpaths"][number]["points"][number] }
  | { type: "splitVectorSegment"; id: string; subpathIndex: number; afterPointId: string; t: number; pointId: string }
  | { type: "connectVectorEndpoints"; id: string; firstSubpathIndex: number; firstPointId: string; secondSubpathIndex: number; secondPointId: string }
  | { type: "setMask"; id: string; enabled: boolean }
  | { type: "setExtensions"; id: string; extensions: Record<string, number[]> }
  | { type: "deleteVectorPoint"; id: string; pointId: string }
  | { type: "setVectorPointHandles"; id: string; pointId: string; handleIn?: { x: number; y: number }; handleOut?: { x: number; y: number }; pointType: DocumentVectorPath["subpaths"][number]["points"][number]["pointType"] }
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
  /** Present only after decoding the transferable v1 envelope. It binds every
   * referenced AssetId/FontId to its source content hash; the target Worker
   * compares it with its own Resource Index before creating any nodes. */
  assetContentHashes?: Record<string, string>;
  /** Byte-free Asset Service metadata carried only by a validated external
   * clipboard envelope. It permits the target to request an explicit document
   * attachment before the same Core transaction registers and references it. */
  resourceAssets?: DocumentAsset[];
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
  gpuIslandP95Ms: number;
  canvasIslandP95Ms: number;
  overlayP95Ms: number;
  imageBitmapP95Ms: number;
  compositeP95Ms: number;
  candidateNodesP95: number;
  visibleNodesP95: number;
  gpuUploadBytesP95: number;
  canvasReadbackBytesP95: number;
  gpuCoverageUpperBoundPixelsP95: number;
  canvasFallbackCoverageUpperBoundPixelsP95: number;
  compositeSurfaceBytesP95: number;
  rendersPerInputFrameMax: number;
  /** Browser input timestamp through completed Worker render. */
  inputToRenderSamples: number;
  inputToRenderP95Ms: number;
}

/** Rust-owned legal caret stops for an active DOM text-edit session. This is
 * transient input state; neither offsets nor selections enter Canonical state. */
export interface RustTextCaretLayout {
  unitsPerEm?: number;
  carets: Array<{ byteOffset: number; lineIndex: number }>;
  lines?: Array<{
    start: number;
    end: number;
    direction: "ltr" | "rtl";
    advance?: number;
    visualRuns?: Array<{ start: number; end: number; direction: "ltr" | "rtl" }>;
    visualCarets?: Array<{ byteOffset: number; xAdvance: number }>;
  }>;
}

export interface ViewportCheckpointMessage {
  type: "viewport-checkpoint";
  viewport: Viewport;
  activePageId: string;
  pageViewports: Record<string, Viewport>;
  documentHash: string;
  coreRevision: number;
}

export interface ViewportRecord {
  format: "viewport-record-v1";
  viewport: Viewport;
  /** Optional for records written before page-scoped viewport persistence. */
  activePageId?: string;
  pageViewports?: Record<string, Viewport>;
  documentHash: string;
  coreRevision: number;
}

/** New snapshots carry no rendering data outside the Core. Optional legacy fields
 * remain readable solely so v1–v8 local records can be migrated without loss. */
export type PresentationNode = Pick<CanvasNode, "id"> & Partial<Pick<CanvasNode, "stroke" | "strokeWidth" | "text" | "rotation">>;

export type CoreJournalOperation =
  | { type: "create"; node: CanvasNode }
  | { type: "update"; id: string; patch: Partial<CanvasNode> }
  /** Applies geometry while deliberately leaving constrained descendants in
   * place. Used by Command/Ctrl-resize and the Plugin API's
   * `resizeWithoutConstraints` method. */
  | { type: "resizeWithoutConstraints"; id: string; patch: Partial<Pick<CanvasNode, "x" | "y" | "width" | "height" | "rotation" | "relativeTransform" | "autoLayout">> }
  | { type: "reposition"; positionIds: Array<{ id: string; positionId: string }> }
  | { type: "reparent"; ids: string[]; parentId?: string }
  | { type: "group"; ids: string[]; /** Creates an Auto Layout Frame wrapper instead of a Group. */ autoLayout?: DocumentAutoLayout }
  | { type: "transformGroup"; ids: string[]; id?: string; parentId?: string; pageId?: string; index?: number; modifiers: DocumentTransformModifier[]; patch?: Partial<CanvasNode> }
  /** Wraps two or more selected hierarchy roots in a live Boolean container. */
  | { type: "boolean"; ids: string[]; operation: DocumentBooleanOperation; id?: string; parentId?: string; pageId?: string; index?: number; patch?: Partial<CanvasNode> }
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
  /** Attached from the independent viewport record; never enters Core. */
  activePageId?: string;
  pageViewports?: Record<string, Viewport>;
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
  /** Fixture-only Resource Index records admitted before legacy nodes hydrate.
   * Raw bytes remain transient and are delivered separately to the Worker. */
  assets?: DocumentAsset[];
}

/** A deterministic stress fixture. It validates in Core but is not persisted as
 * a second full browser Snapshot. */
export interface BenchmarkProjectionSnapshot {
  format: "benchmark-projection-v1";
  nodes: CanvasNode[];
  viewport: Viewport;
  /** Optional Worker-only action executed after Core hydration. It exists to
   * measure one deterministic transaction in the same WASM instance and is
   * never serialized into a Canonical snapshot. */
  benchmark?: {
    kind: "pf02-layout-cascade";
    frameId: string;
    targetWidth: number;
  };
}

export type LocalDocumentSnapshot = CoreLocalSnapshot | LegacyProjectionSnapshot | BenchmarkProjectionSnapshot;

export interface EditorSnapshot {
  /** Stable Canonical Document identity, projected by the Rust/WASM snapshot. */
  documentId: string;
  revision: number;
  /** SHA-256 of the Core semantic state, excluding UI projection and history caches. */
  documentHash?: string;
  memory?: { nodeCount: number; nodeBytes: number; maxDocumentBytes: number; undoItems: number; undoBytes: number; redoItems: number; redoBytes: number; dedupeItems: number; dedupeBytes: number; operationDedupeItems: number; operationDedupeBytes: number };
  resources?: { documentNodes: number; maxDocumentNodes: number; documentBytes: number; maxDocumentBytes: number; wasmHeapBytes: number; maxWasmHeapBytes: number; renderSurfaceBytes: number; maxRenderSurfaceBytes: number; gpuSceneBytes: number; maxGpuSceneBytes: number; gpuEffectTextureBytes: number; maxGpuEffectTextureBytes: number; gpuSceneWithinBudget: boolean };
  /** Ephemeral fixed-fixture evidence. It is emitted to the browser UI only
   * and does not enter document storage, history, hash, or collaboration. */
  benchmark?: {
    kind: "pf02-layout-cascade";
    status: "complete" | "failed";
    nodeCount: number;
    layoutChildren: number;
    transactionMs?: number;
    beforeWasmHeapBytes?: number;
    afterWasmHeapBytes?: number;
    beforeDocumentBytes?: number;
    afterDocumentBytes?: number;
    beforeUndoBytes?: number;
    afterUndoBytes?: number;
    beforeDedupeBytes?: number;
    afterDedupeBytes?: number;
  };
  /** Ephemeral, privacy-safe Engine Worker evidence; it never enters the document snapshot. */
  diagnostics?: { total: number; recent: readonly DiagnosticEvent[] };
  performance?: RenderPerformanceSummary;
  nodes: CanvasNode[];
  assets?: DocumentAsset[];
  textStyles?: DocumentTextStyleResource[];
  paintStyles?: DocumentPaintStyleResource[];
  variableCollections?: DocumentVariableCollectionResource[];
  variables?: DocumentVariableResource[];
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
  /** Correlates a presentation-only hydrate completion with its initiating UI request. */
  hydrationRequestId?: string;
  localSnapshot?: CoreLocalSnapshot;
  localJournalEntry?: LocalJournalEntry;
}

export type EditorCommand =
  /** `positionId` is required for an externally ordered import. User-created
   * pages may omit it and retain the legacy ID-derived placement. */
  | { type: "create-page"; id: string; name: string; positionId?: string }
  | { type: "register-variable-collection"; collection: DocumentVariableCollectionResource }
  | { type: "register-variable"; variable: DocumentVariableResource }
  | { type: "set-variable"; variable: DocumentVariableResource }
  | { type: "delete-variable"; id: string }
  | { type: "set-variable-collection"; collection: DocumentVariableCollectionResource; variables: DocumentVariableResource[] }
  | { type: "delete-variable-collection"; id: string }
  | { type: "select-page"; id: string }
  | { type: "create"; node: CanvasNode }
  | { type: "update"; id: string; patch: Partial<CanvasNode> }
  /** Applies geometry without cascading Constraints to descendants. */
  | { type: "resizeWithoutConstraints"; id: string; patch: Partial<Pick<CanvasNode, "x" | "y" | "width" | "height" | "rotation" | "relativeTransform" | "autoLayout">> }
  /** Resolves a deterministic world-space arrangement into concrete geometry
   * updates in the Engine Worker. The concrete updates—not this convenience
   * intent—are the replayable Core operation. */
  | { type: "arrange"; ids: string[]; operation: "align"; axis: "x" | "y"; mode: "min" | "center" | "max"; reference?: "selectionBounds" | "primaryNode" }
  | { type: "arrange"; ids: string[]; operation: "distribute"; axis: "x" | "y"; mode: "edgeGap" | "centerGap" }
  | { type: "arrange"; ids: string[]; operation: "tidyUp"; axis: "auto" | "x" | "y"; gap: number; anchor: "first" | "selectionBounds" }
  | { type: "moveVectorPoint"; id: string; pointId: string; x: number; y: number }
  | { type: "setVectorSubpathClosed"; id: string; subpathIndex: number; closed: boolean }
  | { type: "insertVectorPoint"; id: string; subpathIndex: number; afterPointId?: string; point: DocumentVectorPath["subpaths"][number]["points"][number] }
  | { type: "splitVectorSegment"; id: string; subpathIndex: number; afterPointId: string; t: number; pointId: string }
  | { type: "connectVectorEndpoints"; id: string; firstSubpathIndex: number; firstPointId: string; secondSubpathIndex: number; secondPointId: string }
  | { type: "setMask"; id: string; enabled: boolean }
  | { type: "deleteVectorPoint"; id: string; pointId: string }
  | { type: "setVectorPointHandles"; id: string; pointId: string; handleIn?: { x: number; y: number }; handleOut?: { x: number; y: number }; pointType: DocumentVectorPath["subpaths"][number]["points"][number]["pointType"] }
  | { type: "reposition"; positionIds: Array<{ id: string; positionId: string }> }
  /** Move selected hierarchy roots under a new parent while preserving world space. */
  | { type: "reparent"; ids: string[]; parentId?: string }
  | { type: "group"; ids: string[]; /** Creates an Auto Layout Frame wrapper instead of a Group. */ autoLayout?: DocumentAutoLayout }
  | { type: "transformGroup"; ids: string[]; id?: string; parentId?: string; pageId?: string; index?: number; modifiers: DocumentTransformModifier[]; patch?: Partial<CanvasNode> }
  /** Resolves selected roots into one live BooleanOperation container. */
  | { type: "boolean"; ids: string[]; operation: DocumentBooleanOperation; id?: string; parentId?: string; pageId?: string; index?: number; patch?: Partial<CanvasNode> }
  /** Atomically creates a non-empty ComponentSet around local Components. */
  | { type: "componentSet"; ids: string[]; id: string; parentId?: string; pageId?: string; index?: number; metadata: DocumentComponentSetMetadata; patch?: Partial<CanvasNode> }
  /** Replaces a live Boolean structure with its current Rust-derived VectorPath. */
  | { type: "flattenBoolean"; id: string; replacementId?: string; parentId?: string; pageId?: string; index?: number }
  /** Replaces one leaf vector-like node with an equivalent editable Vector. */
  | { type: "flattenNode"; id: string; replacementId?: string; vectorPath: DocumentVectorPath; parentId?: string; pageId?: string; index?: number }
  /** Replaces a Vector's paint stroke with the Rust-derived editable fill path. */
  | { type: "outlineStroke"; id: string }
  /** Replaces a Polygon or Star with its current closed editable VectorPath. */
  | { type: "convertParametricToVector"; id: string }
  /** Converts a Figma vector-like shape to TextPath while retaining its ID and
   * exact hierarchy position. The supplied path is already resolved. */
  | { type: "convertToTextPath"; id: string; vectorPath: DocumentVectorPath; metadata: DocumentTextPathMetadata }
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
  | { type: "hydrate"; snapshot: LocalDocumentSnapshot; requestId?: string };

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
  | { type: "pointer"; event: "down" | "move" | "up" | "leave"; x: number; y: number; shiftKey: boolean; altKey: boolean; button: number; readOnly?: true; /** A repeated press selects through a Frame or Group instead of its container. */ drillDown?: true; /** Command/Ctrl-click directly selects the painted nested layer. */ deepSelect?: true; /** Command/Ctrl-resize leaves constrained descendants unchanged. */ ignoreConstraints?: true; /** A repeated press on a selected Vector segment requests an exact Core split. */ splitVectorSegment?: true; /** Unix epoch milliseconds, never Canonical document data. */ occurredAt?: number }
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number; ctrlKey: boolean; /** Unix epoch milliseconds, never Canonical document data. */ occurredAt?: number };

export type MainToWorker =
  | { type: "init"; canvas: OffscreenCanvas; width: number; height: number; dpr: number; documentId?: string; rendererPreference: RendererPreference; simulateGpuLosses: number; simulateGpuLossAfterImage: boolean; simulateGpuFault?: SimulatedGpuFault; /** Development-only full-frame RGBA evidence. */ captureFrameHash?: boolean; /** Development-only document-space pixel probes captured with the full-frame hash. */ captureFrameSamples?: readonly { label: string; x: number; y: number }[] }
  | { type: "resize"; width: number; height: number; dpr: number }
  /** Background editor tabs keep their canonical state live but suspend paint
   * work so duplicate views of a complex document do not contend for CPU. */
  | { type: "visibility"; visible: boolean }
  | { type: "tool"; tool: ToolKind }
  /** Requests a durable Core snapshot after a burst of ephemeral viewport input. */
  | { type: "checkpoint" }
  /** Asks the Engine Worker for the canonical Protobuf snapshot used only to
   * establish/recover the remote document root. */
  | { type: "remote-bootstrap" }
  /** Delivers a server-owned Protobuf snapshot for Rust/WASM validation and
   * reconciliation. It is never decoded into a TypeScript document model. */
  | { type: "remote-hydrate"; snapshot: Uint8Array; requestId?: string }
  /** Applies a server snapshot, then replays every still-valid concrete local
   * pending intent before generating a replacement remote sequence. */
  | { type: "remote-reconcile"; snapshot: Uint8Array; operations: PendingRemoteOperation[] }
  /** Commits an already admitted, document-attached AssetId into the canonical
   * Resource Index and queues its own opaque remote operation. */
  | { type: "register-asset"; transactionId: string; asset: DocumentAsset }
  /** Applies a caller-prevalidated Figma REST plan through one Core transaction.
   * The Worker never receives credentials or Figma URLs on this channel. */
  | { type: "import-figma-rest-plan"; transactionId: string; baseRevision: number; plan: FigmaRestImportPlan }
  /** Binds Asset-Service-admitted Figma image results in a follow-up transaction.
   * It contains immutable Asset metadata only; URL/token/bytes stay outside the
   * Canonical command stream. */
  | { type: "bind-figma-rest-assets"; transactionId: string; baseRevision: number; authorized: FigmaRestAuthorizedAsset[] }
  /** Explicitly ends the two-phase Figma image flow. The Worker restores any
   * source lock deferred for binding and retains the unresolved image metadata. */
  | { type: "cancel-figma-rest-assets"; transactionId: string; baseRevision: number; pending: FigmaRestAssetRequest[] }
  /** Browser-decoded external clipboard data. The Worker validates it again
   * before replacing its fast-path clipboard. */
  | { type: "set-clipboard"; clipboard: EditorClipboard; sourceDocumentId?: string }
  /** Browser-owned bytes may seed a freshly imported image bitmap. They are
   * transient and are never retained in a document snapshot. */
  | { type: "asset-bytes"; assetId: string; mediaType: string; bytes: ArrayBuffer; decodedBitmap?: ImageBitmap }
  /** Explicit Runtime font-load request. It only addresses an Asset Service
   * admitted font; bytes remain transient and are loaded from the existing
   * worker cache or authorized asset endpoint. */
  | { type: "load-font"; assetId: string }
  /** Transient presentation state. The Canvas renderer omits this glyph layer
   * while the DOM editor draws the same text, avoiding the double-rendered
   * visual jump that browsers otherwise introduce on focus. */
  | { type: "editing-text"; nodeId?: string }
  /** Inspector/canvas hover preview for one Auto Layout padding edge. */
  | { type: "auto-layout-padding-hover"; nodeId?: string; side?: AutoLayoutPaddingSide }
  /** Worker-owned Rust layout request used to legalize DOM caret offsets. */
  | { type: "text-caret-layout"; requestId: string; nodeId: string; text: string }
  /** On-demand frozen Runtime export geometry. Live Boolean paths stay out of
   * ordinary snapshots and are returned only for this exact Core revision. */
  | { type: "runtime-export-boolean-paths"; requestId: string; revision: number; nodeIds: string[] }
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
  /** Presentation progress. `sharp` contains current-resolution geometry/text;
   * `settled` also includes the final effects. Hydration can finish earlier. */
  | {
      type: "frame-ready";
      revision: number;
      pageId: string;
      quality: "preview" | "sharp" | "settled";
    }
  /** The requested revision could not be painted as one complete frame. */
  | {
      type: "frame-failed";
      revision: number;
      pageId: string;
      code: "RESOURCE_LIMIT";
      /** Present only when the transferred canvas still contains this frame. */
      retainedRevision?: number;
    }
  | { type: "frame-hash"; revision: number; pageId: string; width: number; height: number; rgbaSha256: string; sceneKey: string; samples?: readonly { label: string; x: number; y: number; rgba: readonly [number, number, number, number] }[] }
  | { type: "remote-bootstrap"; documentId: string; revision: number; snapshot: Uint8Array }
  /** Coarse, data-free stages for a potentially large remote snapshot load. */
  | { type: "remote-load-progress"; stage: "decode" | "project" | "render" | "render-paint" | "render-overlay" | "render-finalize" | "render-nodes"; completed?: number; total?: number }
  /** Requests an authorized destructive replacement of the remote demo root. */
  | { type: "remote-reset"; documentId: string; revision: number; snapshot: Uint8Array }
  /** A committed local Core batch represented as an opaque Protobuf envelope.
   * The main thread must durably append it before attempting network delivery. */
  | { type: "remote-operation"; operation: PendingRemoteOperation }
  /** A complete conflict/rejection reconciliation result. The main thread must
   * atomically replace the listed old queue IDs with these new envelopes before
   * resuming ordered delivery. */
  | { type: "remote-reconciled"; removeOperationIds: string[]; replacements: PendingRemoteOperation[]; discardedOperationIds: string[]; coreRejectedOperationIds: string[]; blockedOperationIds: string[]; rejectionDiagnostics: string[] }
  | { type: "remote-reconciliation-progress"; completed: number; total: number }
  | { type: "text-caret-layout"; requestId: string; nodeId: string; text: string; layout?: RustTextCaretLayout }
  | { type: "runtime-export-boolean-paths-result"; requestId: string; revision: number; paths?: Record<string, DocumentVectorPath>; errorCode?: "REVISION_CONFLICT" | "INVALID_REQUEST" | "RESOURCE_LIMIT" }
  /** Lightweight high-frequency projection update; never contains durable document data. */
  | { type: "view-state"; viewport: Viewport; selectedIds: string[]; activePageId: string; performance: RenderPerformanceSummary; viewportChanged: boolean }
  /** A durable viewport payload deliberately separated from the full Core snapshot. */
  | ViewportCheckpointMessage
  | { type: "ready" }
  /** Worker-confirmed tool state, used for one-shot canvas creation. */
  | { type: "tool"; tool: ToolKind }
  | { type: "ack"; transactionId: string; acceptedRevision?: number; errorCode?: "REVISION_CONFLICT" | "INVALID_TRANSACTION" | "RESOURCE_LIMIT" }
  | { type: "error"; code: EditorErrorCode; safeMessage: string; retryable: boolean; documentRevision: number; diagnosticId: number; transactionId?: string };

/** Generates an RFC 4122 v4 UUID in both secure and plain-HTTP development
 * contexts. `crypto.randomUUID` is preferred; a LAN test URL is not a secure
 * context in every browser, so retain the same UUID format with getRandomValues
 * (and a last-resort non-cryptographic development fallback) instead of
 * preventing the editor Worker from booting. */
const nativeRandomUuid = typeof globalThis.crypto?.randomUUID === "function"
  ? globalThis.crypto.randomUUID.bind(globalThis.crypto)
  : undefined;

export function createId() {
  if (nativeRandomUuid) return nativeRandomUuid();
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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
    polygon: { name: "Polygon", width: 140, height: 140, fill: "#d9f99d", stroke: "#4d7c0f", radius: 0 },
    star: { name: "Star", width: 160, height: 160, fill: "#fde68a", stroke: "#b45309", radius: 0 },
    vector: { name: "Vector", width: 160, height: 120, fill: "#dbeafe", stroke: "#2563eb", radius: 0 },
    booleanOperation: { name: "Boolean", width: 1, height: 1, fill: "transparent", stroke: "transparent", radius: 0 },
    slice: { name: "Slice", width: 320, height: 220, fill: "transparent", stroke: "transparent", radius: 0 },
    line: { name: "Line", width: 160, height: 0, fill: "transparent", stroke: "#0048FF", radius: 0 },
    text: { name: "Text", width: 220, height: 44, fill: "#23251f", stroke: "transparent", radius: 0, text: "Type something" },
    image: { name: "Image", width: 320, height: 220, fill: "#e6edff", stroke: "#0048FF", radius: 10 },
    codeBlock: { name: "Code block", width: 320, height: 180, fill: "#1e293b", stroke: "#475569", radius: 8, text: "// Write code" },
    component: { name: "Component", width: 320, height: 220, fill: "#f8fafc", stroke: "#7c3aed", radius: 10 },
    instance: { name: "Instance", width: 320, height: 220, fill: "#f8fafc", stroke: "#7c3aed", radius: 10 },
    slot: { name: "Slot", width: 160, height: 96, fill: "#f8fafc", stroke: "#7c3aed", radius: 8 },
    componentSet: { name: "Component set", width: 640, height: 320, fill: "#f8fafc", stroke: "#7c3aed", radius: 10 },
    connector: { name: "Connector", width: 160, height: 0, fill: "transparent", stroke: "#475569", radius: 0 },
    embed: { name: "Embed", width: 360, height: 240, fill: "#f8fafc", stroke: "#64748b", radius: 8 },
    highlight: { name: "Highlight", width: 160, height: 20, fill: "#fde047", stroke: "transparent", radius: 4 },
    interactiveSlideElement: { name: "Interactive slide element", width: 360, height: 180, fill: "#e0e7ff", stroke: "#6366f1", radius: 12 },
    linkUnfurl: { name: "Link unfurl", width: 360, height: 180, fill: "#f8fafc", stroke: "#64748b", radius: 12 },
    media: { name: "Media", width: 320, height: 180, fill: "#111827", stroke: "transparent", radius: 8 },
    shapeWithText: { name: "Shape with text", width: 180, height: 120, fill: "#e0e7ff", stroke: "#4f46e5", radius: 12, text: "Text" },
    // Imported-only Figma Slides root. The Plugin API never creates it.
    slideGrid: { name: "Slide grid", width: 1, height: 1, fill: "transparent", stroke: "transparent", radius: 0 },
    slide: { name: "Slide", width: 1920, height: 1080, fill: "#ffffff", stroke: "transparent", radius: 0 },
    slideRow: { name: "Slide row", width: 1, height: 1, fill: "transparent", stroke: "transparent", radius: 0 },
    stamp: { name: "Star", width: 80, height: 80, fill: "#fbbf24", stroke: "transparent", radius: 40 },
    sticky: { name: "Sticky", width: 200, height: 200, fill: "#fef3c7", stroke: "transparent", radius: 2, text: "" },
    table: { name: "Table", width: 400, height: 200, fill: "#ffffff", stroke: "#d1d5db", radius: 0 },
    tableCell: { name: "Table cell", width: 200, height: 100, fill: "#ffffff", stroke: "#d1d5db", radius: 0, text: "" },
    textPath: { name: "Text path", width: 240, height: 100, fill: "#111827", stroke: "transparent", radius: 0, text: "Text on a path" }, transformGroup: { name: "Transform group", width: 100, height: 100, fill: "transparent", stroke: "transparent", radius: 0 }, washiTape: { name: "Washi tape", width: 180, height: 40, fill: "#fef3c7", stroke: "#f59e0b", radius: 2 }, widget: { name: "Widget", width: 240, height: 160, fill: "#ffffff", stroke: "#a78bfa", radius: 12 },
  };
  const preset = presets[kind];
  const parametricShape = kind === "polygon" ? { kind: "polygon" as const, pointCount: 5 } : kind === "star" ? { kind: "star" as const, pointCount: 5, innerRatio: 0.5 } : undefined;
  const vectorPath = kind === "vector" || kind === "highlight" || kind === "textPath" ? { fillRule: "nonZero" as const, subpaths: [{ closed: kind !== "textPath", points: [{ id: createId(), x: 0, y: kind === "textPath" ? 50 : 0, pointType: "corner" as const }, { id: createId(), x: 160, y: kind === "highlight" ? 20 : kind === "textPath" ? 50 : 120, pointType: "corner" as const }, { id: createId(), x: 0, y: kind === "highlight" ? 20 : 120, pointType: "corner" as const }] }] } : undefined;
  const booleanOperation = kind === "booleanOperation" ? "union" as const : undefined;
  const id = createId();
  return { id, kind, x, y, rotation: 0, strokeWidth: kind === "slice" ? 0 : 1, strokeCapStart: "none", strokeCapEnd: "none", strokeJoin: "miter", strokeMiterLimit: 10, strokeDashPattern: [], strokeAlign: "inside", opacity: 1, blendMode: "normal", visible: true, ...preset, codeLanguage: kind === "codeBlock" ? "PLAINTEXT" : undefined, componentMetadata: kind === "component" ? { key: id, remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: {} } : undefined, componentSetMetadata: kind === "componentSet" ? { key: id, remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: {}, variantGroupProperties: {} } : undefined, connectorMetadata: kind === "connector" ? { lineType: "STRAIGHT", start: { x: 0, y: 0, magnet: "AUTO" }, end: { x: preset.width, y: 0, magnet: "AUTO" }, startStrokeCap: "NONE", endStrokeCap: "NONE", text: "" } : undefined, embedMetadata: kind === "embed" ? { srcUrl: "https://example.com", canonicalUrl: null, title: null, provider: null } : undefined, highlightHandleMirroring: kind === "highlight" ? "NONE" : undefined, interactiveSlideElementType: kind === "interactiveSlideElement" ? "POLL" : undefined, linkUnfurlMetadata: kind === "linkUnfurl" ? { url: "https://example.com", title: null, description: null, provider: null } : undefined, mediaMetadata: kind === "media" ? { hash: id } : undefined, shapeWithTextType: kind === "shapeWithText" ? "ROUNDED_RECTANGLE" : undefined, slideMetadata: kind === "slide" ? { isSkippedSlide: false, transition: { style: "NONE", duration: .3, curve: "EASE_IN", timing: { type: "ON_CLICK" } } } : undefined, stickyMetadata: kind === "sticky" ? { authorVisible: true, authorName: "", isWideWidth: false } : undefined, textPathMetadata: kind === "textPath" ? { startSegment: 0, startPosition: 0, autoRename: true, textAlignHorizontal: "LEFT", textAlignVertical: "TOP" } : undefined, widgetMetadata: kind === "widget" ? { widgetId: id, syncedState: {}, syncedMap: {} } : undefined, parametricShape, vectorPath, booleanOperation, fillColor: documentColorFromCssHex(preset.fill) };
}
