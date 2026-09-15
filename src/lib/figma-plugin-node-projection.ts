import type { CanvasNode, DocumentConstraints, EllipseArcData, NodeKind, RelativeTransform } from "./editor-protocol";
import { colorToSrgbComponents } from "./color-rendering";
import { runtimeTextCase } from "./text-case";
import { IDENTITY_AFFINE, invertAffine, multiplyAffine, worldBoundsForNode, worldTransformForNode } from "./scene-transform";
import { clipsChildren, nodeCapabilities } from "./node-capabilities";
import { effectiveConstraints } from "./constraint-selection";
import { effectiveNodeBlendMode } from "./node-blend-semantics";
import { isFigmaConnectorStrokeCap, projectFigmaConnectorEndpoint, type FigmaConnectorEndpoint, type FigmaConnectorStrokeCap } from "./connector-endpoint";

/** The subset of Figma Plugin API SceneNode types represented by the Canonical
 * document. `image` deliberately does not appear here: Figma Plugin API
 * models ordinary images as paints, not as an IMAGE SceneNode. */
export const FIGMA_PLUGIN_NODE_TYPES = [
  "BOOLEAN_OPERATION", "CODE_BLOCK", "COMPONENT", "COMPONENT_SET", "CONNECTOR", "ELLIPSE", "EMBED", "FRAME", "GROUP", "HIGHLIGHT", "INSTANCE", "INTERACTIVE_SLIDE_ELEMENT", "LINE", "LINK_UNFURL", "MEDIA", "POLYGON", "SHAPE_WITH_TEXT", "SLOT",
  "RECTANGLE", "SECTION", "SLICE", "SLIDE", "SLIDE_GRID", "SLIDE_ROW", "STAMP", "STAR", "STICKY", "TABLE", "TABLE_CELL", "TEXT", "TEXT_PATH", "TRANSFORM_GROUP", "VECTOR", "WASHI_TAPE", "WIDGET",
] as const;

export type FigmaPluginNodeType = (typeof FIGMA_PLUGIN_NODE_TYPES)[number];
export type FigmaPluginTransform = [[number, number, number], [number, number, number]];
export type FigmaPluginArcData = Readonly<{ startingAngle: number; endingAngle: number; innerRadius: number }>;
export type FigmaPluginTextSublayerProjection = Readonly<{
  characters: string;
  fontSize: number;
  fontWeight: number;
  letterSpacing: Readonly<{ value: number; unit: "PIXELS" }>;
  textAlignHorizontal: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
  lineHeight:
    | Readonly<{ value: number; unit: "PIXELS" | "PERCENT" }>
    | Readonly<{ unit: "AUTO" }>;
  paragraphSpacing: number;
  paragraphIndent: number;
  textWrapStyle: "AUTO" | "BALANCE" | "PRETTY";
  listSpacing: number;
  hangingList: boolean;
  hangingPunctuation: boolean;
  textCase: ReturnType<typeof runtimeTextCase>;
  hyperlink: Readonly<{ type: "URL" | "NODE"; value: string }> | null;
  textDecoration: "NONE" | "UNDERLINE" | "STRIKETHROUGH";
  textDecorationStyle: "SOLID" | "WAVY" | "DOTTED" | null;
  textDecorationOffset:
    | Readonly<{ value: number; unit: "PIXELS" | "PERCENT" }>
    | Readonly<{ unit: "AUTO" }>
    | null;
  textDecorationThickness:
    | Readonly<{ value: number; unit: "PIXELS" | "PERCENT" }>
    | Readonly<{ unit: "AUTO" }>
    | null;
  textDecorationColor:
    | Readonly<{ value: "AUTO" }>
    | Readonly<{ value: Readonly<{
        type: "SOLID";
        color: Readonly<{ r: number; g: number; b: number }>;
        visible: boolean;
        opacity: number;
        blendMode: Exclude<FigmaPluginBlendMode, "PASS_THROUGH">;
      }> }>
    | null;
  textDecorationSkipInk: boolean | null;
  leadingTrim: "CAP_HEIGHT" | "NONE";
}>;
export type FigmaPluginBlendMode = "PASS_THROUGH" | "NORMAL" | "MULTIPLY" | "SCREEN" | "OVERLAY" | "DARKEN" | "LIGHTEN" | "COLOR_DODGE" | "COLOR_BURN" | "HARD_LIGHT" | "SOFT_LIGHT" | "DIFFERENCE" | "EXCLUSION" | "HUE" | "SATURATION" | "COLOR" | "LUMINOSITY" | "LINEAR_BURN" | "LINEAR_DODGE";
export type FigmaPluginConstraints = Readonly<{ horizontal: "MIN" | "CENTER" | "MAX" | "STRETCH" | "SCALE"; vertical: "MIN" | "CENTER" | "MAX" | "STRETCH" | "SCALE" }>;
const CONSTRAINT_UNSUPPORTED_KINDS = new Set<CanvasNode["kind"]>(["group", "booleanOperation", "section", "slide"]);

/**
 * Read-only Plugin API-shaped spatial projection. It intentionally contains
 * only fields that the Canonical model can represent without a lossy
 * approximation; unsupported Plugin API mixins (components, variables,
 * styles, full paints, etc.) stay outside this projection.
 */
export type FigmaPluginNodeProjection = Readonly<{
  id: string;
  type: FigmaPluginNodeType;
  name: string;
  visible: boolean;
  locked: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  relativeTransform: FigmaPluginTransform;
  absoluteTransform: FigmaPluginTransform;
  absoluteBoundingBox: { x: number; y: number; width: number; height: number };
  constraints?: FigmaPluginConstraints;
  opacity?: number;
  blendMode?: FigmaPluginBlendMode;
  isMask?: boolean;
  maskType?: "ALPHA";
  clipsContent?: boolean;
  sectionContentsHidden?: boolean;
  cornerRadius?: number;
  cornerSmoothing?: number;
  topLeftRadius?: number;
  topRightRadius?: number;
  bottomRightRadius?: number;
  bottomLeftRadius?: number;
  arcData?: FigmaPluginArcData;
  pointCount?: number;
  innerRadius?: number;
  booleanOperation?: "UNION" | "INTERSECT" | "SUBTRACT" | "EXCLUDE";
  characters?: string;
  code?: string;
  codeLanguage?: string;
  description?: string;
  descriptionMarkdown?: string;
  documentationLinks?: ReadonlyArray<{ uri: string; name?: string }>;
  key?: string;
  remote?: boolean;
  componentPropertyDefinitions?: Readonly<Record<string, unknown>>;
  mainComponentId?: string;
  scaleFactor?: number;
  componentProperties?: Readonly<Record<string, string | boolean>>;
  overrides?: ReadonlyArray<{ id: string; overriddenFields: string[] }>;
  isExposedInstance?: boolean;
  slotPropertyName?: string;
  defaultVariantId?: string;
  variantGroupProperties?: Readonly<Record<string, { values: string[] }>>;
  connectorLineType?: "ELBOWED" | "STRAIGHT" | "CURVED";
  connectorStart?: FigmaConnectorEndpoint;
  connectorEnd?: FigmaConnectorEndpoint;
  connectorStartStrokeCap?: FigmaConnectorStrokeCap;
  connectorEndStrokeCap?: FigmaConnectorStrokeCap;
  connectorText?: string;
  embedData?: Readonly<{ srcUrl: string; canonicalUrl: string | null; title: string | null; provider: string | null }>;
  vectorPaths?: unknown;
  handleMirroring?: "NONE" | "ANGLE" | "ANGLE_AND_LENGTH";
  interactiveSlideElementType?: "POLL" | "EMBED" | "FACEPILE" | "ALIGNMENT" | "YOUTUBE";
  linkUnfurlData?: Readonly<{ url: string; title: string | null; description: string | null; provider: string | null }>;
  mediaData?: Readonly<{ hash: string }>;
  shapeType?: import("./editor-protocol").ShapeWithTextType;
  textSublayer?: FigmaPluginTextSublayerProjection;
  isSkippedSlide?: boolean;
  slideTransition?: NonNullable<CanvasNode["slideMetadata"]>["transition"];
  authorVisible?: boolean;
  authorName?: string;
  isWideWidth?: boolean;
  stickyTextSublayer?: Readonly<{ characters: string }>;
  numRows?: number;
  numColumns?: number;
  rowIndex?: number;
  columnIndex?: number;
  tableCellTextSublayer?: Readonly<{ characters: string }>;
  textPathStartData?: Readonly<{ segment: number; position: number }>;
  hasMissingFont?: boolean;
  textAlignHorizontal?: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
  textAlignVertical?: "TOP" | "CENTER" | "BOTTOM";
  autoRename?: boolean;
  transformModifiers?: import("./editor-protocol").DocumentTransformModifier[];
  widgetId?: string;
  widgetSyncedState?: Record<string, unknown>;
}>;

const TYPE_BY_KIND: Record<Exclude<NodeKind, "image">, FigmaPluginNodeType> = {
  booleanOperation: "BOOLEAN_OPERATION",
  codeBlock: "CODE_BLOCK",
  component: "COMPONENT",
  componentSet: "COMPONENT_SET",
  connector: "CONNECTOR",
  embed: "EMBED",
  highlight: "HIGHLIGHT",
  interactiveSlideElement: "INTERACTIVE_SLIDE_ELEMENT",
  linkUnfurl: "LINK_UNFURL",
  media: "MEDIA",
  shapeWithText: "SHAPE_WITH_TEXT",
  slideGrid: "SLIDE_GRID",
  slide: "SLIDE",
  slideRow: "SLIDE_ROW",
  stamp: "STAMP",
  sticky: "STICKY",
  table: "TABLE",
  tableCell: "TABLE_CELL",
  textPath: "TEXT_PATH",
  transformGroup: "TRANSFORM_GROUP",
  washiTape: "WASHI_TAPE",
  widget: "WIDGET",
  instance: "INSTANCE",
  slot: "SLOT",
  ellipse: "ELLIPSE",
  frame: "FRAME",
  group: "GROUP",
  line: "LINE",
  polygon: "POLYGON",
  rectangle: "RECTANGLE",
  section: "SECTION",
  slice: "SLICE",
  star: "STAR",
  text: "TEXT",
  vector: "VECTOR",
};

const BLEND_BY_CANONICAL: Record<NonNullable<CanvasNode["blendMode"]>, FigmaPluginBlendMode> = {
  normal: "NORMAL",
  multiply: "MULTIPLY",
  screen: "SCREEN",
  overlay: "OVERLAY",
  darken: "DARKEN",
  lighten: "LIGHTEN",
  "color-dodge": "COLOR_DODGE",
  "color-burn": "COLOR_BURN",
  "hard-light": "HARD_LIGHT",
  "soft-light": "SOFT_LIGHT",
  difference: "DIFFERENCE",
  exclusion: "EXCLUSION",
  hue: "HUE",
  saturation: "SATURATION",
  color: "COLOR",
  luminosity: "LUMINOSITY",
  "pass-through": "PASS_THROUGH",
  "linear-burn": "LINEAR_BURN",
  "linear-dodge": "LINEAR_DODGE",
};

const CONSTRAINT_BY_CANONICAL: Record<DocumentConstraints["horizontal"], FigmaPluginConstraints["horizontal"]> = {
  min: "MIN",
  center: "CENTER",
  max: "MAX",
  stretch: "STRETCH",
  scale: "SCALE",
};

/** Maps a Canonical kind to the corresponding Figma Plugin API SceneNode type. */
export function figmaPluginNodeType(kind: NodeKind): FigmaPluginNodeType | undefined {
  return kind === "image" ? undefined : TYPE_BY_KIND[kind];
}

/** Figma's Transform is [[a, c, e], [b, d, f]] while Canonical stores named coefficients. */
export function toFigmaPluginTransform(transform: RelativeTransform): FigmaPluginTransform {
  return [[transform.a, transform.c, transform.e], [transform.b, transform.d, transform.f]];
}

/** Reject malformed or singular external transforms instead of silently
 * projecting them into a different geometry. */
export function fromFigmaPluginTransform(transform: unknown): RelativeTransform | undefined {
  if (!Array.isArray(transform) || transform.length !== 2 || !Array.isArray(transform[0]) || !Array.isArray(transform[1]) || transform[0].length !== 3 || transform[1].length !== 3) return undefined;
  const [first, second] = transform;
  if (![...first, ...second].every((value) => typeof value === "number" && Number.isFinite(value))) return undefined;
  const next = { a: first[0]!, b: second[0]!, c: first[1]!, d: second[1]!, e: first[2]!, f: second[2]! };
  return Math.abs(next.a * next.d - next.b * next.c) > 1e-12 ? next : undefined;
}

/** The Plugin API uses radians; Canonical uses degrees for Canvas and Inspector consistency. */
export function toFigmaPluginArcData(arc: EllipseArcData): FigmaPluginArcData {
  return { startingAngle: arc.startingAngle * Math.PI / 180, endingAngle: arc.endingAngle * Math.PI / 180, innerRadius: arc.innerRadius };
}

/** Converts a Plugin API ArcData input without excluding the valid `innerRadius: 0` arc case. */
export function fromFigmaPluginArcData(arc: unknown): EllipseArcData | undefined {
  if (!arc || typeof arc !== "object") return undefined;
  const value = arc as Record<string, unknown>;
  const startingAngle = value.startingAngle;
  const endingAngle = value.endingAngle;
  const innerRadius = value.innerRadius;
  if (![startingAngle, endingAngle, innerRadius].every((entry) => typeof entry === "number" && Number.isFinite(entry)) || (innerRadius as number) < 0 || (innerRadius as number) > 1) return undefined;
  return { startingAngle: (startingAngle as number) * 180 / Math.PI, endingAngle: (endingAngle as number) * 180 / Math.PI, innerRadius: innerRadius as number };
}

/**
 * Mirrors the Plugin API rule that a child of Group/BooleanOperation reports a
 * transform relative to its containing Frame (or page), rather than its
 * immediate structural parent. The Canonical tree keeps immediate parent IDs
 * because they are needed for stable hierarchy and rendering.
 */
export function figmaPluginRelativeTransform(nodes: readonly CanvasNode[], node: CanvasNode): FigmaPluginTransform | undefined {
  const world = worldTransformForNode(nodes, node.id);
  if (!world) return undefined;
  const container = containingFrame(nodes, node);
  const containerWorld = container ? worldTransformForNode(nodes, container.id) : IDENTITY_AFFINE;
  if (!containerWorld) return undefined;
  const inverse = invertAffine(containerWorld);
  if (!inverse) return undefined;
  return toFigmaPluginTransform(multiplyAffine(inverse, world));
}

/** Returns a no-loss spatial/structural view for one of the supported twelve nodes. */
export function projectFigmaPluginNode(nodes: readonly CanvasNode[], node: CanvasNode): FigmaPluginNodeProjection | undefined {
  const type = figmaPluginNodeType(node.kind);
  const relativeTransform = type && figmaPluginRelativeTransform(nodes, node);
  const absolute = worldTransformForNode(nodes, node.id);
  const bounds = worldBoundsForNode(nodes, node);
  if (!type || !relativeTransform || !absolute || !bounds) return undefined;
  const local = fromFigmaPluginTransform(relativeTransform)!;
  const projection: {
    id: string;
    type: FigmaPluginNodeType;
    name: string;
    visible: boolean;
    locked: boolean;
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
    relativeTransform: FigmaPluginTransform;
    absoluteTransform: FigmaPluginTransform;
    absoluteBoundingBox: { x: number; y: number; width: number; height: number };
    constraints?: FigmaPluginConstraints;
    opacity?: number;
    blendMode?: FigmaPluginBlendMode;
    isMask?: boolean;
    maskType?: "ALPHA";
    clipsContent?: boolean;
    sectionContentsHidden?: boolean;
    cornerRadius?: number;
    cornerSmoothing?: number;
    topLeftRadius?: number;
    topRightRadius?: number;
    bottomRightRadius?: number;
    bottomLeftRadius?: number;
    arcData?: FigmaPluginArcData;
    pointCount?: number;
    innerRadius?: number;
    booleanOperation?: "UNION" | "INTERSECT" | "SUBTRACT" | "EXCLUDE";
    characters?: string;
    code?: string;
    codeLanguage?: string;
    description?: string;
    descriptionMarkdown?: string;
    documentationLinks?: ReadonlyArray<{ uri: string; name?: string }>;
    key?: string;
    remote?: boolean;
    componentPropertyDefinitions?: Readonly<Record<string, unknown>>;
    mainComponentId?: string;
    scaleFactor?: number;
    componentProperties?: Readonly<Record<string, string | boolean>>;
    overrides?: ReadonlyArray<{ id: string; overriddenFields: string[] }>;
    isExposedInstance?: boolean;
    slotPropertyName?: string;
    defaultVariantId?: string;
    variantGroupProperties?: Readonly<Record<string, { values: string[] }>>;
    connectorLineType?: "ELBOWED" | "STRAIGHT" | "CURVED";
    connectorStart?: FigmaConnectorEndpoint; connectorEnd?: FigmaConnectorEndpoint; connectorStartStrokeCap?: FigmaConnectorStrokeCap; connectorEndStrokeCap?: FigmaConnectorStrokeCap; connectorText?: string;
    embedData?: Readonly<{ srcUrl: string; canonicalUrl: string | null; title: string | null; provider: string | null }>;
    vectorPaths?: unknown;
    handleMirroring?: "NONE" | "ANGLE" | "ANGLE_AND_LENGTH";
    interactiveSlideElementType?: "POLL" | "EMBED" | "FACEPILE" | "ALIGNMENT" | "YOUTUBE";
    linkUnfurlData?: Readonly<{ url: string; title: string | null; description: string | null; provider: string | null }>;
    mediaData?: Readonly<{ hash: string }>;
    shapeType?: import("./editor-protocol").ShapeWithTextType;
    textSublayer?: FigmaPluginTextSublayerProjection;
    isSkippedSlide?: boolean;
    slideTransition?: NonNullable<CanvasNode["slideMetadata"]>["transition"];
    authorVisible?: boolean;
    authorName?: string;
    isWideWidth?: boolean;
    stickyTextSublayer?: Readonly<{ characters: string }>;
    numRows?: number; numColumns?: number; rowIndex?: number; columnIndex?: number; tableCellTextSublayer?: Readonly<{ characters: string }>;
    textPathStartData?: Readonly<{ segment: number; position: number }>; hasMissingFont?: boolean; textAlignHorizontal?: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED"; textAlignVertical?: "TOP" | "CENTER" | "BOTTOM"; autoRename?: boolean;
    transformModifiers?: import("./editor-protocol").DocumentTransformModifier[]; widgetId?: string; widgetSyncedState?: Record<string, unknown>;
  } = {
    id: node.id,
    type,
    name: node.name,
    visible: node.visible !== false,
    locked: Boolean(node.locked),
    x: local.e,
    y: local.f,
    width: node.width,
    height: node.height,
    rotation: Math.atan2(local.b, local.a) * 180 / Math.PI,
    relativeTransform,
    absoluteTransform: toFigmaPluginTransform(absolute),
    absoluteBoundingBox: { x: bounds.left, y: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top },
  };

  if (!CONSTRAINT_UNSUPPORTED_KINDS.has(node.kind)) {
    const constraints = effectiveConstraints(node);
    projection.constraints = { horizontal: CONSTRAINT_BY_CANONICAL[constraints.horizontal], vertical: CONSTRAINT_BY_CANONICAL[constraints.vertical] };
  }
  if (node.kind !== "slice") {
    projection.opacity = node.opacity;
    projection.blendMode = BLEND_BY_CANONICAL[effectiveNodeBlendMode(node)];
  }
  if (nodeCapabilities(node.kind).maskEligible) {
    projection.isMask = Boolean(node.isMask);
    projection.maskType = "ALPHA";
  }
  if (clipsChildren(node.kind)) projection.clipsContent = node.clipsContent !== false;
  if (node.kind === "section") projection.sectionContentsHidden = Boolean(node.contentsHidden);
  if (["frame", "component", "componentSet", "instance", "slot", "rectangle", "section"].includes(node.kind)) {
    const radii = node.cornerRadii ?? [node.radius, node.radius, node.radius, node.radius];
    projection.cornerRadius = node.radius;
    projection.cornerSmoothing = node.cornerSmoothing ?? 0;
    [projection.topLeftRadius, projection.topRightRadius, projection.bottomRightRadius, projection.bottomLeftRadius] = radii;
  }
  if (node.kind === "ellipse" && node.arcData) projection.arcData = toFigmaPluginArcData(node.arcData);
  if (node.kind === "polygon" && node.parametricShape?.kind === "polygon") projection.pointCount = node.parametricShape.pointCount;
  if (node.kind === "star" && node.parametricShape?.kind === "star") {
    projection.pointCount = node.parametricShape.pointCount;
    projection.innerRadius = node.parametricShape.innerRatio;
  }
  if (node.kind === "booleanOperation" && node.booleanOperation) projection.booleanOperation = node.booleanOperation.toUpperCase() as FigmaPluginNodeProjection["booleanOperation"];
  if (node.kind === "text") projection.characters = node.text ?? "";
  if (node.kind === "codeBlock") { projection.code = node.text ?? ""; projection.codeLanguage = node.codeLanguage ?? "PLAINTEXT"; }
  if (node.kind === "component") {
    const metadata = node.componentMetadata ?? { key: node.id, remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: {} };
    projection.description = metadata.description;
    projection.descriptionMarkdown = metadata.descriptionMarkdown;
    projection.documentationLinks = metadata.documentationLinks;
    projection.key = metadata.key;
    projection.remote = metadata.remote;
    projection.componentPropertyDefinitions = metadata.componentPropertyDefinitions;
    projection.clipsContent = node.clipsContent !== false;
  }
  if (node.kind === "componentSet") {
    const metadata = node.componentSetMetadata ?? { key: node.id, remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], variantGroupProperties: {} };
    projection.description = metadata.description; projection.descriptionMarkdown = metadata.descriptionMarkdown; projection.documentationLinks = metadata.documentationLinks;
    projection.key = metadata.key; projection.remote = metadata.remote; projection.variantGroupProperties = metadata.variantGroupProperties;
    projection.defaultVariantId = defaultVariantId(nodes, node.id);
  }
  if (node.kind === "instance" && node.instanceMetadata) {
    projection.mainComponentId = node.instanceMetadata.mainComponentId;
    projection.scaleFactor = node.instanceMetadata.scaleFactor;
    projection.componentProperties = node.instanceMetadata.componentProperties;
    projection.overrides = node.instanceMetadata.overrides;
    projection.isExposedInstance = node.instanceMetadata.isExposedInstance;
  }
  if (node.kind === "slot" && node.slotMetadata) projection.slotPropertyName = node.slotMetadata.propertyName;
  if (node.kind === "connector" && node.connectorMetadata) {
    projection.connectorLineType = node.connectorMetadata.lineType;
    projection.connectorStart = projectFigmaConnectorEndpoint(node.connectorMetadata.start);
    projection.connectorEnd = projectFigmaConnectorEndpoint(node.connectorMetadata.end);
    projection.connectorStartStrokeCap = isFigmaConnectorStrokeCap(node.connectorMetadata.startStrokeCap) ? node.connectorMetadata.startStrokeCap : "NONE";
    projection.connectorEndStrokeCap = isFigmaConnectorStrokeCap(node.connectorMetadata.endStrokeCap) ? node.connectorMetadata.endStrokeCap : "NONE";
    projection.connectorText = node.connectorMetadata.text;
    if (node.connectorMetadata.cornerRadius !== undefined) projection.cornerRadius = node.connectorMetadata.cornerRadius;
  }
  if (node.kind === "embed" && node.embedMetadata) projection.embedData = node.embedMetadata;
  if (node.kind === "highlight") { projection.vectorPaths = node.vectorPath; projection.handleMirroring = node.highlightHandleMirroring ?? "NONE"; }
  if (node.kind === "interactiveSlideElement" && node.interactiveSlideElementType) projection.interactiveSlideElementType = node.interactiveSlideElementType;
  if (node.kind === "linkUnfurl" && node.linkUnfurlMetadata) projection.linkUnfurlData = node.linkUnfurlMetadata;
  if (node.kind === "media" && node.mediaMetadata) projection.mediaData = node.mediaMetadata;
  if (node.kind === "shapeWithText" && node.shapeWithTextType) {
    const primary = node.textProperties?.runs[0]
      ?? (node.text ? undefined : node.textProperties?.baseStyle);
    const paragraph = node.textProperties?.paragraph;
    projection.shapeType = node.shapeWithTextType;
    projection.textSublayer = {
      characters: node.text ?? "",
      fontSize: primary?.fontSize ?? 14,
      fontWeight: primary?.fontWeight ?? 400,
      letterSpacing: { value: primary?.letterSpacing ?? 0, unit: "PIXELS" },
      textAlignHorizontal: paragraph?.alignment === "center" ? "CENTER" : paragraph?.alignment === "right" ? "RIGHT" : paragraph?.alignment === "justify" ? "JUSTIFIED" : "LEFT",
      lineHeight: paragraph?.lineHeightUnit === "auto"
        ? { unit: "AUTO" }
        : paragraph?.lineHeightUnit === "percent"
          ? { value: paragraph.lineHeight ?? 100, unit: "PERCENT" }
          : { value: paragraph?.lineHeight ?? 20, unit: "PIXELS" },
      paragraphSpacing: paragraph?.paragraphSpacing ?? 0,
      paragraphIndent: paragraph?.paragraphIndent ?? 0,
      textWrapStyle: paragraph?.textWrapStyle === "balance"
        ? "BALANCE"
        : paragraph?.textWrapStyle === "pretty" ? "PRETTY" : "AUTO",
      listSpacing: paragraph?.listSpacing ?? 0,
      hangingList: paragraph?.hangingList ?? false,
      hangingPunctuation: paragraph?.hangingPunctuation ?? false,
      textCase: runtimeTextCase(primary?.textCase),
      hyperlink: primary?.hyperlink ? structuredClone(primary.hyperlink) : null,
      textDecoration: primary?.textDecoration === "underline" ? "UNDERLINE" : primary?.textDecoration === "strikethrough" ? "STRIKETHROUGH" : "NONE",
      textDecorationStyle: primary?.textDecoration !== "underline"
        ? null
        : primary.textDecorationStyle === "wavy"
          ? "WAVY"
          : primary.textDecorationStyle === "dotted" ? "DOTTED" : "SOLID",
      textDecorationOffset: primary?.textDecoration !== "underline"
        ? null
        : primary.textDecorationOffset
          ? { value: primary.textDecorationOffset.value, unit: primary.textDecorationOffset.unit === "pixels" ? "PIXELS" : "PERCENT" }
          : { unit: "AUTO" },
      textDecorationThickness: primary?.textDecoration !== "underline"
        ? null
        : primary.textDecorationThickness
          ? { value: primary.textDecorationThickness.value, unit: primary.textDecorationThickness.unit === "pixels" ? "PIXELS" : "PERCENT" }
          : { unit: "AUTO" },
      textDecorationColor: primary?.textDecoration !== "underline"
        ? null
        : primary.textDecorationColor
          ? {
              value: {
                type: "SOLID",
                color: (() => {
                  const [r, g, b] = colorToSrgbComponents(primary.textDecorationColor!.color);
                  return { r, g, b };
                })(),
                visible: primary.textDecorationColor.visible,
                opacity: primary.textDecorationColor.opacity,
                blendMode: BLEND_BY_CANONICAL[primary.textDecorationColor.blendMode] as Exclude<FigmaPluginBlendMode, "PASS_THROUGH">,
              },
            }
          : { value: "AUTO" },
      textDecorationSkipInk: primary?.textDecoration !== "underline"
        ? null
        : primary.textDecorationSkipInk === true,
      leadingTrim: primary?.leadingTrim === "capHeight" ? "CAP_HEIGHT" : "NONE",
    };
    projection.cornerRadius = node.radius;
  }
  if (node.kind === "slide" && node.slideMetadata) { projection.isSkippedSlide = node.slideMetadata.isSkippedSlide; projection.slideTransition = node.slideMetadata.transition; }
  if (node.kind === "sticky") { const metadata = node.stickyMetadata ?? { authorVisible: true, authorName: "", isWideWidth: false }; projection.authorVisible = metadata.authorVisible; projection.authorName = metadata.authorName; projection.isWideWidth = metadata.isWideWidth; projection.stickyTextSublayer = { characters: node.text ?? "" }; }
  if (node.kind === "textPath") { const metadata = node.textPathMetadata ?? { startSegment: 0, startPosition: 0, autoRename: true, textAlignHorizontal: "LEFT" as const, textAlignVertical: "TOP" as const }; projection.characters = node.text ?? ""; projection.vectorPaths = node.vectorPath; projection.textPathStartData = { segment: metadata.startSegment, position: metadata.startPosition }; projection.hasMissingFont = false; projection.textAlignHorizontal = metadata.textAlignHorizontal; projection.textAlignVertical = metadata.textAlignVertical; projection.autoRename = metadata.autoRename; }
  if (node.kind === "transformGroup") projection.transformModifiers = node.transformModifiers ?? [];
  if (node.kind === "widget" && node.widgetMetadata) { projection.widgetId = node.widgetMetadata.widgetId; projection.widgetSyncedState = structuredClone(node.widgetMetadata.syncedState); }
  if (node.kind === "table") { const metadata = node.tableMetadata ?? { rowHeights: [], columnWidths: [] }; projection.numRows = metadata.rowHeights.length; projection.numColumns = metadata.columnWidths.length; }
  if (node.kind === "tableCell" && node.tableCellMetadata) { projection.rowIndex = node.tableCellMetadata.rowIndex; projection.columnIndex = node.tableCellMetadata.columnIndex; projection.tableCellTextSublayer = { characters: node.text ?? "" }; }
  return projection;
}

function defaultVariantId(nodes: readonly CanvasNode[], componentSetId: string) {
  return nodes.filter((node) => node.parentId === componentSetId && node.kind === "component")
    .sort((left, right) => left.y - right.y || left.x - right.x || left.id.localeCompare(right.id))[0]?.id;
}

function containingFrame(nodes: readonly CanvasNode[], node: CanvasNode): CanvasNode | undefined {
  const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]));
  const visited = new Set<string>();
  let parentId = node.parentId;
  while (parentId) {
    if (visited.has(parentId)) return undefined;
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) return undefined;
    if (["frame", "component", "instance", "slot"].includes(parent.kind)) return parent;
    parentId = parent.parentId;
  }
  return undefined;
}
