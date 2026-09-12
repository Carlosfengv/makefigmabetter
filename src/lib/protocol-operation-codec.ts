import {
  AckResult,
  BooleanOperation as ProtoBooleanOperation,
  BlendMode as ProtoBlendMode,
  ColorSpace,
  FillRule,
  NodeKind,
  StrokeCap as ProtoStrokeCap,
  StrokeJoin as ProtoStrokeJoin,
  StrokeAlign as ProtoStrokeAlign,
  ConstraintType as ProtoConstraintType,
  LayoutAlignment as ProtoLayoutAlignment,
  WrapTrackAlignment as ProtoWrapTrackAlignment,
  LayoutMode as ProtoLayoutMode,
  LayoutSizing as ProtoLayoutSizing,
  OperationEnvelope,
  ResolvedOperationBatch,
  TextAlignment,
  TextAutoSize,
  VectorPointType,
  type Paint,
  type ResolvedOperation,
} from "@makefigma/protocol-types";
import { DEFAULT_TEXT_LINE_HEIGHT, documentColorFromCssHex, type CanvasPage, type DocumentAutoLayout, type DocumentBooleanOperation, type DocumentColor, type DocumentConstraints, type DocumentDropShadow, type DocumentEffect, type DocumentPaint, type DocumentParametricShape, type DocumentTextProperties, type DocumentVectorPath } from "./editor-protocol";
import { sha256Bytes } from "./sha256";
import type { CoreBatchCommand, CoreProjectionNode } from "./transaction-batch";

export type ResourceRegistration = {
  assetId: string;
  contentHash: string;
  mediaType: string;
  byteLength: number;
  pixelWidth?: number;
  pixelHeight?: number;
};

export type EnvelopeIdentity = {
  documentId: string;
  operationId: string;
  transactionId: string;
  actorId: string;
  sessionId: string;
  clientSequence: bigint;
  baseRevision: bigint;
  engineSemanticsVersion: number;
};

/** Produces the generated Protobuf payload that the Rust Document Service maps
 * into the same editor-core command boundary used by the worker. */
export function encodeCoreBatchPayload(batch: readonly CoreBatchCommand[]): Uint8Array {
  const operations = batch.flatMap(operationForBatchCommand);
  if (!operations.length) throw new TypeError("A remote operation batch must not be empty.");
  return ResolvedOperationBatch.encode({ operations }).finish();
}

export async function encodeOperationEnvelope(identity: EnvelopeIdentity, batch: readonly CoreBatchCommand[]): Promise<Uint8Array> {
  return encodeOperationPayloadEnvelope(identity, encodeCoreBatchPayload(batch));
}

/** Encodes a pre-resolved payload without decoding or reconstructing it in the
 * transport layer. Page operations use this alongside node Core batches. */
export async function encodeOperationPayloadEnvelope(identity: EnvelopeIdentity, payload: Uint8Array): Promise<Uint8Array> {
  // Protobuf can be backed by a SharedArrayBuffer in worker contexts; WebCrypto's
  // browser overload deliberately accepts an owned ArrayBuffer only.
  const payloadForHash = new Uint8Array(payload);
  const payloadHash = await sha256Bytes(payloadForHash);
  return OperationEnvelope.encode({
    schemaVersion: 1,
    documentId: idBytes(identity.documentId),
    operationId: idBytes(identity.operationId),
    transactionId: idBytes(identity.transactionId),
    actorId: idBytes(identity.actorId),
    sessionId: idBytes(identity.sessionId),
    clientSequence: identity.clientSequence.toString(),
    baseRevision: identity.baseRevision.toString(),
    causalParentIds: [],
    payload,
    payloadHash,
    engineSemanticsVersion: identity.engineSemanticsVersion,
  }).finish();
}

export function encodeCreatePagePayload(page: CanvasPage): Uint8Array {
  const [key, actorId] = positionBytes(page.positionId, page.id);
  return ResolvedOperationBatch.encode({ operations: [{ createPage: { page: { pageId: idBytes(page.id), name: page.name, positionId: { key, actorId } } } }] }).finish();
}

/** Resource metadata is resolved only after the separate Asset API has admitted
 * the bytes and writer authorization has attached the AssetId to the document. */
export function encodeRegisterResourcePayload(resource: ResourceRegistration): Uint8Array {
  if (!Number.isSafeInteger(resource.byteLength) || resource.byteLength <= 0) throw new TypeError("Invalid resource byte length.");
  if ((resource.pixelWidth === undefined) !== (resource.pixelHeight === undefined)) throw new TypeError("Resource dimensions must be a pair.");
  return ResolvedOperationBatch.encode({ operations: [{ registerResource: { resource: {
    assetId: idBytes(resource.assetId), contentHash: hashBytes(resource.contentHash), mediaType: resource.mediaType,
    byteLength: resource.byteLength.toString(), pixelWidth: resource.pixelWidth, pixelHeight: resource.pixelHeight,
  } } }] }).finish();
}

function operationForBatchCommand(command: CoreBatchCommand): ResolvedOperation[] {
  if (command.type === "createPage") {
    const [key, actorId] = positionBytes(command.page.positionId, command.page.id);
    return [{ createPage: { page: { pageId: idBytes(command.page.id), name: command.page.name, positionId: { key, actorId } } } }];
  }
  if (command.type === "registerAsset") {
    const asset = command.asset;
    if ((asset.pixelWidth === undefined) !== (asset.pixelHeight === undefined)) throw new TypeError("Resource dimensions must be a pair.");
    return [{ registerResource: { resource: {
      assetId: idBytes(asset.assetId), contentHash: hashBytes(asset.contentHash), mediaType: asset.mediaType,
      byteLength: asset.byteLength.toString(), pixelWidth: asset.pixelWidth, pixelHeight: asset.pixelHeight,
    } } }];
  }
  if (command.type === "create") {
    const operations: ResolvedOperation[] = [{ createNode: { node: nodeProto(command.node) } }];
    const layout = autoLayoutOperation(command.node);
    if (layout) operations.push(layout);
    if (command.node.kind === "text" && command.node.textProperties) {
      operations.push({ setTextProperties: { nodeId: idBytes(command.node.id), properties: textPropertiesProto(command.node.textProperties) } });
    }
    return operations;
  }
  if (command.type === "restore") {
    const operations: ResolvedOperation[] = [{ restoreNode: { node: nodeProto(command.node) } }];
    if (command.node.isMask) operations.push({ setMask: { nodeId: idBytes(command.node.id), enabled: true } });
    const layout = autoLayoutOperation(command.node);
    if (layout) operations.push(layout);
    return operations;
  }
  if (command.type === "delete") return command.ids.map((nodeId) => ({ deleteNode: { nodeId: idBytes(nodeId) } }));
  if (command.type === "moveVectorPoint") return [{ moveVectorPoint: { nodeId: idBytes(command.id), pointId: idBytes(command.pointId), x: command.x, y: command.y } }];
  if (command.type === "setVectorSubpathClosed") return [{ setVectorSubpathClosed: { nodeId: idBytes(command.id), subpathIndex: command.subpathIndex, closed: command.closed } }];
  if (command.type === "insertVectorPoint") return [{ insertVectorPoint: { nodeId: idBytes(command.id), subpathIndex: command.subpathIndex, afterPointId: command.afterPointId ? idBytes(command.afterPointId) : undefined, point: vectorPointProto(command.point) } }];
  if (command.type === "splitVectorSegment") return [{ splitVectorSegment: { nodeId: idBytes(command.id), subpathIndex: command.subpathIndex, afterPointId: idBytes(command.afterPointId), t: command.t, pointId: idBytes(command.pointId) } }];
  if (command.type === "connectVectorEndpoints") return [{ connectVectorEndpoints: { nodeId: idBytes(command.id), firstSubpathIndex: command.firstSubpathIndex, firstPointId: idBytes(command.firstPointId), secondSubpathIndex: command.secondSubpathIndex, secondPointId: idBytes(command.secondPointId) } }];
  if (command.type === "setMask") return [{ setMask: { nodeId: idBytes(command.id), enabled: command.enabled } }];
  if (command.type === "setExtensions") return [{ setNodeExtensions: { nodeId: idBytes(command.id), extensions: extensionsProto(command.extensions) } }];
  if (command.type === "deleteVectorPoint") return [{ deleteVectorPoint: { nodeId: idBytes(command.id), pointId: idBytes(command.pointId) } }];
  if (command.type === "setVectorPointHandles") return [{ setVectorPointHandles: { nodeId: idBytes(command.id), pointId: idBytes(command.pointId), handleInX: command.handleIn?.x, handleInY: command.handleIn?.y, handleOutX: command.handleOut?.x, handleOutY: command.handleOut?.y, pointType: command.pointType === "corner" ? VectorPointType.VECTOR_POINT_TYPE_CORNER : command.pointType === "mirrored" ? VectorPointType.VECTOR_POINT_TYPE_MIRRORED : VectorPointType.VECTOR_POINT_TYPE_ASYMMETRIC } }];
  if (command.type === "reposition") return command.positionIds.map(({ id, positionId }) => {
    const [key, actorId] = positionBytes(positionId, id);
    return { setNodePosition: { nodeId: idBytes(id), positionId: { key, actorId } } };
  });
  if (command.type === "reparent") return command.parentIds.map(({ id, parentId, positionId }) => {
    const [key, actorId] = positionBytes(positionId, id);
    return { setNodeParent: { nodeId: idBytes(id), parentId: parentId ? idBytes(parentId) : undefined, positionId: { key, actorId } } };
  });
  const node = command.node;
  // An Inspector update is deliberately expanded into canonical leaf operations.
  // This avoids a second hand-written transport-only Node patch type. Commands
  // remain atomic because the enclosing ResolvedOperationBatch is one transaction.
  const operations: ResolvedOperation[] = [
    { updateGeometry: { nodeId: idBytes(node.id), x: node.x, y: node.y, width: node.width, height: node.height, rotation: node.rotation } },
    { renameNode: { nodeId: idBytes(node.id), name: node.name } },
    { setAppearance: { nodeId: idBytes(node.id), fill: paintProto(undefined, node.fillColor ?? colorFromCss(node.fill, OPAQUE_BLACK)), stroke: paintProto(undefined, node.strokeColor ?? colorFromCss(node.stroke, TRANSPARENT_BLACK)), fills: paintStack(node.fills), strokes: paintStack(node.strokes), strokeWidth: node.strokeWidth, strokeCapStart: strokeCap(node.strokeCapStart), strokeCapEnd: strokeCap(node.strokeCapEnd), strokeJoin: strokeJoin(node.strokeJoin), strokeMiterLimit: node.strokeMiterLimit ?? 10, strokeDashPattern: normalizedDashPattern(node.strokeDashPattern), strokeWeights: normalizedStrokeWeights(node.kind, node.strokeWeights), strokeAlign: strokeAlign(node.strokeAlign), arcData: arcData(node.kind, node.arcData), ...parametricShapeProto(node.kind, node.parametricShape), relativeTransform: relativeTransform(node.relativeTransform), opacity: node.opacity, blendMode: blendMode(node.blendMode), cornerRadius: node.cornerRadius, cornerRadii: cornerRadii(node.kind, node.cornerRadii), cornerSmoothing: cornerSmoothing(node.kind, node.cornerSmoothing), constraints: constraints(node.constraints), dropShadow: dropShadowProto(compatibilityDropShadow(node)), effectStack: effectStackProto(node.effectStack), visible: node.visible !== false, locked: Boolean(node.locked), contentsHidden: Boolean(node.contentsHidden), clipsContent: isFrameLike(node.kind) ? node.clipsContent !== false : undefined } },
  ];
  if (node.kind === "vector" || node.kind === "highlight" || node.kind === "textPath") operations.push({ setVectorPath: { nodeId: idBytes(node.id), vectorPath: vectorPathProto(node.kind, node.vectorPath) } });
  if (node.kind === "booleanOperation") {
    const operation = booleanOperationProto(node.kind, node.booleanOperation);
    if (operation === undefined) throw new TypeError("BooleanOperation nodes require an operation selector.");
    operations.push({ setBooleanOperation: { nodeId: idBytes(node.id), operation } });
  }
  const layout = autoLayoutOperation(node);
  if (layout) operations.push(layout);
  if (["frame", "rectangle", "ellipse", "image"].includes(node.kind)) operations.push({ setImageFill: { nodeId: idBytes(node.id), assetId: node.assetId ? idBytes(node.assetId) : undefined } });
  if (node.kind === "text") {
    operations.push(
      { setText: { nodeId: idBytes(node.id), text: node.text } },
      { setTextProperties: { nodeId: idBytes(node.id), properties: textPropertiesProto(node.textProperties) } },
    );
  }
  return operations;
}

function nodeProto(node: CoreProjectionNode) {
  const [key, actor] = positionBytes(node.positionId, node.id);
  return {
    nodeId: idBytes(node.id), parentId: node.parentId ? idBytes(node.parentId) : undefined, pageId: idBytes(node.pageId ?? "00000000-0000-0000-0000-000000000001"), positionId: { key, actorId: actor }, name: node.name,
    kind: nodeKind(node.kind), x: node.x, y: node.y, width: node.width, height: node.height, rotation: node.rotation,
    fill: paintProto(node.fillGradient, node.fillColor ?? colorFromCss(node.fill, OPAQUE_BLACK)), stroke: paintProto(node.strokeGradient, node.strokeColor ?? colorFromCss(node.stroke, TRANSPARENT_BLACK)), fills: paintStack(node.fills), strokes: paintStack(node.strokes), strokeWidth: node.strokeWidth, strokeCapStart: strokeCap(node.strokeCapStart), strokeCapEnd: strokeCap(node.strokeCapEnd), strokeJoin: strokeJoin(node.strokeJoin), strokeMiterLimit: node.strokeMiterLimit ?? 10, strokeDashPattern: normalizedDashPattern(node.strokeDashPattern), strokeWeights: normalizedStrokeWeights(node.kind, node.strokeWeights), strokeAlign: strokeAlign(node.strokeAlign), arcData: arcData(node.kind, node.arcData), ...parametricShapeProto(node.kind, node.parametricShape), vectorPath: node.kind === "vector" || node.kind === "highlight" || node.kind === "textPath" ? vectorPathProto(node.kind, node.vectorPath) : undefined, booleanOperation: booleanOperationProto(node.kind, node.booleanOperation), relativeTransform: relativeTransform(node.relativeTransform),
    opacity: node.opacity, blendMode: blendMode(node.blendMode), cornerRadius: node.cornerRadius, cornerRadii: cornerRadii(node.kind, node.cornerRadii), cornerSmoothing: cornerSmoothing(node.kind, node.cornerSmoothing), constraints: constraints(node.constraints), autoLayout: autoLayoutProto(node.autoLayout), dropShadow: dropShadowProto(compatibilityDropShadow(node)), effectStack: effectStackProto(node.effectStack), text: node.text, visible: node.visible !== false, locked: Boolean(node.locked), contentsHidden: Boolean(node.contentsHidden), clipsContent: isFrameLike(node.kind) ? node.clipsContent !== false : undefined, assetId: node.assetId ? idBytes(node.assetId) : undefined, extensions: extensionsProto(node.extensions), reactions: [], prototypeMetadata: undefined,
  };
}

function autoLayoutOperation(node: CoreProjectionNode): ResolvedOperation | undefined {
  // A non-Frame node uses this record for its relationship to a parent Auto
  // Layout Frame (`absolute`, sizing and `alignSelf`).  Omitting it made a
  // browser-local alignment look committed while the durable operation silently
  // discarded that child-specific semantic.
  if (node.kind !== "frame" && !node.autoLayout) return undefined;
  return { setAutoLayout: { nodeId: idBytes(node.id), autoLayout: autoLayoutProto(node.autoLayout) } };
}

function blendMode(value: CoreProjectionNode["blendMode"]): ProtoBlendMode {
  return value === "multiply" ? ProtoBlendMode.BLEND_MODE_MULTIPLY : value === "screen" ? ProtoBlendMode.BLEND_MODE_SCREEN : value === "overlay" ? ProtoBlendMode.BLEND_MODE_OVERLAY : value === "darken" ? ProtoBlendMode.BLEND_MODE_DARKEN : value === "lighten" ? ProtoBlendMode.BLEND_MODE_LIGHTEN : ProtoBlendMode.BLEND_MODE_NORMAL;
}

function autoLayoutProto(layout: DocumentAutoLayout | undefined) {
  const value = layout ?? { mode: "none", padding: [0, 0, 0, 0] as [number, number, number, number], itemSpacing: 0, wrap: false, primaryAlignment: "start", counterAlignment: "start", primarySizing: "fixed", counterSizing: "fixed", absolute: false };
  // Rust/WASM serializes absent optional bounds as JSON `null`. The generated
  // Proto encoder treats `null` as present and coerces it to 0, which makes a
  // Frame's maximum size zero on the next Auto Layout operation. Keep actual
  // zero-valued bounds, but omit non-numeric hydration sentinels.
  const bound = (candidate: unknown) => typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 ? candidate : undefined;
  return {
    mode: value.mode === "horizontal" ? ProtoLayoutMode.LAYOUT_MODE_HORIZONTAL : value.mode === "vertical" ? ProtoLayoutMode.LAYOUT_MODE_VERTICAL : ProtoLayoutMode.LAYOUT_MODE_NONE,
    paddingTop: value.padding[0], paddingRight: value.padding[1], paddingBottom: value.padding[2], paddingLeft: value.padding[3], itemSpacing: value.itemSpacing, trackSpacing: bound(value.trackSpacing), wrapTrackAlignment: value.trackAlignment === "spaceBetween" ? ProtoWrapTrackAlignment.WRAP_TRACK_ALIGNMENT_SPACE_BETWEEN : undefined, wrap: value.wrap,
    primaryAlignment: layoutAlignment(value.primaryAlignment), counterAlignment: layoutAlignment(value.counterAlignment),
    primarySizing: layoutSizing(value.primarySizing), counterSizing: layoutSizing(value.counterSizing),
    minWidth: bound(value.minWidth), maxWidth: bound(value.maxWidth), minHeight: bound(value.minHeight), maxHeight: bound(value.maxHeight), absolute: value.absolute,
    alignSelf: value.alignSelf ? layoutAlignment(value.alignSelf) : undefined,
  };
}

function layoutAlignment(value: DocumentAutoLayout["primaryAlignment"]): ProtoLayoutAlignment {
  return value === "center" ? ProtoLayoutAlignment.LAYOUT_ALIGNMENT_CENTER : value === "end" ? ProtoLayoutAlignment.LAYOUT_ALIGNMENT_END : value === "spaceBetween" ? ProtoLayoutAlignment.LAYOUT_ALIGNMENT_SPACE_BETWEEN : value === "baseline" ? ProtoLayoutAlignment.LAYOUT_ALIGNMENT_BASELINE : ProtoLayoutAlignment.LAYOUT_ALIGNMENT_START;
}

function layoutSizing(value: DocumentAutoLayout["primarySizing"]): ProtoLayoutSizing {
  return value === "hug" ? ProtoLayoutSizing.LAYOUT_SIZING_HUG : value === "fill" ? ProtoLayoutSizing.LAYOUT_SIZING_FILL : ProtoLayoutSizing.LAYOUT_SIZING_FIXED;
}

/** Forward-compatibility payloads are passed through verbatim so the durable
 * Protobuf boundary preserves bytes owned by newer engine versions (P0-2). The
 * JSON projection encodes each Rust `Vec<u8>` as a number array. */
function extensionsProto(extensions: CoreProjectionNode["extensions"]): { [key: string]: Uint8Array } {
  const map: { [key: string]: Uint8Array } = {};
  if (!extensions) return map;
  for (const [key, value] of Object.entries(extensions)) map[key] = Uint8Array.from(value);
  return map;
}

function paintProto(gradient: import("./editor-protocol").DocumentLinearGradient | undefined, solid: DocumentColor): Paint {
  if (gradient) return { linearGradient: { startX: gradient.start[0], startY: gradient.start[1], endX: gradient.end[0], endY: gradient.end[1], stops: gradient.stops.map((stop) => ({ position: stop.position, color: colorProto(stop.color) })) } };
  return { solid: colorProto(solid) };
}
function paintStack(stack: readonly DocumentPaint[] | undefined): Paint[] {
  if (!stack?.length) return [];
  if (stack.length > 16) throw new TypeError("Paint stacks support at most 16 layers.");
  return stack.map((paint) => {
    if (paint.gradient) return paintProto(paint.gradient, paint.color ?? OPAQUE_BLACK);
    return paintProto(undefined, paint.color ?? colorFromCss(paint.css, OPAQUE_BLACK));
  });
}

function colorProto(color: DocumentColor) {
  return { space: color.space === "srgb" ? ColorSpace.COLOR_SPACE_SRGB : color.space === "display-p3" ? ColorSpace.COLOR_SPACE_DISPLAY_P3 : ColorSpace.COLOR_SPACE_LINEAR_SRGB, red: color.components[0], green: color.components[1], blue: color.components[2], alpha: color.alpha };
}
function dropShadowProto(shadow: DocumentDropShadow | undefined) {
  if (!shadow) return undefined;
  return { offsetX: shadow.offsetX, offsetY: shadow.offsetY, blurRadius: shadow.blurRadius, spread: shadow.spread, color: colorProto(shadow.color), visible: shadow.visible };
}
function effectStackProto(stack: readonly DocumentEffect[] | undefined) {
  if (!stack?.length) return [];
  if (stack.length > 8) throw new TypeError("Effect stacks support at most 8 entries.");
  return stack.map((effect) => effect.dropShadow
    ? { dropShadow: dropShadowProto(effect.dropShadow) }
    : effect.layerBlur
      ? { layerBlur: { radius: effect.layerBlur.radius, visible: effect.layerBlur.visible } }
      : effect.innerShadow
        ? { innerShadow: dropShadowProto(effect.innerShadow) }
        : { backgroundBlur: { radius: effect.backgroundBlur.radius, visible: effect.backgroundBlur.visible } });
}
function compatibilityDropShadow(node: CoreProjectionNode) {
  return node.effectStack?.[0]?.dropShadow ?? node.dropShadow;
}
function textPropertiesProto(properties: DocumentTextProperties | undefined) {
  const value = properties ?? {
    runs: [],
    paragraph: { alignment: "left" as const, lineHeight: DEFAULT_TEXT_LINE_HEIGHT, paragraphSpacing: 0 },
    autoSize: "fixed" as const,
    fallbackFonts: [],
  };
  return {
    runs: value.runs.map((run) => ({
      start: run.start, end: run.end,
      font: run.font ? fontProto(run.font) : undefined,
      fontSize: run.fontSize, fontWeight: run.fontWeight, italic: run.italic, letterSpacing: run.letterSpacing,
    })),
    paragraph: {
      alignment: value.paragraph.alignment === "left" ? TextAlignment.TEXT_ALIGNMENT_LEFT : value.paragraph.alignment === "center" ? TextAlignment.TEXT_ALIGNMENT_CENTER : value.paragraph.alignment === "right" ? TextAlignment.TEXT_ALIGNMENT_RIGHT : TextAlignment.TEXT_ALIGNMENT_JUSTIFY,
      // JSON snapshots represent Rust's Option::None as null. Protobuf must
      // preserve that absence rather than materializing an invalid zero height.
      lineHeight: typeof value.paragraph.lineHeight === "number" ? value.paragraph.lineHeight : undefined,
      paragraphSpacing: value.paragraph.paragraphSpacing,
    },
    autoSize: value.autoSize === "fixed" ? TextAutoSize.TEXT_AUTO_SIZE_FIXED : value.autoSize === "height" ? TextAutoSize.TEXT_AUTO_SIZE_HEIGHT : TextAutoSize.TEXT_AUTO_SIZE_WIDTH_AND_HEIGHT,
    fallbackFonts: (value.fallbackFonts ?? []).map(fontProto),
  };
}
function fontProto(font: NonNullable<DocumentTextProperties["runs"][number]["font"]>) {
  return { assetId: idBytes(font.assetId), faceIndex: font.faceIndex, variationAxes: (font.variationAxes ?? []).map((axis) => ({ tag: axis.tag, value: axis.value })) };
}
const OPAQUE_BLACK: DocumentColor = { space: "srgb", components: [0, 0, 0], alpha: 1 };
const TRANSPARENT_BLACK: DocumentColor = { space: "srgb", components: [0, 0, 0], alpha: 0 };
function colorFromCss(value: string, fallback: DocumentColor) {
  // `transparent` is a first-class Canvas projection value, not hex syntax.
  // Treating it as the caller's fallback made non-painting structural nodes
  // (and Slice) turn into opaque black over the remote Protobuf boundary.
  if (value === "transparent") return TRANSPARENT_BLACK;
  return documentColorFromCssHex(value) ?? fallback;
}
function nodeKind(kind: CoreProjectionNode["kind"]) { return kind === "frame" ? NodeKind.NODE_KIND_FRAME : kind === "component" ? NodeKind.NODE_KIND_COMPONENT : kind === "componentSet" ? NodeKind.NODE_KIND_COMPONENT_SET : kind === "instance" ? NodeKind.NODE_KIND_INSTANCE : kind === "slot" ? NodeKind.NODE_KIND_SLOT : kind === "connector" ? NodeKind.NODE_KIND_CONNECTOR : kind === "embed" ? NodeKind.NODE_KIND_EMBED : kind === "highlight" ? NodeKind.NODE_KIND_HIGHLIGHT : kind === "interactiveSlideElement" ? NodeKind.NODE_KIND_INTERACTIVE_SLIDE_ELEMENT : kind === "linkUnfurl" ? NodeKind.NODE_KIND_LINK_UNFURL : kind === "media" ? NodeKind.NODE_KIND_MEDIA : kind === "shapeWithText" ? NodeKind.NODE_KIND_SHAPE_WITH_TEXT : kind === "slideGrid" ? NodeKind.NODE_KIND_SLIDE_GRID : kind === "slide" ? NodeKind.NODE_KIND_SLIDE : kind === "slideRow" ? NodeKind.NODE_KIND_SLIDE_ROW : kind === "stamp" ? NodeKind.NODE_KIND_STAMP : kind === "sticky" ? NodeKind.NODE_KIND_STICKY : kind === "table" ? NodeKind.NODE_KIND_TABLE : kind === "tableCell" ? NodeKind.NODE_KIND_TABLE_CELL : kind === "textPath" ? NodeKind.NODE_KIND_TEXT_PATH : kind === "transformGroup" ? NodeKind.NODE_KIND_TRANSFORM_GROUP : kind === "washiTape" ? NodeKind.NODE_KIND_WASHI_TAPE : kind === "widget" ? NodeKind.NODE_KIND_WIDGET : kind === "group" ? NodeKind.NODE_KIND_GROUP : kind === "section" ? NodeKind.NODE_KIND_SECTION : kind === "rectangle" ? NodeKind.NODE_KIND_RECTANGLE : kind === "ellipse" ? NodeKind.NODE_KIND_ELLIPSE : kind === "polygon" ? NodeKind.NODE_KIND_POLYGON : kind === "star" ? NodeKind.NODE_KIND_STAR : kind === "vector" ? NodeKind.NODE_KIND_VECTOR : kind === "booleanOperation" ? NodeKind.NODE_KIND_BOOLEAN_OPERATION : kind === "slice" ? NodeKind.NODE_KIND_SLICE : kind === "line" ? NodeKind.NODE_KIND_LINE : kind === "text" ? NodeKind.NODE_KIND_TEXT : kind === "codeBlock" ? NodeKind.NODE_KIND_CODE_BLOCK : NodeKind.NODE_KIND_IMAGE; }
function isFrameLike(kind: CoreProjectionNode["kind"]) { return kind === "frame" || kind === "component" || kind === "componentSet" || kind === "instance" || kind === "slot"; }
function strokeCap(value: CoreProjectionNode["strokeCapStart"]) { return value === "round" ? ProtoStrokeCap.STROKE_CAP_ROUND : value === "square" ? ProtoStrokeCap.STROKE_CAP_SQUARE : value === "arrowLines" ? ProtoStrokeCap.STROKE_CAP_ARROW_LINES : value === "arrowEquilateral" ? ProtoStrokeCap.STROKE_CAP_ARROW_EQUILATERAL : value === "diamondFilled" ? ProtoStrokeCap.STROKE_CAP_DIAMOND_FILLED : value === "triangleFilled" ? ProtoStrokeCap.STROKE_CAP_TRIANGLE_FILLED : value === "circleFilled" ? ProtoStrokeCap.STROKE_CAP_CIRCLE_FILLED : ProtoStrokeCap.STROKE_CAP_NONE; }
function strokeJoin(value: CoreProjectionNode["strokeJoin"]) { return value === "bevel" ? ProtoStrokeJoin.STROKE_JOIN_BEVEL : value === "round" ? ProtoStrokeJoin.STROKE_JOIN_ROUND : ProtoStrokeJoin.STROKE_JOIN_MITER; }
function strokeAlign(value: CoreProjectionNode["strokeAlign"]) { return value === "center" ? ProtoStrokeAlign.STROKE_ALIGN_CENTER : value === "outside" ? ProtoStrokeAlign.STROKE_ALIGN_OUTSIDE : ProtoStrokeAlign.STROKE_ALIGN_INSIDE; }
function constraints(value: DocumentConstraints | undefined) {
  if (!value) return undefined;
  const axis = (item: DocumentConstraints["horizontal"]) => item === "min" ? ProtoConstraintType.CONSTRAINT_TYPE_MIN : item === "center" ? ProtoConstraintType.CONSTRAINT_TYPE_CENTER : item === "max" ? ProtoConstraintType.CONSTRAINT_TYPE_MAX : item === "stretch" ? ProtoConstraintType.CONSTRAINT_TYPE_STRETCH : item === "scale" ? ProtoConstraintType.CONSTRAINT_TYPE_SCALE : (() => { throw new TypeError("Invalid Frame constraint."); })();
  return { horizontal: axis(value.horizontal), vertical: axis(value.vertical) };
}
function normalizedDashPattern(pattern: readonly number[] | undefined): number[] {
  if (!pattern?.length) return [];
  if (!pattern.every((segment) => Number.isFinite(segment) && segment >= 0) || !pattern.some((segment) => segment > 0)) throw new TypeError("Stroke dash pattern must contain finite, non-negative lengths and at least one positive length.");
  return pattern.length % 2 === 0 ? [...pattern] : [...pattern, ...pattern];
}
function cornerRadii(kind: CoreProjectionNode["kind"], radii: CoreProjectionNode["cornerRadii"]): number[] {
  if (!radii) return [];
  if (!isFrameLike(kind) && kind !== "rectangle" && kind !== "section") throw new TypeError("Per-corner radii are only supported by Frame, Component, Rectangle, and Section.");
  if (radii.length !== 4 || !radii.every((radius) => Number.isFinite(radius) && radius >= 0)) throw new TypeError("Corner radii must contain four finite, non-negative values.");
  return [...radii];
}
function cornerSmoothing(kind: CoreProjectionNode["kind"], smoothing: CoreProjectionNode["cornerSmoothing"]): number {
  if (!isFrameLike(kind) && kind !== "rectangle" && kind !== "section") {
    // Core canonically projects absent scalar fields as zero. Group, Line and
    // Ellipse do not expose corner smoothing in Figma, so that canonical zero
    // means “not set”, rather than an invalid attempt to configure the node.
    if (smoothing === undefined || smoothing === 0) return 0;
    throw new TypeError("Corner smoothing is only supported by Frame, Rectangle, and Section.");
  }
  if (smoothing === undefined) return 0;
  if (!Number.isFinite(smoothing) || smoothing < 0 || smoothing > 1) throw new TypeError("Corner smoothing must be a finite value between 0 and 1.");
  return smoothing;
}
function normalizedStrokeWeights(kind: CoreProjectionNode["kind"], weights: CoreProjectionNode["strokeWeights"]): number[] {
  if (!weights) return [];
  if (kind !== "frame" && kind !== "rectangle") throw new TypeError("Per-side stroke weights are only supported by Frame and Rectangle.");
  if (weights.length !== 4 || !weights.every((weight) => Number.isFinite(weight) && weight >= 0)) throw new TypeError("Stroke weights must contain four finite, non-negative values.");
  return [...weights];
}
function arcData(kind: CoreProjectionNode["kind"], arc: CoreProjectionNode["arcData"]) {
  if (!arc) return undefined;
  if (kind !== "ellipse" || ![arc.startingAngle, arc.endingAngle, arc.innerRadius].every(Number.isFinite) || arc.innerRadius < 0 || arc.innerRadius > 1) throw new TypeError("Arc data is only supported by Ellipse with an inner radius in [0, 1].");
  return arc;
}
function parametricShapeProto(kind: CoreProjectionNode["kind"], shape: DocumentParametricShape | undefined) {
  if (kind === "polygon") {
    if (!shape || shape.kind !== "polygon" || !Number.isInteger(shape.pointCount) || shape.pointCount < 3 || shape.pointCount > 100) throw new TypeError("Polygon requires an integer point count from 3 to 100.");
    return { polygonParameters: { pointCount: shape.pointCount }, starParameters: undefined };
  }
  if (kind === "star") {
    if (!shape || shape.kind !== "star" || !Number.isInteger(shape.pointCount) || shape.pointCount < 3 || shape.pointCount > 100 || !Number.isFinite(shape.innerRatio) || shape.innerRatio < 0.05 || shape.innerRatio > 0.95) throw new TypeError("Star requires 3–100 points and an inner ratio from 0.05 to 0.95.");
    return { polygonParameters: undefined, starParameters: { pointCount: shape.pointCount, innerRatio: shape.innerRatio } };
  }
  if (shape) throw new TypeError("Parametric shape data is only supported by Polygon and Star.");
  return { polygonParameters: undefined, starParameters: undefined };
}
function vectorPathProto(kind: CoreProjectionNode["kind"], path: DocumentVectorPath | undefined) {
  if ((kind !== "vector" && kind !== "highlight" && kind !== "textPath") || !path || (path.fillRule !== "nonZero" && path.fillRule !== "evenOdd") || path.subpaths.length > 64) throw new TypeError("Vector, Highlight, and TextPath require a valid canonical path.");
  let totalPoints = 0;
  const pointIds = new Set<string>();
  const subpaths = path.subpaths.map((subpath) => {
    if (!subpath.points.length || (subpath.closed && subpath.points.length < 3)) throw new TypeError("Vector subpaths must contain points; closed paths require three.");
    if (subpath.points.some((point, index) => index > 0 && point.x === subpath.points[index - 1].x && point.y === subpath.points[index - 1].y) || (subpath.closed && subpath.points.length > 1 && subpath.points[0].x === subpath.points[subpath.points.length - 1].x && subpath.points[0].y === subpath.points[subpath.points.length - 1].y)) throw new TypeError("Vector paths cannot contain degenerate segments.");
    totalPoints += subpath.points.length;
    return { closed: subpath.closed, points: subpath.points.map((point) => {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(point.id) || pointIds.has(point.id) || ![point.x, point.y, point.handleIn?.x, point.handleIn?.y, point.handleOut?.x, point.handleOut?.y].every((value) => value === undefined || Number.isFinite(value))) throw new TypeError("Vector points must have unique finite coordinates.");
      pointIds.add(point.id);
      if (!point.pointType || !["corner", "mirrored", "asymmetric"].includes(point.pointType)) throw new TypeError("Invalid vector point type.");
      return { pointId: idBytes(point.id), x: point.x, y: point.y, handleInX: point.handleIn?.x, handleInY: point.handleIn?.y, handleOutX: point.handleOut?.x, handleOutY: point.handleOut?.y, pointType: point.pointType === "corner" ? VectorPointType.VECTOR_POINT_TYPE_CORNER : point.pointType === "mirrored" ? VectorPointType.VECTOR_POINT_TYPE_MIRRORED : VectorPointType.VECTOR_POINT_TYPE_ASYMMETRIC };
    }) };
  });
  if (totalPoints > 8192) throw new TypeError("Vector paths support at most 8192 points.");
  return { fillRule: path.fillRule === "nonZero" ? FillRule.FILL_RULE_NON_ZERO : FillRule.FILL_RULE_EVEN_ODD, subpaths };
}
function booleanOperationProto(kind: CoreProjectionNode["kind"], operation: DocumentBooleanOperation | undefined) {
  if (kind !== "booleanOperation") {
    if (operation) throw new TypeError("Boolean operation data is only supported by BooleanOperation nodes.");
    return undefined;
  }
  if (operation === "union") return ProtoBooleanOperation.BOOLEAN_OPERATION_UNION;
  if (operation === "intersect") return ProtoBooleanOperation.BOOLEAN_OPERATION_INTERSECT;
  if (operation === "subtract") return ProtoBooleanOperation.BOOLEAN_OPERATION_SUBTRACT;
  if (operation === "exclude") return ProtoBooleanOperation.BOOLEAN_OPERATION_EXCLUDE;
  throw new TypeError("BooleanOperation requires a canonical operation.");
}
function vectorPointProto(point: DocumentVectorPath["subpaths"][number]["points"][number]) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(point.id) || ![point.x, point.y, point.handleIn?.x, point.handleIn?.y, point.handleOut?.x, point.handleOut?.y].every((value) => value === undefined || Number.isFinite(value))) throw new TypeError("Vector points must have finite coordinates.");
  if (!point.pointType || !["corner", "mirrored", "asymmetric"].includes(point.pointType)) throw new TypeError("Invalid vector point type.");
  return { pointId: idBytes(point.id), x: point.x, y: point.y, handleInX: point.handleIn?.x, handleInY: point.handleIn?.y, handleOutX: point.handleOut?.x, handleOutY: point.handleOut?.y, pointType: point.pointType === "corner" ? VectorPointType.VECTOR_POINT_TYPE_CORNER : point.pointType === "mirrored" ? VectorPointType.VECTOR_POINT_TYPE_MIRRORED : VectorPointType.VECTOR_POINT_TYPE_ASYMMETRIC };
}
function relativeTransform(transform: CoreProjectionNode["relativeTransform"]) {
  if (!transform) return undefined;
  if (![transform.a, transform.b, transform.c, transform.d, transform.e, transform.f].every(Number.isFinite) || Math.abs(transform.a * transform.d - transform.b * transform.c) <= 1e-12) throw new TypeError("Relative transform must be finite and invertible.");
  return transform;
}
function positionBytes(positionId: string | undefined, fallback: string): [Uint8Array, Uint8Array] { const [key = fallback, actor = "00000000000000000000000000000000"] = positionId?.split(":") ?? []; return [idBytes(key), idBytes(actor)]; }
export function idBytes(value: string): Uint8Array { const normalized = value.replaceAll("-", "").toLowerCase(); if (!/^[0-9a-f]{32}$/.test(normalized)) throw new TypeError(`Expected a stable 128-bit identifier, received ${value}.`); return Uint8Array.from(normalized.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16))); }

function hashBytes(value: string) { if (!/^[0-9a-f]{64}$/i.test(value)) throw new TypeError("Expected a SHA-256 content hash."); return Uint8Array.from(value.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16))); }

export function ackResultName(value: AckResult) { return AckResult[value]; }
