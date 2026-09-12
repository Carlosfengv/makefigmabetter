import { createNode, type CanvasNode, type DocumentBooleanOperation, type DocumentConnectorMetadata, type DocumentConstraints, type DocumentSlideMetadata, type DocumentStickyMetadata, type DocumentTableMetadata, type DocumentTextPathMetadata, type DocumentTransformModifier, type DocumentVectorPath, type EditorCommand, type ShapeWithTextType } from "./editor-protocol";
import { fromFigmaPluginArcData, type FigmaPluginArcData, type FigmaPluginBlendMode, type FigmaPluginConstraints } from "./figma-plugin-node-projection";

/**
 * The writable subset of the Figma Plugin API that Canonical can represent
 * without a lossy conversion. Spatial observations (`x`, `y`, width, height,
 * `relativeTransform`, and `absoluteTransform`) deliberately are not included:
 * Figma exposes those as read-only values and changes size through `resize`.
 */
export type FigmaPluginNodeWrite = Readonly<{
  name?: string;
  visible?: boolean;
  locked?: boolean;
  opacity?: number;
  blendMode?: FigmaPluginBlendMode;
  rotation?: number;
  constraints?: FigmaPluginConstraints;
  isMask?: boolean;
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
  documentationLinks?: Array<{ uri: string; name?: string }>;
  connectorLineType?: DocumentConnectorMetadata["lineType"];
  connectorStart?: DocumentConnectorMetadata["start"];
  connectorEnd?: DocumentConnectorMetadata["end"];
  connectorStartStrokeCap?: string;
  connectorEndStrokeCap?: string;
  handleMirroring?: "NONE" | "ANGLE" | "ANGLE_AND_LENGTH";
  shapeType?: ShapeWithTextType;
  isSkippedSlide?: boolean;
  stickyText?: string;
  authorVisible?: boolean;
  isWideWidth?: boolean;
  textPathStartData?: { segment: number; position: number };
  textAlignHorizontal?: DocumentTextPathMetadata["textAlignHorizontal"];
  textAlignVertical?: DocumentTextPathMetadata["textAlignVertical"];
  autoRename?: boolean;
  transformModifiers?: DocumentTransformModifier[];
  widgetSyncedState?: Record<string, unknown>;
  widgetSyncedMap?: Record<string, Record<string, unknown>>;
}>;

export type FigmaPluginMutationResult =
  | Readonly<{ ok: true; commands: EditorCommand[] }>
  | Readonly<{ ok: false; reason: string }>;

export type FigmaPluginInstanceCreationResult =
  | Readonly<{ ok: true; instanceId: string; commands: EditorCommand[] }>
  | Readonly<{ ok: false; reason: string }>;
export type FigmaPluginSlotCreationResult =
  | Readonly<{ ok: true; slotId: string; commands: EditorCommand[] }>
  | Readonly<{ ok: false; reason: string }>;
export type FigmaPluginEmbedCreationResult =
  | Readonly<{ ok: true; embedId: string; commands: EditorCommand[] }>
  | Readonly<{ ok: false; reason: string }>;
export type FigmaPluginLinkUnfurlCreationResult =
  | Readonly<{ ok: true; linkUnfurlId: string; commands: EditorCommand[] }>
  | Readonly<{ ok: false; reason: string }>;
export type FigmaPluginMediaCreationResult =
  | Readonly<{ ok: true; mediaId: string; commands: EditorCommand[] }>
  | Readonly<{ ok: false; reason: string }>;
export type FigmaPluginShapeWithTextCreationResult =
  | Readonly<{ ok: true; shapeWithTextId: string; commands: EditorCommand[] }>
  | Readonly<{ ok: false; reason: string }>;
export type FigmaPluginSlideRowCreationResult =
  | Readonly<{ ok: true; slideRowId: string; commands: EditorCommand[] }>
  | Readonly<{ ok: false; reason: string }>;
export type FigmaPluginSlideCreationResult =
  | Readonly<{ ok: true; slideId: string; commands: EditorCommand[] }>
  | Readonly<{ ok: false; reason: string }>;
export type FigmaPluginStickyCreationResult =
  | Readonly<{ ok: true; stickyId: string; commands: EditorCommand[] }>
  | Readonly<{ ok: false; reason: string }>;
export type FigmaPluginTableCreationResult =
  | Readonly<{ ok: true; tableId: string; commands: EditorCommand[] }>
  | Readonly<{ ok: false; reason: string }>;
export type FigmaPluginTextPathCreationResult =
  | Readonly<{ ok: true; textPathId: string; commands: EditorCommand[] }>
  | Readonly<{ ok: false; reason: string }>;
export type FigmaPluginTransformGroupCreationResult =
  | Readonly<{ ok: true; transformGroupId: string; commands: EditorCommand[] }>
  | Readonly<{ ok: false; reason: string }>;

const BLEND_TO_CANONICAL: Partial<Record<FigmaPluginBlendMode, NonNullable<CanvasNode["blendMode"]>>> = {
  NORMAL: "normal",
  MULTIPLY: "multiply",
  SCREEN: "screen",
  OVERLAY: "overlay",
  DARKEN: "darken",
  LIGHTEN: "lighten",
};

const CONSTRAINT_TO_CANONICAL: Record<FigmaPluginConstraints["horizontal"], DocumentConstraints["horizontal"]> = {
  MIN: "min",
  CENTER: "center",
  MAX: "max",
  STRETCH: "stretch",
  SCALE: "scale",
};

/** Builds the ordinary Canonical transaction commands for property setters on
 * one supported Plugin API SceneNode. Callers submit the returned commands to
 * the Editor Worker; this boundary never mutates a presentation snapshot. */
export function writeFigmaPluginNode(node: CanvasNode, write: FigmaPluginNodeWrite): FigmaPluginMutationResult {
  if ((node.kind === "slideGrid" || node.kind === "slideRow") && Object.keys(write).length) return rejected(`${node.kind === "slideGrid" ? "SLIDE_GRID" : "SLIDE_ROW"} is read-only; manipulate its ${node.kind === "slideGrid" ? "SLIDE_ROW" : "SLIDE"} children instead.`);
  const patch: Partial<CanvasNode> = {};
  const has = (key: keyof FigmaPluginNodeWrite) => Object.hasOwn(write, key);
  if (node.kind === "slide" && (has("rotation") || has("constraints"))) return rejected("SLIDE is fixed at 1920x1080 and cannot be rotated or transformed.");
  if (has("name")) {
    if (typeof write.name !== "string") return rejected("name must be a string.");
    patch.name = write.name;
  }
  if (has("visible")) {
    if (typeof write.visible !== "boolean") return rejected("visible must be a boolean.");
    patch.visible = write.visible;
  }
  if (has("locked")) {
    if (typeof write.locked !== "boolean") return rejected("locked must be a boolean.");
    patch.locked = write.locked;
  }
  if (has("opacity")) {
    if (!unitInterval(write.opacity)) return rejected("opacity must be a finite number from 0 through 1.");
    patch.opacity = write.opacity;
  }
  if (has("rotation")) {
    if (!finite(write.rotation)) return rejected("rotation must be finite.");
    patch.rotation = write.rotation;
  }
  if (has("blendMode")) {
    const blendMode = write.blendMode && BLEND_TO_CANONICAL[write.blendMode];
    if (!blendMode) return rejected(`${String(write.blendMode)} is not in the Canonical blend-mode subset.`);
    patch.blendMode = blendMode;
  }
  if (has("constraints")) {
    if (["group", "booleanOperation"].includes(node.kind)) return rejected(`${node.kind} does not expose Plugin API constraints.`);
    const constraints = canonicalConstraints(write.constraints);
    if (!constraints) return rejected("constraints must use valid Figma constraint values.");
    patch.constraints = constraints;
  }
  if (has("clipsContent")) {
    if ((node.kind !== "frame" && node.kind !== "component") || typeof write.clipsContent !== "boolean") return rejected("clipsContent is writable only on FRAME and COMPONENT nodes.");
    patch.clipsContent = write.clipsContent;
  }
  if (has("sectionContentsHidden")) {
    if (node.kind !== "section" || typeof write.sectionContentsHidden !== "boolean") return rejected("sectionContentsHidden is writable only on SECTION nodes.");
    patch.contentsHidden = write.sectionContentsHidden;
  }
  const hasCornerWrite = ["cornerRadius", "cornerSmoothing", "topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"]
    .some((key) => has(key as keyof FigmaPluginNodeWrite));
  if (hasCornerWrite) {
    if (!supportsCornerProperties(node)) return rejected("corner properties are writable only on FRAME, RECTANGLE, and SECTION nodes.");
    const radii = [...(node.cornerRadii ?? [node.radius, node.radius, node.radius, node.radius])] as [number, number, number, number];
    if (has("cornerRadius")) {
      if (!nonNegative(write.cornerRadius)) return rejected("cornerRadius must be finite and non-negative.");
      patch.radius = write.cornerRadius;
      radii.fill(write.cornerRadius);
    }
    if (has("cornerSmoothing")) {
      if (!unitInterval(write.cornerSmoothing)) return rejected("cornerSmoothing must be a finite number from 0 through 1.");
      patch.cornerSmoothing = write.cornerSmoothing;
    }
    const individual = [write.topLeftRadius, write.topRightRadius, write.bottomRightRadius, write.bottomLeftRadius];
    for (let index = 0; index < individual.length; index += 1) {
      const key = ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"][index]! as keyof FigmaPluginNodeWrite;
      if (!has(key)) continue;
      if (!nonNegative(individual[index])) return rejected(`${key} must be finite and non-negative.`);
      radii[index] = individual[index]!;
    }
    if (has("cornerRadius") || individual.some((_, index) => has(["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"][index]! as keyof FigmaPluginNodeWrite))) patch.cornerRadii = radii;
  }
  if (has("arcData")) {
    if (node.kind !== "ellipse") return rejected("arcData is writable only on ELLIPSE nodes.");
    const arcData = fromFigmaPluginArcData(write.arcData);
    if (!arcData) return rejected("arcData must contain finite radians and an innerRadius from 0 through 1.");
    patch.arcData = arcData;
  }
  if (has("pointCount")) {
    if (node.kind !== "polygon" && node.kind !== "star") return rejected("pointCount is writable only on POLYGON and STAR nodes.");
    if (!Number.isInteger(write.pointCount) || write.pointCount! < 3 || write.pointCount! > 100) return rejected("pointCount must be an integer from 3 through 100.");
    patch.parametricShape = node.kind === "polygon"
      ? { kind: "polygon", pointCount: write.pointCount! }
      : { kind: "star", pointCount: write.pointCount!, innerRatio: node.parametricShape?.kind === "star" ? node.parametricShape.innerRatio : .5 };
  }
  if (has("innerRadius")) {
    if (node.kind !== "star") return rejected("innerRadius is writable only on STAR nodes.");
    // Core's documented parametric-star range is intentionally narrower than
    // Figma's broad numeric input because zero-area inner tips are not safely
    // editable by the current deterministic path engine.
    if (!finite(write.innerRadius) || write.innerRadius! < .05 || write.innerRadius! > .95) return rejected("STAR innerRadius is currently supported from 0.05 through 0.95.");
    patch.parametricShape = { kind: "star", pointCount: node.parametricShape?.kind === "star" ? node.parametricShape.pointCount : 5, innerRatio: write.innerRadius! };
  }
  if (has("booleanOperation")) {
    if (node.kind !== "booleanOperation") return rejected("booleanOperation is writable only on BOOLEAN_OPERATION nodes.");
    const booleanOperation = canonicalBooleanOperation(write.booleanOperation);
    if (!booleanOperation) return rejected("booleanOperation must be UNION, INTERSECT, SUBTRACT, or EXCLUDE.");
    patch.booleanOperation = booleanOperation;
  }
  if (has("characters")) {
    if ((node.kind !== "text" && node.kind !== "textPath") || typeof write.characters !== "string") return rejected("characters is writable only on TEXT and TEXT_PATH nodes and must be a string.");
    patch.text = write.characters;
    if (node.kind === "textPath" && (node.textPathMetadata?.autoRename ?? true)) patch.name = write.characters.slice(0, 100);
  }
  if (has("code")) {
    if (node.kind !== "codeBlock" || typeof write.code !== "string") return rejected("code is writable only on CODE_BLOCK nodes and must be a string.");
    patch.text = write.code;
  }
  if (has("codeLanguage")) {
    if (node.kind !== "codeBlock" || !validCodeLanguage(write.codeLanguage)) return rejected("codeLanguage is writable only on CODE_BLOCK nodes and must be a non-empty language identifier.");
    patch.codeLanguage = write.codeLanguage;
  }
  const hasComponentMetadataWrite = has("description") || has("descriptionMarkdown") || has("documentationLinks");
  if (hasComponentMetadataWrite) {
    if (node.kind !== "component" && node.kind !== "componentSet") return rejected("component publication metadata is writable only on COMPONENT and COMPONENT_SET nodes.");
    if (node.kind === "component") {
      const metadata = structuredClone(node.componentMetadata ?? { key: node.id, remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: {} });
      if (metadata.remote) return rejected("remote COMPONENT nodes are read-only.");
      if (has("description")) { if (typeof write.description !== "string") return rejected("description must be a string."); metadata.description = write.description; }
      if (has("descriptionMarkdown")) { if (typeof write.descriptionMarkdown !== "string") return rejected("descriptionMarkdown must be a string."); metadata.descriptionMarkdown = write.descriptionMarkdown; }
      if (has("documentationLinks")) { if (!validDocumentationLinks(write.documentationLinks)) return rejected("documentationLinks must contain valid absolute HTTP(S) URLs."); metadata.documentationLinks = write.documentationLinks; }
      patch.componentMetadata = metadata;
    } else {
      const metadata = structuredClone(node.componentSetMetadata ?? { key: node.id, remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], variantGroupProperties: {} });
      if (metadata.remote) return rejected("remote COMPONENT_SET nodes are read-only.");
      if (has("description")) { if (typeof write.description !== "string") return rejected("description must be a string."); metadata.description = write.description; }
      if (has("descriptionMarkdown")) { if (typeof write.descriptionMarkdown !== "string") return rejected("descriptionMarkdown must be a string."); metadata.descriptionMarkdown = write.descriptionMarkdown; }
      if (has("documentationLinks")) { if (!validDocumentationLinks(write.documentationLinks)) return rejected("documentationLinks must contain valid absolute HTTP(S) URLs."); metadata.documentationLinks = write.documentationLinks; }
      patch.componentSetMetadata = metadata;
    }
  }
  const hasConnectorWrite = has("connectorLineType") || has("connectorStart") || has("connectorEnd") || has("connectorStartStrokeCap") || has("connectorEndStrokeCap");
  if (hasConnectorWrite) {
    if (node.kind !== "connector") return rejected("connector properties are writable only on CONNECTOR nodes.");
    const metadata = structuredClone(node.connectorMetadata ?? defaultConnectorMetadata(node));
    if (has("connectorLineType")) {
      if (!validConnectorLineType(write.connectorLineType)) return rejected("connectorLineType must be ELBOWED, STRAIGHT, or CURVED.");
      metadata.lineType = write.connectorLineType;
    }
    if (has("connectorStart")) {
      if (!validConnectorEndpoint(write.connectorStart)) return rejected("connectorStart must be a finite endpoint with an optional valid magnet.");
      metadata.start = write.connectorStart;
    }
    if (has("connectorEnd")) {
      if (!validConnectorEndpoint(write.connectorEnd)) return rejected("connectorEnd must be a finite endpoint with an optional valid magnet.");
      metadata.end = write.connectorEnd;
    }
    if (has("connectorStartStrokeCap")) {
      if (!validConnectorStrokeCap(write.connectorStartStrokeCap)) return rejected("connectorStartStrokeCap must be a valid non-empty stroke-cap identifier.");
      metadata.startStrokeCap = write.connectorStartStrokeCap;
    }
    if (has("connectorEndStrokeCap")) {
      if (!validConnectorStrokeCap(write.connectorEndStrokeCap)) return rejected("connectorEndStrokeCap must be a valid non-empty stroke-cap identifier.");
      metadata.endStrokeCap = write.connectorEndStrokeCap;
    }
    patch.connectorMetadata = metadata;
  }
  if (has("handleMirroring")) {
    if (node.kind !== "highlight" || !validHandleMirroring(write.handleMirroring)) return rejected("handleMirroring is writable only on HIGHLIGHT nodes and must be NONE, ANGLE, or ANGLE_AND_LENGTH.");
    patch.highlightHandleMirroring = write.handleMirroring;
  }
  if (has("shapeType")) {
    if (node.kind !== "shapeWithText" || !validShapeWithTextType(write.shapeType)) return rejected("shapeType is writable only on SHAPE_WITH_TEXT nodes and must be an official ShapeWithText type.");
    patch.shapeWithTextType = write.shapeType;
  }
  if (has("isSkippedSlide")) {
    if (node.kind !== "slide" || typeof write.isSkippedSlide !== "boolean") return rejected("isSkippedSlide is writable only on SLIDE nodes and must be a boolean.");
    patch.slideMetadata = { ...(node.slideMetadata ?? defaultSlideMetadata()), isSkippedSlide: write.isSkippedSlide };
  }
  if (has("stickyText")) {
    if (node.kind !== "sticky" || typeof write.stickyText !== "string") return rejected("stickyText is writable only on STICKY nodes and must be a string.");
    patch.text = write.stickyText;
  }
  const hasStickyMetadataWrite = has("authorVisible") || has("isWideWidth");
  if (hasStickyMetadataWrite) {
    if (node.kind !== "sticky") return rejected("authorVisible and isWideWidth are writable only on STICKY nodes.");
    const metadata = { ...(node.stickyMetadata ?? defaultStickyMetadata()) };
    if (has("authorVisible")) { if (typeof write.authorVisible !== "boolean") return rejected("authorVisible must be a boolean."); metadata.authorVisible = write.authorVisible; }
    if (has("isWideWidth")) { if (typeof write.isWideWidth !== "boolean") return rejected("isWideWidth must be a boolean."); metadata.isWideWidth = write.isWideWidth; }
    patch.stickyMetadata = metadata;
  }
  const hasTextPathWrite = has("textPathStartData") || has("textAlignHorizontal") || has("textAlignVertical") || has("autoRename");
  if (hasTextPathWrite) {
    if (node.kind !== "textPath") return rejected("text-path properties are writable only on TEXT_PATH nodes.");
    const metadata = { ...(node.textPathMetadata ?? defaultTextPathMetadata()) };
    if (has("textPathStartData")) { if (!write.textPathStartData || !Number.isInteger(write.textPathStartData.segment) || write.textPathStartData.segment < 0 || !finite(write.textPathStartData.position) || write.textPathStartData.position < 0 || write.textPathStartData.position > 1) return rejected("textPathStartData requires a non-negative integer segment and a position from 0 through 1."); metadata.startSegment = write.textPathStartData.segment; metadata.startPosition = write.textPathStartData.position; }
    if (has("textAlignHorizontal")) { if (!validTextAlignHorizontal(write.textAlignHorizontal)) return rejected("textAlignHorizontal must be LEFT, CENTER, RIGHT, or JUSTIFIED."); metadata.textAlignHorizontal = write.textAlignHorizontal; }
    if (has("textAlignVertical")) { if (!validTextAlignVertical(write.textAlignVertical)) return rejected("textAlignVertical must be TOP, CENTER, or BOTTOM."); metadata.textAlignVertical = write.textAlignVertical; }
    if (has("autoRename")) { if (typeof write.autoRename !== "boolean") return rejected("autoRename must be a boolean."); metadata.autoRename = write.autoRename; }
    patch.textPathMetadata = metadata;
  }
  if (has("transformModifiers")) {
    if (node.kind !== "transformGroup" || !validTransformModifiers(write.transformModifiers)) return rejected("transformModifiers are writable only on TRANSFORM_GROUP nodes and must be valid REPEAT modifiers.");
    patch.transformModifiers = structuredClone(write.transformModifiers);
  }

  const commands: EditorCommand[] = [];
  if (has("isMask")) {
    if (["group", "section"].includes(node.kind) || typeof write.isMask !== "boolean") return rejected("isMask is not writable on this node type.");
    commands.push({ type: "setMask", id: node.id, enabled: write.isMask });
  }
  if (Object.keys(patch).length) commands.unshift({ type: "update", id: node.id, patch });
  return { ok: true, commands };
}

/** Mirrors `resize` and `resizeWithoutConstraints`. Constraints are a Core
 * reflow concern, so both methods resolve to the same durable size mutation. */
export function resizeFigmaPluginNode(node: CanvasNode, width: number, height: number): FigmaPluginMutationResult {
  if (node.kind === "slide") return rejected("SLIDE is fixed at 1920x1080 and cannot be resized.");
  if (!finite(width) || !finite(height) || width < 0 || height < 0) return rejected("resize dimensions must be finite and non-negative.");
  return { ok: true, commands: [{ type: "update", id: node.id, patch: { width, height } }] };
}

/** Adapter for SlideNode.setSlideTransition(). `ON_CLICK` normalizes any
 * supplied delay away, exactly as documented by Figma. */
export function setFigmaPluginSlideTransition(node: CanvasNode, transition: DocumentSlideMetadata["transition"]): FigmaPluginMutationResult {
  if (node.kind !== "slide" || !validSlideTransition(transition)) return rejected("setSlideTransition requires a SLIDE and a valid Figma SlideTransition.");
  const timing = transition.timing.type === "ON_CLICK" ? { type: "ON_CLICK" as const } : transition.timing.delay === undefined ? { type: "AFTER_DELAY" as const } : { type: "AFTER_DELAY" as const, delay: transition.timing.delay };
  return { ok: true, commands: [{ type: "update", id: node.id, patch: { slideMetadata: { ...(node.slideMetadata ?? defaultSlideMetadata()), transition: { ...transition, timing } } } }] };
}

/** Adapter for figma.createSlideRow(). Figma requires the new row to be an
 * immediate child of the unique Slide Grid. */
export function createFigmaPluginSlideRow(slideGrid: CanvasNode, createId: () => string): FigmaPluginSlideRowCreationResult {
  if (slideGrid.kind !== "slideGrid") return rejectedSlideRow("createSlideRow requires the Slide Grid node.");
  const row = { ...createNode("slideRow", 0, 0), id: createId(), parentId: slideGrid.id };
  return { ok: true, slideRowId: row.id, commands: [{ type: "create", node: row }] };
}

/** Adapter for figma.createSlide(). Slides are always inserted at their
 * official fixed size under an existing Slide Row. */
export function createFigmaPluginSlide(slideRow: CanvasNode, createId: () => string): FigmaPluginSlideCreationResult {
  if (slideRow.kind !== "slideRow") return rejectedSlide("createSlide requires a Slide Row node.");
  const slide = { ...createNode("slide", 0, 0), id: createId(), parentId: slideRow.id };
  return { ok: true, slideId: slide.id, commands: [{ type: "create", node: slide }] };
}

/** Adapter for figma.createSticky(). The actual Plugin API derives authorName
 * from the current user; the caller supplies that authenticated name here. */
export function createFigmaPluginSticky(authorName: string, x: number, y: number, createId: () => string): FigmaPluginStickyCreationResult {
  if (typeof authorName !== "string" || !authorName.trim() || !finite(x) || !finite(y)) return rejectedSticky("createSticky requires a non-empty current-user name and finite coordinates.");
  const sticky = { ...createNode("sticky", x, y), id: createId(), stickyMetadata: { ...defaultStickyMetadata(), authorName } };
  return { ok: true, stickyId: sticky.id, commands: [{ type: "create", node: sticky }] };
}

/** Adapter for figma.createTextPath(vector, startSegment, startPosition).
 * Canonical node kinds are immutable identities, so the Figma in-place type
 * conversion is represented by an atomic replacement with a returned ID. */
export function createFigmaPluginTextPath(node: CanvasNode, startSegment: number, startPosition: number, createId: () => string): FigmaPluginTextPathCreationResult {
  if (node.kind !== "vector" || !node.vectorPath) return rejectedTextPath("createTextPath currently requires a VECTOR with a Canonical vector path.");
  const segmentCount = node.vectorPath.subpaths.reduce((total, subpath) => total + Math.max(0, subpath.points.length - 1) + (subpath.closed ? 1 : 0), 0);
  if (!Number.isInteger(startSegment) || startSegment < 0 || startSegment >= segmentCount || !finite(startPosition) || startPosition < 0 || startPosition > 1) return rejectedTextPath("createTextPath requires an existing segment index and a startPosition from 0 through 1.");
  const textPath = { ...node, id: createId(), kind: "textPath" as const, name: "Text path", text: "", textPathMetadata: { ...defaultTextPathMetadata(), startSegment, startPosition }, parametricShape: undefined, booleanOperation: undefined, codeLanguage: undefined, componentMetadata: undefined, componentSetMetadata: undefined, connectorMetadata: undefined, embedMetadata: undefined, highlightHandleMirroring: undefined, interactiveSlideElementType: undefined, linkUnfurlMetadata: undefined, mediaMetadata: undefined, shapeWithTextType: undefined, slideMetadata: undefined, stickyMetadata: undefined, tableMetadata: undefined, tableCellMetadata: undefined, positionId: undefined };
  return { ok: true, textPathId: textPath.id, commands: [{ type: "delete", ids: [node.id] }, { type: "create", node: textPath }] };
}

/** Adapter for figma.transformGroup(). The existing atomic group resolver
 * preserves every child's world geometry before attaching it to the wrapper. */
export function createFigmaPluginTransformGroup(nodes: readonly CanvasNode[], modifiers: DocumentTransformModifier[], createId: () => string): FigmaPluginTransformGroupCreationResult {
  const ids = nodes.map((node) => node.id);
  if (!ids.length || new Set(ids).size !== ids.length || !validTransformModifiers(modifiers)) return rejectedTransformGroup("transformGroup requires non-empty distinct nodes and valid REPEAT modifiers.");
  const id = createId();
  return { ok: true, transformGroupId: id, commands: [{ type: "transformGroup", ids, id, modifiers: structuredClone(modifiers) }] };
}

/** Adapter for WidgetNode.setWidgetSyncedState(). A caller must supply the
 * running widget manifest ID; cross-widget writes are rejected as Figma does. */
export function setFigmaPluginWidgetSyncedState(node: CanvasNode, callerWidgetId: string, syncedState: Record<string, unknown>, syncedMap: Record<string, Record<string, unknown>> = {}): FigmaPluginMutationResult {
  if (node.kind !== "widget" || !node.widgetMetadata || callerWidgetId !== node.widgetMetadata.widgetId || !plainRecord(syncedState) || !plainRecord(syncedMap)) return rejected("setWidgetSyncedState requires a WIDGET owned by the caller and plain state maps.");
  return { ok: true, commands: [{ type: "update", id: node.id, patch: { widgetMetadata: { ...node.widgetMetadata, syncedState: structuredClone(syncedState), syncedMap: structuredClone(syncedMap) } } }] };
}

/** Adapter for figma.createTable(rows, columns). Cell records are ordinary
 * TABLE_CELL children, while row/column geometry is durable table metadata. */
export function createFigmaPluginTable(rows: number, columns: number, x: number, y: number, createId: () => string): FigmaPluginTableCreationResult {
  if (!validTableDimensions(rows, columns) || !finite(x) || !finite(y)) return rejectedTable("createTable requires integer row and column counts from 1 through 100 and finite coordinates.");
  const tableId = createId();
  const metadata: DocumentTableMetadata = { rowHeights: Array(rows).fill(100), columnWidths: Array(columns).fill(200) };
  const table = { ...createNode("table", x, y), id: tableId, width: columns * 200, height: rows * 100, tableMetadata: metadata };
  const cells = Array.from({ length: rows * columns }, (_, index) => {
    const rowIndex = Math.floor(index / columns), columnIndex = index % columns;
    return { ...createNode("tableCell", columnIndex * 200, rowIndex * 100), id: createId(), parentId: tableId, tableCellMetadata: { rowIndex, columnIndex } };
  });
  return { ok: true, tableId, commands: [{ type: "create", node: table }, ...cells.map((node) => ({ type: "create" as const, node }))] };
}

export function tableCellAt(nodes: readonly CanvasNode[], table: CanvasNode, rowIndex: number, columnIndex: number): CanvasNode | undefined {
  return table.kind === "table" && validTableIndex(table.tableMetadata, rowIndex, columnIndex) ? nodes.find((node) => node.kind === "tableCell" && node.parentId === table.id && node.tableCellMetadata?.rowIndex === rowIndex && node.tableCellMetadata.columnIndex === columnIndex) : undefined;
}

export function resizeFigmaPluginTableTrack(table: CanvasNode, axis: "row" | "column", index: number, size: number): FigmaPluginMutationResult {
  if (table.kind !== "table" || !finite(size) || size <= 0) return rejected("resizeRow/resizeColumn requires a TABLE and a positive finite size.");
  const metadata = structuredClone(table.tableMetadata ?? { rowHeights: [], columnWidths: [] });
  const tracks = axis === "row" ? metadata.rowHeights : metadata.columnWidths;
  if (!Number.isInteger(index) || index < 0 || index >= tracks.length) return rejected("table track index is out of bounds.");
  tracks[index] = size;
  return { ok: true, commands: [{ type: "update", id: table.id, patch: { tableMetadata: metadata, width: metadata.columnWidths.reduce((sum, value) => sum + value, 0), height: metadata.rowHeights.reduce((sum, value) => sum + value, 0) } }] };
}

export function insertFigmaPluginTableTrack(nodes: readonly CanvasNode[], table: CanvasNode, axis: "row" | "column", index: number, createId: () => string): FigmaPluginMutationResult {
  const metadata = mutableTableMetadata(table);
  if (!metadata) return rejected("insertRow/insertColumn requires a TABLE with grid metadata.");
  const tracks = axis === "row" ? metadata.rowHeights : metadata.columnWidths;
  if (!Number.isInteger(index) || index < 0 || index > tracks.length) return rejected("insertRow/insertColumn requires an in-bounds TABLE track index.");
  tracks.splice(index, 0, axis === "row" ? 100 : 200);
  const cells = tableCells(nodes, table.id);
  const commands: EditorCommand[] = [{ type: "update", id: table.id, patch: { tableMetadata: metadata, width: total(metadata.columnWidths), height: total(metadata.rowHeights) } }];
  for (const cell of cells) {
    const coordinate = axis === "row" ? cell.tableCellMetadata!.rowIndex : cell.tableCellMetadata!.columnIndex;
    if (coordinate >= index) commands.push({ type: "update", id: cell.id, patch: { tableCellMetadata: axis === "row" ? { ...cell.tableCellMetadata!, rowIndex: coordinate + 1 } : { ...cell.tableCellMetadata!, columnIndex: coordinate + 1 } } });
  }
  const count = axis === "row" ? metadata.columnWidths.length : metadata.rowHeights.length;
  for (let cross = 0; cross < count; cross += 1) {
    const rowIndex = axis === "row" ? index : cross, columnIndex = axis === "column" ? index : cross;
    commands.push({ type: "create", node: { ...createNode("tableCell", 0, 0), id: createId(), parentId: table.id, tableCellMetadata: { rowIndex, columnIndex } } });
  }
  return { ok: true, commands };
}

export function removeFigmaPluginTableTrack(nodes: readonly CanvasNode[], table: CanvasNode, axis: "row" | "column", index: number): FigmaPluginMutationResult {
  const metadata = mutableTableMetadata(table);
  if (!metadata) return rejected("removeRow/removeColumn requires a TABLE with grid metadata.");
  const tracks = axis === "row" ? metadata.rowHeights : metadata.columnWidths;
  if (tracks.length <= 1 || !Number.isInteger(index) || index < 0 || index >= tracks.length) return rejected("removeRow/removeColumn requires a non-final in-bounds TABLE track index.");
  tracks.splice(index, 1);
  const commands: EditorCommand[] = [{ type: "update", id: table.id, patch: { tableMetadata: metadata, width: total(metadata.columnWidths), height: total(metadata.rowHeights) } }];
  for (const cell of tableCells(nodes, table.id)) {
    const coordinate = axis === "row" ? cell.tableCellMetadata!.rowIndex : cell.tableCellMetadata!.columnIndex;
    if (coordinate === index) commands.push({ type: "delete", ids: [cell.id] });
    else if (coordinate > index) commands.push({ type: "update", id: cell.id, patch: { tableCellMetadata: axis === "row" ? { ...cell.tableCellMetadata!, rowIndex: coordinate - 1 } : { ...cell.tableCellMetadata!, columnIndex: coordinate - 1 } } });
  }
  return { ok: true, commands };
}

export function moveFigmaPluginTableTrack(nodes: readonly CanvasNode[], table: CanvasNode, axis: "row" | "column", fromIndex: number, toIndex: number): FigmaPluginMutationResult {
  const metadata = mutableTableMetadata(table);
  if (!metadata) return rejected("moveRow/moveColumn requires a TABLE with grid metadata.");
  const tracks = axis === "row" ? metadata.rowHeights : metadata.columnWidths;
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex < 0 || toIndex < 0 || fromIndex >= tracks.length || toIndex >= tracks.length) return rejected("moveRow/moveColumn requires in-bounds TABLE track indices.");
  const [track] = tracks.splice(fromIndex, 1); tracks.splice(toIndex, 0, track!);
  const remap = (value: number) => value === fromIndex ? toIndex : fromIndex < toIndex && value > fromIndex && value <= toIndex ? value - 1 : toIndex < fromIndex && value >= toIndex && value < fromIndex ? value + 1 : value;
  return { ok: true, commands: [{ type: "update", id: table.id, patch: { tableMetadata: metadata } }, ...tableCells(nodes, table.id).map((cell) => ({ type: "update" as const, id: cell.id, patch: { tableCellMetadata: axis === "row" ? { ...cell.tableCellMetadata!, rowIndex: remap(cell.tableCellMetadata!.rowIndex) } : { ...cell.tableCellMetadata!, columnIndex: remap(cell.tableCellMetadata!.columnIndex) } } }))] };
}

export function addFigmaPluginComponentProperty(node: CanvasNode, name: string, definition: NonNullable<CanvasNode["componentMetadata"]>["componentPropertyDefinitions"][string]): FigmaPluginMutationResult {
  if (node.kind !== "component" || !node.componentMetadata || node.componentMetadata.remote) return rejected("addComponentProperty requires a mutable COMPONENT node.");
  if (!validComponentProperty(name, definition) || node.componentMetadata.componentPropertyDefinitions[name]) return rejected("component property name or definition is invalid.");
  return { ok: true, commands: [{
    type: "update", id: node.id,
    patch: { componentMetadata: { ...node.componentMetadata, componentPropertyDefinitions: { ...node.componentMetadata.componentPropertyDefinitions, [name]: definition } } },
  }] };
}

export function editFigmaPluginComponentProperty(node: CanvasNode, name: string, definition: Partial<NonNullable<CanvasNode["componentMetadata"]>["componentPropertyDefinitions"][string]>): FigmaPluginMutationResult {
  const existing = node.componentMetadata?.componentPropertyDefinitions[name];
  if (node.kind !== "component" || !node.componentMetadata || node.componentMetadata.remote || !existing) return rejected("editComponentProperty requires an existing mutable COMPONENT property.");
  const next = { ...existing, ...definition };
  if (!validComponentProperty(name, next)) return rejected("component property definition is invalid.");
  return { ok: true, commands: [{
    type: "update", id: node.id,
    patch: { componentMetadata: { ...node.componentMetadata, componentPropertyDefinitions: { ...node.componentMetadata.componentPropertyDefinitions, [name]: next } } },
  }] };
}

export function deleteFigmaPluginComponentProperty(node: CanvasNode, name: string): FigmaPluginMutationResult {
  if (node.kind !== "component" || !node.componentMetadata || node.componentMetadata.remote || !node.componentMetadata.componentPropertyDefinitions[name]) return rejected("deleteComponentProperty requires an existing mutable COMPONENT property.");
  const componentPropertyDefinitions = { ...node.componentMetadata.componentPropertyDefinitions };
  delete componentPropertyDefinitions[name];
  return { ok: true, commands: [{
    type: "update", id: node.id,
    patch: { componentMetadata: { ...node.componentMetadata, componentPropertyDefinitions } },
  }] };
}

/** Implements ComponentNode.createSlot(). A slot is a Frame-like child plus
 * a durable SLOT component-property definition in the same transaction. */
export function createFigmaPluginSlot(component: CanvasNode, propertyName: string, createId: () => string): FigmaPluginSlotCreationResult {
  if (component.kind !== "component" || !component.componentMetadata || component.componentMetadata.remote) return rejectedSlot("createSlot requires a mutable COMPONENT node.");
  if (!validComponentProperty(propertyName, { type: "SLOT" }) || component.componentMetadata.componentPropertyDefinitions[propertyName]) return rejectedSlot("slot property name is invalid or already exists.");
  const id = createId();
  const slot: CanvasNode = { ...component, id, kind: "slot", parentId: component.id, name: propertyName, x: 0, y: 0, width: Math.max(1, component.width / 2), height: Math.max(1, component.height / 2), componentMetadata: undefined, instanceMetadata: undefined, slotMetadata: { propertyName }, extensions: {} };
  const componentPropertyDefinitions = { ...component.componentMetadata.componentPropertyDefinitions, [propertyName]: { type: "SLOT" as const } };
  return { ok: true, slotId: id, commands: [
    { type: "update", id: component.id, patch: { componentMetadata: { ...component.componentMetadata, componentPropertyDefinitions } } },
    { type: "create", node: slot },
  ] };
}

/** Implements ComponentNode.createInstance() with a durable main-component
 * link and a complete cloned subtree. Every clone carries its source-node ID,
 * enabling later component edits to be replayed to linked instances. */
export function createFigmaPluginInstance(nodes: readonly CanvasNode[], componentId: string, createId: () => string): FigmaPluginInstanceCreationResult {
  const component = nodes.find((node) => node.id === componentId);
  if (!component || component.kind !== "component") return rejectedInstance("createInstance requires a local COMPONENT node.");
  if (component.componentMetadata?.remote) return rejectedInstance("remote COMPONENT nodes cannot create a local instance.");
  const subtree = componentSubtree(nodes, component.id);
  if (!subtree.length) return rejectedInstance("component subtree is invalid.");
  const ids = new Map(subtree.map((node) => [node.id, createId()]));
  const instanceId = ids.get(component.id)!;
  const commands = subtree.map((source): EditorCommand => {
    const id = ids.get(source.id)!;
    const isRoot = source.id === component.id;
    const extensions = { ...source.extensions, "figma.instance.source-node.v1": [...new TextEncoder().encode(source.id)] };
    const copy: CanvasNode = isRoot
      ? { ...source, id, kind: "instance", parentId: undefined, x: source.x + 16, y: source.y + 16, name: `${source.name} instance`, extensions, instanceMetadata: { mainComponentId: component.id, scaleFactor: 1, componentProperties: componentDefaultProperties(component), overrides: [], isExposedInstance: false } }
      : { ...source, id, parentId: source.parentId ? ids.get(source.parentId) : undefined, extensions };
    return { type: "create", node: copy };
  });
  return { ok: true, instanceId, commands };
}

/** Implements InstanceNode.setProperties(). SLOT values are intentionally
 * rejected, matching Figma's cannotSetSlotProperty contract. */
export function setFigmaPluginInstanceProperties(node: CanvasNode, properties: Record<string, string | boolean>): FigmaPluginMutationResult {
  if (node.kind !== "instance" || !node.instanceMetadata) return rejected("setProperties requires a linked INSTANCE node.");
  if (!Object.values(properties).every((value) => typeof value === "string" || typeof value === "boolean")) return rejected("component properties must be strings or booleans.");
  return { ok: true, commands: [{ type: "update", id: node.id, patch: { instanceMetadata: { ...node.instanceMetadata, componentProperties: { ...node.instanceMetadata.componentProperties, ...properties } } } }] };
}

/** Implements InstanceNode.swapComponent(). The source subtree remains
 * intact; the persistent link and property defaults move together. */
export function swapFigmaPluginComponent(nodes: readonly CanvasNode[], instanceId: string, componentId: string): FigmaPluginMutationResult {
  const instance = nodes.find((node) => node.id === instanceId);
  const component = nodes.find((node) => node.id === componentId);
  if (!instance || instance.kind !== "instance" || !instance.instanceMetadata) return rejected("swapComponent requires a linked INSTANCE node.");
  if (!component || component.kind !== "component") return rejected("swapComponent requires a COMPONENT target.");
  return { ok: true, commands: [{ type: "update", id: instance.id, patch: { instanceMetadata: { ...instance.instanceMetadata, mainComponentId: component.id, componentProperties: componentDefaultProperties(component), overrides: [] } } }] };
}

/** Implements InstanceNode.removeOverrides() without touching inherited
 * overrides from a containing instance. */
export function removeFigmaPluginInstanceOverrides(node: CanvasNode): FigmaPluginMutationResult {
  if (node.kind !== "instance" || !node.instanceMetadata) return rejected("removeOverrides requires a linked INSTANCE node.");
  return { ok: true, commands: [{ type: "update", id: node.id, patch: { instanceMetadata: { ...node.instanceMetadata, overrides: [] } } }] };
}

/** Adapter equivalent of InstanceNode.exposedInstances. It returns the
 * persistent node IDs, since Canonical deliberately has no live Node objects. */
export function getFigmaPluginExposedInstanceIds(nodes: readonly CanvasNode[], instanceId: string) {
  const descendants = componentSubtree(nodes, instanceId).slice(1);
  return descendants.filter((node) => node.kind === "instance" && node.instanceMetadata?.isExposedInstance).map((node) => node.id);
}

/** Adapter equivalent of ComponentNode.getInstancesAsync(). */
export function getFigmaPluginInstanceIds(nodes: readonly CanvasNode[], componentId: string) {
  return nodes.filter((node) => node.kind === "instance" && node.instanceMetadata?.mainComponentId === componentId).map((node) => node.id);
}

/** Converts a linked instance to its Frame representation, preserving the
 * rendered subtree in one replace transaction. */
export function detachFigmaPluginInstance(nodes: readonly CanvasNode[], instanceId: string, createId: () => string): FigmaPluginMutationResult {
  const instance = nodes.find((node) => node.id === instanceId);
  if (!instance || instance.kind !== "instance") return rejected("detachInstance requires an INSTANCE node.");
  const subtree = componentSubtree(nodes, instance.id);
  const ids = new Map(subtree.map((node) => [node.id, createId()]));
  const commands = subtree.map((source): EditorCommand => {
    const isRoot = source.id === instance.id;
    const copy: CanvasNode = {
      ...source, id: ids.get(source.id)!, kind: isRoot ? "frame" : source.kind,
      parentId: isRoot ? source.parentId : source.parentId ? ids.get(source.parentId) : undefined,
      name: isRoot ? `${source.name} detached` : source.name,
      instanceMetadata: undefined, extensions: withoutInstanceExtensions(source.extensions),
    };
    return { type: "create", node: copy };
  });
  return { ok: true, commands: [...commands, { type: "delete", ids: [instance.id] }] };
}

function componentSubtree(nodes: readonly CanvasNode[], rootId: string) {
  const result: CanvasNode[] = [];
  const visit = (id: string) => {
    const node = nodes.find((candidate) => candidate.id === id);
    if (!node) return;
    result.push(node);
    nodes.filter((candidate) => candidate.parentId === id).forEach((child) => visit(child.id));
  };
  visit(rootId);
  return result;
}

function componentDefaultProperties(component: CanvasNode) {
  return Object.fromEntries(Object.entries(component.componentMetadata?.componentPropertyDefinitions ?? {}).flatMap(([name, definition]) => {
    if (definition.type === "SLOT" || definition.defaultValue === undefined) return [];
    return [[name, definition.defaultValue]];
  }));
}

function validComponentProperty(name: string, definition: NonNullable<CanvasNode["componentMetadata"]>["componentPropertyDefinitions"][string]) {
  return name.length > 0 && name.length <= 256 && /^[^\u0000-\u001f]+$/u.test(name)
    && ["BOOLEAN", "TEXT", "INSTANCE_SWAP", "VARIANT", "SLOT"].includes(definition.type)
    && (definition.defaultValue === undefined || typeof definition.defaultValue === "string" || typeof definition.defaultValue === "boolean")
    && (definition.description === undefined || typeof definition.description === "string");
}

function withoutInstanceExtensions(extensions: CanvasNode["extensions"]) {
  const next = { ...extensions };
  delete next["figma.instance.metadata.v1"];
  delete next["figma.instance.source-node.v1"];
  return next;
}

/** Mirrors `remove()` with a normal Editor deletion transaction. */
export function removeFigmaPluginNode(node: CanvasNode): FigmaPluginMutationResult {
  return { ok: true, commands: [{ type: "delete", ids: [node.id] }] };
}

/** Implements ConnectorNode.reconnect(). Endpoint replacement follows the
 * same durable metadata path as individual Connector setters. */
export function reconnectFigmaPluginConnector(node: CanvasNode, start: DocumentConnectorMetadata["start"], end: DocumentConnectorMetadata["end"]): FigmaPluginMutationResult {
  return writeFigmaPluginNode(node, { connectorStart: start, connectorEnd: end });
}

/** Adapter for figma.createLinkPreviewAsync(). Figma resolves provider details
 * remotely; this boundary accepts the resolved readonly EmbedData explicitly
 * and preserves it as extension-backed metadata. */
export function createFigmaPluginLinkPreview(embedData: NonNullable<CanvasNode["embedMetadata"]>, x: number, y: number, createId: () => string): FigmaPluginEmbedCreationResult {
  if (!validEmbedMetadata(embedData) || !finite(x) || !finite(y)) return rejectedEmbed("createLinkPreviewAsync requires a valid HTTP(S) EmbedData payload and finite coordinates.");
  const node = { ...createNode("embed", x, y), id: createId(), name: embedData.title || "Embed", embedMetadata: structuredClone(embedData) };
  return { ok: true, embedId: node.id, commands: [{ type: "create", node }] };
}

/** Link-preview branch for LinkUnfurlNode, whose provider-resolved metadata is
 * also readonly after creation. */
export function createFigmaPluginLinkUnfurl(linkUnfurlData: NonNullable<CanvasNode["linkUnfurlMetadata"]>, x: number, y: number, createId: () => string): FigmaPluginLinkUnfurlCreationResult {
  if (!validLinkUnfurlMetadata(linkUnfurlData) || !finite(x) || !finite(y)) return rejectedLinkUnfurl("createLinkPreviewAsync requires valid HTTP(S) LinkUnfurlData and finite coordinates.");
  const node = { ...createNode("linkUnfurl", x, y), id: createId(), name: linkUnfurlData.title || "Link unfurl", linkUnfurlMetadata: structuredClone(linkUnfurlData) };
  return { ok: true, linkUnfurlId: node.id, commands: [{ type: "create", node }] };
}

/** Adapter for figma.createGif(). Media bytes stay in the existing asset
 * service; the node keeps the immutable content hash exposed by MediaData. */
export function createFigmaPluginGif(assetId: string, hash: string, width: number, height: number, x: number, y: number, createId: () => string): FigmaPluginMediaCreationResult {
  if (![assetId, hash].every(validMediaIdentifier) || ![width, height, x, y].every(finite) || width <= 0 || height <= 0) return rejectedMedia("createGif requires non-empty assetId/hash and positive finite dimensions.");
  const node = { ...createNode("media", x, y), id: createId(), width, height, assetId, mediaMetadata: { hash } };
  return { ok: true, mediaId: node.id, commands: [{ type: "create", node }] };
}

/** Adapter for figma.createShapeWithText(). The text is carried in the
 * Canonical text field and exposed as a readonly text-sublayer projection. */
export function createFigmaPluginShapeWithText(shapeType: ShapeWithTextType, x: number, y: number, createId: () => string): FigmaPluginShapeWithTextCreationResult {
  if (!validShapeWithTextType(shapeType) || !finite(x) || !finite(y)) return rejectedShapeWithText("createShapeWithText requires an official shape type and finite coordinates.");
  const node = { ...createNode("shapeWithText", x, y), id: createId(), shapeWithTextType: shapeType };
  return { ok: true, shapeWithTextId: node.id, commands: [{ type: "create", node }] };
}

/** Canonical path input for HighlightNode.setVectorNetworkAsync(). The exact
 * Figma network topology remains an intentional future adapter; stable path
 * points are the lossless subset currently supported by Core. */
export function setFigmaPluginHighlightVectorNetwork(node: CanvasNode, path: DocumentVectorPath): FigmaPluginMutationResult {
  if (node.kind !== "highlight" || !validHighlightPath(path)) return rejected("setVectorNetworkAsync requires a valid HIGHLIGHT path.");
  return { ok: true, commands: [{ type: "update", id: node.id, patch: { vectorPath: path } }] };
}

const pluginDataPrefix = "figma.plugin-data.v1/";

/** Plugin API storage is normally scoped by the running plugin manifest. The
 * adapter accepts that scope explicitly and stores UTF-8 values in the
 * forward-compatible Canonical extension map. An empty value deletes the key,
 * which mirrors Figma's `setPluginData(key, "")` convention. */
export function getFigmaPluginData(node: CanvasNode, pluginId: string, key: string): string | undefined {
  const storageKey = pluginDataStorageKey(pluginId, key);
  const bytes = storageKey && node.extensions?.[storageKey];
  return bytes ? new TextDecoder().decode(Uint8Array.from(bytes)) : undefined;
}

export function setFigmaPluginData(node: CanvasNode, pluginId: string, key: string, value: string): FigmaPluginMutationResult {
  const storageKey = pluginDataStorageKey(pluginId, key);
  if (!storageKey || typeof value !== "string") return rejected("pluginId, key, and value must be non-empty strings without control characters.");
  const encoded = [...new TextEncoder().encode(value)];
  if (encoded.length > 64 * 1024) return rejected("plugin data values are limited to 64 KiB.");
  const extensions = { ...node.extensions };
  if (value) extensions[storageKey] = encoded;
  else delete extensions[storageKey];
  return { ok: true, commands: [{ type: "update", id: node.id, patch: { extensions } }] };
}

function canonicalConstraints(value: unknown): DocumentConstraints | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (!isFigmaConstraint(record.horizontal) || !isFigmaConstraint(record.vertical)) return undefined;
  return { horizontal: CONSTRAINT_TO_CANONICAL[record.horizontal], vertical: CONSTRAINT_TO_CANONICAL[record.vertical] };
}

function isFigmaConstraint(value: unknown): value is FigmaPluginConstraints["horizontal"] {
  return value === "MIN" || value === "CENTER" || value === "MAX" || value === "STRETCH" || value === "SCALE";
}

function canonicalBooleanOperation(value: unknown): DocumentBooleanOperation | undefined {
  return value === "UNION" ? "union" : value === "INTERSECT" ? "intersect" : value === "SUBTRACT" ? "subtract" : value === "EXCLUDE" ? "exclude" : undefined;
}

function supportsCornerProperties(node: CanvasNode) { return node.kind === "frame" || node.kind === "component" || node.kind === "instance" || node.kind === "rectangle" || node.kind === "section"; }

function defaultConnectorMetadata(node: CanvasNode): DocumentConnectorMetadata {
  return { lineType: "STRAIGHT", start: { x: 0, y: 0, magnet: "AUTO" }, end: { x: node.width, y: 0, magnet: "AUTO" }, startStrokeCap: "NONE", endStrokeCap: "NONE", text: "" };
}

function validConnectorLineType(value: unknown): value is DocumentConnectorMetadata["lineType"] { return value === "ELBOWED" || value === "STRAIGHT" || value === "CURVED"; }
function validConnectorEndpoint(value: unknown): value is DocumentConnectorMetadata["start"] {
  if (!value || typeof value !== "object") return false;
  const endpoint = value as Record<string, unknown>;
  return finite(endpoint.x) && finite(endpoint.y)
    && (endpoint.endpointNodeId === undefined || typeof endpoint.endpointNodeId === "string")
    && (endpoint.magnet === undefined || endpoint.magnet === "TOP" || endpoint.magnet === "RIGHT" || endpoint.magnet === "BOTTOM" || endpoint.magnet === "LEFT" || endpoint.magnet === "AUTO");
}
function validConnectorStrokeCap(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 64 && /^[A-Z_]+$/u.test(value); }
function validHandleMirroring(value: unknown): value is NonNullable<CanvasNode["highlightHandleMirroring"]> { return value === "NONE" || value === "ANGLE" || value === "ANGLE_AND_LENGTH"; }
function validShapeWithTextType(value: unknown): value is ShapeWithTextType { return typeof value === "string" && shapeWithTextTypes.has(value as ShapeWithTextType); }
function defaultSlideMetadata(): DocumentSlideMetadata { return { isSkippedSlide: false, transition: { style: "NONE", duration: .3, curve: "EASE_IN", timing: { type: "ON_CLICK" } } }; }
function defaultStickyMetadata(): DocumentStickyMetadata { return { authorVisible: true, authorName: "", isWideWidth: false }; }
function defaultTextPathMetadata(): DocumentTextPathMetadata { return { startSegment: 0, startPosition: 0, autoRename: true, textAlignHorizontal: "LEFT", textAlignVertical: "TOP" }; }
function validTextAlignHorizontal(value: unknown): value is DocumentTextPathMetadata["textAlignHorizontal"] { return value === "LEFT" || value === "CENTER" || value === "RIGHT" || value === "JUSTIFIED"; }
function validTextAlignVertical(value: unknown): value is DocumentTextPathMetadata["textAlignVertical"] { return value === "TOP" || value === "CENTER" || value === "BOTTOM"; }
function validTransformModifiers(value: unknown): value is DocumentTransformModifier[] { return Array.isArray(value) && value.every((modifier) => modifier && typeof modifier === "object" && modifier.type === "REPEAT" && finite(modifier.count) && modifier.count >= 1 && finite(modifier.offset) && (modifier.unitType === "RELATIVE" || modifier.unitType === "PIXELS") && ((modifier.repeatType === "LINEAR" && (modifier.axis === "HORIZONTAL" || modifier.axis === "VERTICAL")) || modifier.repeatType === "RADIAL")); }
function plainRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function validTableDimensions(rows: number, columns: number) { return Number.isInteger(rows) && Number.isInteger(columns) && rows >= 1 && rows <= 100 && columns >= 1 && columns <= 100; }
function mutableTableMetadata(table: CanvasNode): DocumentTableMetadata | undefined { return table.kind === "table" && table.tableMetadata ? structuredClone(table.tableMetadata) : undefined; }
function tableCells(nodes: readonly CanvasNode[], tableId: string) { return nodes.filter((node) => node.kind === "tableCell" && node.parentId === tableId && node.tableCellMetadata); }
function total(values: number[]) { return values.reduce((sum, value) => sum + value, 0); }
function validTableIndex(metadata: CanvasNode["tableMetadata"], rowIndex: number, columnIndex: number) { return !!metadata && Number.isInteger(rowIndex) && Number.isInteger(columnIndex) && rowIndex >= 0 && rowIndex < metadata.rowHeights.length && columnIndex >= 0 && columnIndex < metadata.columnWidths.length; }
function validSlideTransition(value: unknown): value is DocumentSlideMetadata["transition"] {
  if (!value || typeof value !== "object") return false;
  const transition = value as DocumentSlideMetadata["transition"];
  return slideTransitionStyles.has(transition.style) && finite(transition.duration) && transition.duration >= 0 && slideTransitionCurves.has(transition.curve)
    && (transition.timing?.type === "ON_CLICK" || (transition.timing?.type === "AFTER_DELAY" && (transition.timing.delay === undefined || (finite(transition.timing.delay) && transition.timing.delay >= 0))));
}
const slideTransitionStyles = new Set<DocumentSlideMetadata["transition"]["style"]>(["NONE", "DISSOLVE", "SLIDE_FROM_LEFT", "SLIDE_FROM_RIGHT", "SLIDE_FROM_BOTTOM", "SLIDE_FROM_TOP", "PUSH_FROM_LEFT", "PUSH_FROM_RIGHT", "PUSH_FROM_BOTTOM", "PUSH_FROM_TOP", "MOVE_FROM_LEFT", "MOVE_FROM_RIGHT", "MOVE_FROM_TOP", "MOVE_FROM_BOTTOM", "SLIDE_OUT_TO_LEFT", "SLIDE_OUT_TO_RIGHT", "SLIDE_OUT_TO_TOP", "SLIDE_OUT_TO_BOTTOM", "MOVE_OUT_TO_LEFT", "MOVE_OUT_TO_RIGHT", "MOVE_OUT_TO_TOP", "MOVE_OUT_TO_BOTTOM", "SMART_ANIMATE"]);
const slideTransitionCurves = new Set<DocumentSlideMetadata["transition"]["curve"]>(["EASE_IN", "EASE_OUT", "EASE_IN_AND_OUT", "LINEAR", "GENTLE", "QUICK", "BOUNCY", "SLOW"]);
const shapeWithTextTypes = new Set<ShapeWithTextType>(["SQUARE", "ELLIPSE", "ROUNDED_RECTANGLE", "DIAMOND", "TRIANGLE_UP", "TRIANGLE_DOWN", "PARALLELOGRAM_RIGHT", "PARALLELOGRAM_LEFT", "ENG_DATABASE", "ENG_QUEUE", "ENG_FILE", "ENG_FOLDER", "TRAPEZOID", "PREDEFINED_PROCESS", "SHIELD", "DOCUMENT_SINGLE", "DOCUMENT_MULTIPLE", "MANUAL_INPUT", "HEXAGON", "CHEVRON", "PENTAGON", "OCTAGON", "STAR", "PLUS", "ARROW_LEFT", "ARROW_RIGHT", "SUMMING_JUNCTION", "OR", "SPEECH_BUBBLE", "INTERNAL_STORAGE"]);
function validHighlightPath(path: unknown): path is DocumentVectorPath {
  return Boolean(path && typeof path === "object" && (path as DocumentVectorPath).subpaths?.length && (path as DocumentVectorPath).subpaths.length <= 64);
}
function validEmbedMetadata(value: unknown): value is NonNullable<CanvasNode["embedMetadata"]> {
  if (!value || typeof value !== "object") return false;
  const embed = value as Record<string, unknown>;
  return typeof embed.srcUrl === "string" && /^https?:\/\//u.test(embed.srcUrl)
    && [embed.canonicalUrl, embed.title, embed.provider].every((entry) => entry === null || typeof entry === "string");
}
function validLinkUnfurlMetadata(value: unknown): value is NonNullable<CanvasNode["linkUnfurlMetadata"]> {
  if (!value || typeof value !== "object") return false;
  const link = value as Record<string, unknown>;
  return typeof link.url === "string" && /^https?:\/\//u.test(link.url)
    && [link.title, link.description, link.provider].every((entry) => entry === null || typeof entry === "string");
}
function validMediaIdentifier(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f]/u.test(value); }

function pluginDataStorageKey(pluginId: string, key: string): string | undefined {
  if (![pluginId, key].every((value) => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value))) return undefined;
  return `${pluginDataPrefix}${pluginId}/${key}`;
}

function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function nonNegative(value: unknown): value is number { return finite(value) && value >= 0; }
function validCodeLanguage(value: unknown): value is string { return typeof value === "string" && /^[A-Z][A-Z0-9_]*$/.test(value); }
function validDocumentationLinks(value: unknown): value is Array<{ uri: string; name?: string }> { return Array.isArray(value) && value.every((link) => link && typeof link === "object" && typeof link.uri === "string" && /^https?:\/\//u.test(link.uri) && (link.name === undefined || typeof link.name === "string")); }
function unitInterval(value: unknown): value is number { return finite(value) && value >= 0 && value <= 1; }
function rejected(reason: string): FigmaPluginMutationResult { return { ok: false, reason }; }
function rejectedInstance(reason: string): FigmaPluginInstanceCreationResult { return { ok: false, reason }; }
function rejectedSlot(reason: string): FigmaPluginSlotCreationResult { return { ok: false, reason }; }
function rejectedEmbed(reason: string): FigmaPluginEmbedCreationResult { return { ok: false, reason }; }
function rejectedLinkUnfurl(reason: string): FigmaPluginLinkUnfurlCreationResult { return { ok: false, reason }; }
function rejectedMedia(reason: string): FigmaPluginMediaCreationResult { return { ok: false, reason }; }
function rejectedShapeWithText(reason: string): FigmaPluginShapeWithTextCreationResult { return { ok: false, reason }; }
function rejectedSlideRow(reason: string): FigmaPluginSlideRowCreationResult { return { ok: false, reason }; }
function rejectedSlide(reason: string): FigmaPluginSlideCreationResult { return { ok: false, reason }; }
function rejectedSticky(reason: string): FigmaPluginStickyCreationResult { return { ok: false, reason }; }
function rejectedTable(reason: string): FigmaPluginTableCreationResult { return { ok: false, reason }; }
function rejectedTextPath(reason: string): FigmaPluginTextPathCreationResult { return { ok: false, reason }; }
function rejectedTransformGroup(reason: string): FigmaPluginTransformGroupCreationResult { return { ok: false, reason }; }
