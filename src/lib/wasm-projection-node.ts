import { isShapeWithTextType, type CanvasNode, type CoreProjectionNode } from "./editor-protocol";
import { normalizeAutoLayout } from "./auto-layout-normalization";
import { decodePrototypeMetadata, decodePrototypeReactions, PROTOTYPE_METADATA_EXTENSION, PROTOTYPE_REACTIONS_EXTENSION } from "../runtime/prototype-contract";

/** Restores the browser rendering projection from the Canonical WASM snapshot.
 * Keep Core-owned appearance values here so a post-commit snapshot cannot
 * silently reset an Inspector control to its browser-side default. */
export function canvasNodeFromWasmProjection(node: CoreProjectionNode): CanvasNode {
  const codeLanguage = node.kind === "codeBlock" ? codeLanguageFromExtensions(node.extensions) : undefined;
  const componentMetadata = node.kind === "component" ? componentMetadataFromExtensions(node.extensions, node.id) : undefined;
  const instanceMetadata = node.kind === "instance" ? instanceMetadataFromExtensions(node.extensions) : undefined;
  const slotMetadata = node.kind === "slot" ? slotMetadataFromExtensions(node.extensions) : undefined;
  const componentSetMetadata = node.kind === "componentSet" ? componentSetMetadataFromExtensions(node.extensions, node.id) : undefined;
  const connectorMetadata = node.kind === "connector" ? connectorMetadataFromExtensions(node.extensions) : undefined;
  const embedMetadata = node.kind === "embed" ? embedMetadataFromExtensions(node.extensions) : undefined;
  const highlightHandleMirroring = node.kind === "highlight" ? highlightHandleMirroringFromExtensions(node.extensions) : undefined;
  const interactiveSlideElementType = node.kind === "interactiveSlideElement" ? interactiveSlideElementTypeFromExtensions(node.extensions) : undefined;
  const linkUnfurlMetadata = node.kind === "linkUnfurl" ? linkUnfurlMetadataFromExtensions(node.extensions) : undefined;
  const mediaMetadata = node.kind === "media" ? mediaMetadataFromExtensions(node.extensions) : undefined;
  const shapeWithTextType = node.kind === "shapeWithText" ? shapeWithTextTypeFromExtensions(node.extensions) : undefined;
  const slideMetadata = node.kind === "slide" ? slideMetadataFromExtensions(node.extensions) : undefined;
  const stickyMetadata = node.kind === "sticky" ? stickyMetadataFromExtensions(node.extensions) : undefined;
  const tableMetadata = node.kind === "table" ? tableMetadataFromExtensions(node.extensions) : undefined;
  const tableCellMetadata = node.kind === "tableCell" ? tableCellMetadataFromExtensions(node.extensions) : undefined;
  const textPathMetadata = node.kind === "textPath" ? textPathMetadataFromExtensions(node.extensions) : undefined;
  const transformModifiers = node.kind === "transformGroup" ? transformModifiersFromExtensions(node.extensions) : undefined;
  const widgetMetadata = node.kind === "widget" ? widgetMetadataFromExtensions(node.extensions) : undefined;
  const reactions = decodePrototypeReactions(node.extensions?.[PROTOTYPE_REACTIONS_EXTENSION]);
  const canvasReactions: NonNullable<CanvasNode["reactions"]> = reactions.map((reaction) => ({
    trigger: structuredClone(reaction.trigger),
    actions: reaction.actions.map((action) => structuredClone(action)),
  }));
  const prototypeMetadata = decodePrototypeMetadata(node.extensions?.[PROTOTYPE_METADATA_EXTENSION]);
  const textProperties = node.textProperties
    ? {
        ...node.textProperties,
        runs: node.textProperties.runs.map((run) => ({
          ...run,
          fillStack: run.fillStack ?? undefined,
          textCase: run.textCase ?? undefined,
        })),
        baseStyle: node.textProperties.baseStyle
          ? {
              ...node.textProperties.baseStyle,
              fillStack: node.textProperties.baseStyle.fillStack ?? undefined,
              textCase: node.textProperties.baseStyle.textCase ?? undefined,
            }
          : undefined,
      }
    : undefined;
  return {
    id: node.id, pageId: node.pageId, parentId: node.parentId ?? undefined, name: node.name, kind: node.kind, x: node.x, y: node.y, width: node.width, height: node.height,
    rotation: node.rotation, fill: node.fill, fillColor: node.fillColor, fillGradient: node.fillGradient, fills: node.fills, fillStack: node.fillStack ?? undefined, positionId: node.positionId,
    stroke: node.stroke, strokeColor: node.strokeColor, strokeGradient: node.strokeGradient, strokes: node.strokes, strokeStack: node.strokeStack ?? undefined, strokeWidth: node.strokeWidth, strokeCapStart: node.strokeCapStart, strokeCapEnd: node.strokeCapEnd, strokeJoin: node.strokeJoin, strokeMiterLimit: node.strokeMiterLimit, strokeDashPattern: node.strokeDashPattern, strokeWeights: node.strokeWeights?.length === 4 ? [node.strokeWeights[0], node.strokeWeights[1], node.strokeWeights[2], node.strokeWeights[3]] : undefined, strokeAlign: node.strokeAlign, arcData: node.arcData, parametricShape: node.parametricShape, vectorPath: node.vectorPath, booleanOperation: node.booleanOperation, relativeTransform: node.relativeTransform, clipsContent: node.clipsContent,
    radius: node.cornerRadius, cornerRadii: node.cornerRadii?.length === 4 ? [node.cornerRadii[0], node.cornerRadii[1], node.cornerRadii[2], node.cornerRadii[3]] : undefined, cornerSmoothing: node.cornerSmoothing, constraints: node.constraints, autoLayout: normalizeAutoLayout(node.autoLayout), opacity: node.opacity, blendMode: node.blendMode, dropShadow: node.dropShadow, effectStack: node.effectStack, text: node.text, codeLanguage, componentMetadata, instanceMetadata, slotMetadata, componentSetMetadata, connectorMetadata, embedMetadata, highlightHandleMirroring, interactiveSlideElementType, linkUnfurlMetadata, mediaMetadata, shapeWithTextType, slideMetadata, stickyMetadata, tableMetadata, tableCellMetadata, textPathMetadata, transformModifiers, widgetMetadata, textProperties, reactions: canvasReactions.length ? canvasReactions : undefined, prototypeMetadata, assetId: node.assetId, visible: node.visible, locked: node.locked, contentsHidden: node.contentsHidden, isMask: node.isMask, extensions: node.extensions,
  };
}

function codeLanguageFromExtensions(extensions: CanvasNode["extensions"]): string {
  const value = extensions?.["figma.code-block.language.v1"];
  return value?.length ? new TextDecoder().decode(Uint8Array.from(value)) : "PLAINTEXT";
}

function componentMetadataFromExtensions(extensions: CanvasNode["extensions"], key: string): NonNullable<CanvasNode["componentMetadata"]> {
  const bytes = extensions?.["figma.component.metadata.v1"];
  try {
    const value = bytes && JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))) as Partial<NonNullable<CanvasNode["componentMetadata"]>>;
    if (value && typeof value.key === "string" && typeof value.remote === "boolean" && typeof value.description === "string" && typeof value.descriptionMarkdown === "string" && Array.isArray(value.documentationLinks) && value.componentPropertyDefinitions && typeof value.componentPropertyDefinitions === "object") return value as NonNullable<CanvasNode["componentMetadata"]>;
  } catch { /* malformed forward data falls back to a local empty component */ }
  return { key, remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: {} };
}

function instanceMetadataFromExtensions(extensions: CanvasNode["extensions"]): CanvasNode["instanceMetadata"] {
  const bytes = extensions?.["figma.instance.metadata.v1"];
  try {
    const value = bytes && JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))) as Partial<NonNullable<CanvasNode["instanceMetadata"]>>;
    if (value && typeof value.mainComponentId === "string" && Number.isFinite(value.scaleFactor) && value.componentProperties && typeof value.componentProperties === "object" && Array.isArray(value.overrides) && typeof value.isExposedInstance === "boolean") return value as NonNullable<CanvasNode["instanceMetadata"]>;
  } catch { /* malformed forward data remains inspectable as an unlinked node */ }
  return undefined;
}

function slotMetadataFromExtensions(extensions: CanvasNode["extensions"]): CanvasNode["slotMetadata"] {
  const bytes = extensions?.["figma.slot.metadata.v1"];
  try {
    const value = bytes && JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))) as Partial<NonNullable<CanvasNode["slotMetadata"]>>;
    if (value && typeof value.propertyName === "string") return value as NonNullable<CanvasNode["slotMetadata"]>;
  } catch { /* malformed forward data is not a valid slot identity */ }
  return undefined;
}

function componentSetMetadataFromExtensions(extensions: CanvasNode["extensions"], key: string): NonNullable<CanvasNode["componentSetMetadata"]> {
  const bytes = extensions?.["figma.component-set.metadata.v1"];
  try {
    const value = bytes && JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))) as Partial<NonNullable<CanvasNode["componentSetMetadata"]>>;
    if (value && typeof value.key === "string" && typeof value.remote === "boolean" && typeof value.description === "string" && typeof value.descriptionMarkdown === "string" && Array.isArray(value.documentationLinks) && value.variantGroupProperties && typeof value.variantGroupProperties === "object") return value as NonNullable<CanvasNode["componentSetMetadata"]>;
  } catch { /* malformed forward metadata uses a safe local fallback */ }
  return { key, remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], variantGroupProperties: {} };
}

function connectorMetadataFromExtensions(extensions: CanvasNode["extensions"]): CanvasNode["connectorMetadata"] {
  const bytes = extensions?.["figma.connector.metadata.v1"];
  try {
    const value = bytes && JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))) as Partial<NonNullable<CanvasNode["connectorMetadata"]>>;
    if (value && ["ELBOWED", "STRAIGHT", "CURVED"].includes(value.lineType ?? "") && value.start && value.end && typeof value.text === "string") return value as NonNullable<CanvasNode["connectorMetadata"]>;
  } catch { /* malformed forward data remains an ordinary line */ }
  return undefined;
}

function embedMetadataFromExtensions(extensions: CanvasNode["extensions"]): CanvasNode["embedMetadata"] {
  const bytes = extensions?.["figma.embed.metadata.v1"];
  try {
    const value = bytes && JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))) as Partial<NonNullable<CanvasNode["embedMetadata"]>>;
    if (value && typeof value.srcUrl === "string" && [value.canonicalUrl, value.title, value.provider].every((entry) => entry === null || typeof entry === "string")) return value as NonNullable<CanvasNode["embedMetadata"]>;
  } catch { /* malformed forward data is not a valid embed */ }
  return undefined;
}

function highlightHandleMirroringFromExtensions(extensions: CanvasNode["extensions"]): CanvasNode["highlightHandleMirroring"] {
  const value = extensions?.["figma.highlight.handle-mirroring.v1"];
  const decoded = value && new TextDecoder().decode(Uint8Array.from(value));
  return decoded === "NONE" || decoded === "ANGLE" || decoded === "ANGLE_AND_LENGTH" ? decoded : undefined;
}

function interactiveSlideElementTypeFromExtensions(extensions: CanvasNode["extensions"]): CanvasNode["interactiveSlideElementType"] {
  const value = extensions?.["figma.interactive-slide-element.type.v1"];
  const decoded = value && new TextDecoder().decode(Uint8Array.from(value));
  return decoded === "POLL" || decoded === "EMBED" || decoded === "FACEPILE" || decoded === "ALIGNMENT" || decoded === "YOUTUBE" ? decoded : undefined;
}

function linkUnfurlMetadataFromExtensions(extensions: CanvasNode["extensions"]): CanvasNode["linkUnfurlMetadata"] {
  const bytes = extensions?.["figma.link-unfurl.metadata.v1"];
  try {
    const value = bytes && JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))) as Partial<NonNullable<CanvasNode["linkUnfurlMetadata"]>>;
    if (value && typeof value.url === "string" && [value.title, value.description, value.provider].every((entry) => entry === null || typeof entry === "string")) return value as NonNullable<CanvasNode["linkUnfurlMetadata"]>;
  } catch { /* malformed forward data is not a valid link unfurl */ }
  return undefined;
}

function mediaMetadataFromExtensions(extensions: CanvasNode["extensions"]): CanvasNode["mediaMetadata"] {
  const bytes = extensions?.["figma.media.metadata.v1"];
  try {
    const value = bytes && JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))) as Partial<NonNullable<CanvasNode["mediaMetadata"]>>;
    if (value && typeof value.hash === "string" && value.hash.length > 0) return value as NonNullable<CanvasNode["mediaMetadata"]>;
  } catch { /* malformed forward data is not valid MediaData */ }
  return undefined;
}

function shapeWithTextTypeFromExtensions(extensions: CanvasNode["extensions"]): CanvasNode["shapeWithTextType"] {
  const value = extensions?.["figma.shape-with-text.type.v1"];
  const decoded = value && new TextDecoder().decode(Uint8Array.from(value));
  return isShapeWithTextType(decoded) ? decoded : undefined;
}

function slideMetadataFromExtensions(extensions: CanvasNode["extensions"]): CanvasNode["slideMetadata"] {
  const bytes = extensions?.["figma.slide.metadata.v1"];
  try {
    const value = bytes && JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))) as Partial<NonNullable<CanvasNode["slideMetadata"]>>;
    const transition = value?.transition;
    if (value && typeof value.isSkippedSlide === "boolean" && transition && slideTransitionStyles.has(transition.style) && Number.isFinite(transition.duration) && transition.duration >= 0 && slideTransitionCurves.has(transition.curve) && (transition.timing?.type === "ON_CLICK" || transition.timing?.type === "AFTER_DELAY") && (transition.timing.delay === undefined || (Number.isFinite(transition.timing.delay) && transition.timing.delay >= 0))) return value as NonNullable<CanvasNode["slideMetadata"]>;
  } catch { /* malformed forward data is not a valid Slides transition */ }
  return undefined;
}

const slideTransitionStyles = new Set<NonNullable<CanvasNode["slideMetadata"]>["transition"]["style"]>(["NONE", "DISSOLVE", "SLIDE_FROM_LEFT", "SLIDE_FROM_RIGHT", "SLIDE_FROM_BOTTOM", "SLIDE_FROM_TOP", "PUSH_FROM_LEFT", "PUSH_FROM_RIGHT", "PUSH_FROM_BOTTOM", "PUSH_FROM_TOP", "MOVE_FROM_LEFT", "MOVE_FROM_RIGHT", "MOVE_FROM_TOP", "MOVE_FROM_BOTTOM", "SLIDE_OUT_TO_LEFT", "SLIDE_OUT_TO_RIGHT", "SLIDE_OUT_TO_TOP", "SLIDE_OUT_TO_BOTTOM", "MOVE_OUT_TO_LEFT", "MOVE_OUT_TO_RIGHT", "MOVE_OUT_TO_TOP", "MOVE_OUT_TO_BOTTOM", "SMART_ANIMATE"]);
const slideTransitionCurves = new Set<NonNullable<CanvasNode["slideMetadata"]>["transition"]["curve"]>(["EASE_IN", "EASE_OUT", "EASE_IN_AND_OUT", "LINEAR", "GENTLE", "QUICK", "BOUNCY", "SLOW"]);

function stickyMetadataFromExtensions(extensions: CanvasNode["extensions"]): CanvasNode["stickyMetadata"] {
  const bytes = extensions?.["figma.sticky.metadata.v1"];
  try {
    const value = bytes && JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))) as Partial<NonNullable<CanvasNode["stickyMetadata"]>>;
    if (value && typeof value.authorVisible === "boolean" && typeof value.authorName === "string" && typeof value.isWideWidth === "boolean") return value as NonNullable<CanvasNode["stickyMetadata"]>;
  } catch { /* malformed forward data is not valid Sticky metadata */ }
  return undefined;
}

function tableMetadataFromExtensions(extensions: CanvasNode["extensions"]): CanvasNode["tableMetadata"] {
  const bytes = extensions?.["figma.table.metadata.v1"];
  try { const value = bytes && JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))) as Partial<NonNullable<CanvasNode["tableMetadata"]>>; if (value && Array.isArray(value.rowHeights) && Array.isArray(value.columnWidths) && value.rowHeights.every((size) => Number.isFinite(size) && size > 0) && value.columnWidths.every((size) => Number.isFinite(size) && size > 0)) return value as NonNullable<CanvasNode["tableMetadata"]>; } catch { /* malformed table data */ }
  return undefined;
}
function tableCellMetadataFromExtensions(extensions: CanvasNode["extensions"]): CanvasNode["tableCellMetadata"] {
  const bytes = extensions?.["figma.table-cell.metadata.v1"];
  try { const value = bytes && JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))) as Partial<NonNullable<CanvasNode["tableCellMetadata"]>>; const rowIndex = value?.rowIndex, columnIndex = value?.columnIndex; if (typeof rowIndex === "number" && Number.isInteger(rowIndex) && rowIndex >= 0 && typeof columnIndex === "number" && Number.isInteger(columnIndex) && columnIndex >= 0) return value as NonNullable<CanvasNode["tableCellMetadata"]>; } catch { /* malformed cell data */ }
  return undefined;
}

function textPathMetadataFromExtensions(extensions: CanvasNode["extensions"]): CanvasNode["textPathMetadata"] {
  const bytes = extensions?.["figma.text-path.metadata.v1"];
  try { const value = bytes && JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))) as Partial<NonNullable<CanvasNode["textPathMetadata"]>>; const segment = value?.startSegment, position = value?.startPosition; if (value && typeof segment === "number" && Number.isInteger(segment) && segment >= 0 && typeof position === "number" && Number.isFinite(position) && position >= 0 && position <= 1 && typeof value.autoRename === "boolean" && ["LEFT", "CENTER", "RIGHT", "JUSTIFIED"].includes(value.textAlignHorizontal ?? "") && ["TOP", "CENTER", "BOTTOM"].includes(value.textAlignVertical ?? "")) return value as NonNullable<CanvasNode["textPathMetadata"]>; } catch { /* malformed text-path data */ }
  return undefined;
}

function transformModifiersFromExtensions(extensions: CanvasNode["extensions"]): CanvasNode["transformModifiers"] {
  const bytes = extensions?.["figma.transform-group.modifiers.v1"];
  try { const value = bytes && JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))); return validTransformModifiers(value) ? value : undefined; } catch { return undefined; }
}
function widgetMetadataFromExtensions(extensions: CanvasNode["extensions"]): CanvasNode["widgetMetadata"] {
  const bytes = extensions?.["figma.widget.metadata.v1"];
  try { const value = bytes && JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))) as Partial<NonNullable<CanvasNode["widgetMetadata"]>>; if (value && typeof value.widgetId === "string" && value.widgetId.length > 0 && value.syncedState && typeof value.syncedState === "object" && value.syncedMap && typeof value.syncedMap === "object") return value as NonNullable<CanvasNode["widgetMetadata"]>; } catch { /* malformed widget data */ }
  return undefined;
}
function validTransformModifiers(value: unknown): value is NonNullable<CanvasNode["transformModifiers"]> { return Array.isArray(value) && value.every((modifier) => modifier && typeof modifier === "object" && modifier.type === "REPEAT" && Number.isFinite(modifier.count) && modifier.count >= 1 && Number.isFinite(modifier.offset) && (modifier.unitType === "RELATIVE" || modifier.unitType === "PIXELS") && ((modifier.repeatType === "LINEAR" && (modifier.axis === "HORIZONTAL" || modifier.axis === "VERTICAL")) || modifier.repeatType === "RADIAL")); }
