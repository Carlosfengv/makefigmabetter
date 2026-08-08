import {
  AckResult,
  ColorSpace,
  NodeKind,
  StrokeCap as ProtoStrokeCap,
  StrokeJoin as ProtoStrokeJoin,
  StrokeAlign as ProtoStrokeAlign,
  ConstraintType as ProtoConstraintType,
  OperationEnvelope,
  ResolvedOperationBatch,
  TextAlignment,
  TextAutoSize,
  type Paint,
  type ResolvedOperation,
} from "@makefigma/protocol-types";
import { DEFAULT_TEXT_LINE_HEIGHT, documentColorFromCssHex, type CanvasPage, type DocumentColor, type DocumentConstraints, type DocumentPaint, type DocumentTextProperties } from "./editor-protocol";
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
  const payloadHash = new Uint8Array(await crypto.subtle.digest("SHA-256", payloadForHash.buffer));
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
  if (command.type === "create") {
    const operations: ResolvedOperation[] = [{ createNode: { node: nodeProto(command.node) } }];
    if (command.node.kind === "text" && command.node.textProperties) {
      operations.push({ setTextProperties: { nodeId: idBytes(command.node.id), properties: textPropertiesProto(command.node.textProperties) } });
    }
    return operations;
  }
  if (command.type === "restore") return [{ restoreNode: { node: nodeProto(command.node) } }];
  if (command.type === "delete") return command.ids.map((nodeId) => ({ deleteNode: { nodeId: idBytes(nodeId) } }));
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
    { setAppearance: { nodeId: idBytes(node.id), fill: paintProto(undefined, node.fillColor ?? colorFromCss(node.fill, OPAQUE_BLACK)), stroke: paintProto(undefined, node.strokeColor ?? colorFromCss(node.stroke, TRANSPARENT_BLACK)), fills: paintStack(node.fills), strokes: paintStack(node.strokes), strokeWidth: node.strokeWidth, strokeCapStart: strokeCap(node.strokeCapStart), strokeCapEnd: strokeCap(node.strokeCapEnd), strokeJoin: strokeJoin(node.strokeJoin), strokeMiterLimit: node.strokeMiterLimit ?? 10, strokeDashPattern: normalizedDashPattern(node.strokeDashPattern), strokeWeights: normalizedStrokeWeights(node.kind, node.strokeWeights), strokeAlign: strokeAlign(node.strokeAlign), arcData: arcData(node.kind, node.arcData), relativeTransform: relativeTransform(node.relativeTransform), opacity: node.opacity, cornerRadius: node.cornerRadius, cornerRadii: cornerRadii(node.kind, node.cornerRadii), cornerSmoothing: cornerSmoothing(node.kind, node.cornerSmoothing), constraints: constraints(node.constraints), visible: node.visible !== false, locked: Boolean(node.locked), contentsHidden: Boolean(node.contentsHidden), clipsContent: node.kind === "frame" ? node.clipsContent !== false : undefined } },
  ];
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
    fill: paintProto(node.fillGradient, node.fillColor ?? colorFromCss(node.fill, OPAQUE_BLACK)), stroke: paintProto(node.strokeGradient, node.strokeColor ?? colorFromCss(node.stroke, TRANSPARENT_BLACK)), fills: paintStack(node.fills), strokes: paintStack(node.strokes), strokeWidth: node.strokeWidth, strokeCapStart: strokeCap(node.strokeCapStart), strokeCapEnd: strokeCap(node.strokeCapEnd), strokeJoin: strokeJoin(node.strokeJoin), strokeMiterLimit: node.strokeMiterLimit ?? 10, strokeDashPattern: normalizedDashPattern(node.strokeDashPattern), strokeWeights: normalizedStrokeWeights(node.kind, node.strokeWeights), strokeAlign: strokeAlign(node.strokeAlign), arcData: arcData(node.kind, node.arcData), relativeTransform: relativeTransform(node.relativeTransform),
    opacity: node.opacity, cornerRadius: node.cornerRadius, cornerRadii: cornerRadii(node.kind, node.cornerRadii), cornerSmoothing: cornerSmoothing(node.kind, node.cornerSmoothing), constraints: constraints(node.constraints), text: node.text, visible: node.visible !== false, locked: Boolean(node.locked), contentsHidden: Boolean(node.contentsHidden), clipsContent: node.kind === "frame" ? node.clipsContent !== false : undefined, assetId: node.assetId ? idBytes(node.assetId) : undefined, extensions: extensionsProto(node.extensions),
  };
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
function colorFromCss(value: string, fallback: DocumentColor) { return documentColorFromCssHex(value) ?? fallback; }
function nodeKind(kind: CoreProjectionNode["kind"]) { return kind === "frame" ? NodeKind.NODE_KIND_FRAME : kind === "group" ? NodeKind.NODE_KIND_GROUP : kind === "section" ? NodeKind.NODE_KIND_SECTION : kind === "rectangle" ? NodeKind.NODE_KIND_RECTANGLE : kind === "ellipse" ? NodeKind.NODE_KIND_ELLIPSE : kind === "line" ? NodeKind.NODE_KIND_LINE : kind === "text" ? NodeKind.NODE_KIND_TEXT : NodeKind.NODE_KIND_IMAGE; }
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
  if (kind !== "frame" && kind !== "rectangle" && kind !== "section") throw new TypeError("Per-corner radii are only supported by Frame, Rectangle, and Section.");
  if (radii.length !== 4 || !radii.every((radius) => Number.isFinite(radius) && radius >= 0)) throw new TypeError("Corner radii must contain four finite, non-negative values.");
  return [...radii];
}
function cornerSmoothing(kind: CoreProjectionNode["kind"], smoothing: CoreProjectionNode["cornerSmoothing"]): number {
  if (kind !== "frame" && kind !== "rectangle" && kind !== "section") {
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
  if (kind !== "ellipse" || ![arc.startingAngle, arc.endingAngle, arc.innerRadius].every(Number.isFinite) || arc.innerRadius < 0 || arc.innerRadius >= 1) throw new TypeError("Arc data is only supported by Ellipse with an inner radius in [0, 1).");
  return arc;
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
