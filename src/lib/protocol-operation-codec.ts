import {
  AckResult,
  ColorSpace,
  NodeKind,
  OperationEnvelope,
  ResolvedOperationBatch,
  TextAlignment,
  TextAutoSize,
  type Paint,
  type ResolvedOperation,
} from "@makefigma/protocol-types";
import { documentColorFromCssHex, type CanvasPage, type DocumentColor, type DocumentTextProperties } from "./editor-protocol";
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
  if (command.type === "delete") return command.ids.map((nodeId) => ({ deleteNode: { nodeId: idBytes(nodeId) } }));
  if (command.type === "reposition") return command.positionIds.map(({ id, positionId }) => {
    const [key, actorId] = positionBytes(positionId, id);
    return { setNodePosition: { nodeId: idBytes(id), positionId: { key, actorId } } };
  });
  const node = command.node;
  // An Inspector update is deliberately expanded into canonical leaf operations.
  // This avoids a second hand-written transport-only Node patch type. Commands
  // remain atomic because the enclosing ResolvedOperationBatch is one transaction.
  const operations: ResolvedOperation[] = [
    { updateGeometry: { nodeId: idBytes(node.id), x: node.x, y: node.y, width: node.width, height: node.height, rotation: node.rotation } },
    { renameNode: { nodeId: idBytes(node.id), name: node.name } },
    { setAppearance: { nodeId: idBytes(node.id), fill: paintProto(undefined, node.fillColor ?? colorFromCss(node.fill, OPAQUE_BLACK)), stroke: paintProto(undefined, node.strokeColor ?? colorFromCss(node.stroke, TRANSPARENT_BLACK)), strokeWidth: node.strokeWidth, opacity: node.opacity, cornerRadius: node.cornerRadius, visible: node.visible !== false, locked: Boolean(node.locked) } },
  ];
  if (node.kind !== "text") operations.push({ setImageFill: { nodeId: idBytes(node.id), assetId: node.assetId ? idBytes(node.assetId) : undefined } });
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
    nodeId: idBytes(node.id), pageId: idBytes(node.pageId ?? "00000000-0000-0000-0000-000000000001"), positionId: { key, actorId: actor }, name: node.name,
    kind: nodeKind(node.kind), x: node.x, y: node.y, width: node.width, height: node.height, rotation: node.rotation,
    fill: paintProto(node.fillGradient, node.fillColor ?? colorFromCss(node.fill, OPAQUE_BLACK)), stroke: paintProto(node.strokeGradient, node.strokeColor ?? colorFromCss(node.stroke, TRANSPARENT_BLACK)), strokeWidth: node.strokeWidth,
    opacity: node.opacity, cornerRadius: node.cornerRadius, text: node.text, visible: node.visible !== false, locked: Boolean(node.locked), assetId: node.assetId ? idBytes(node.assetId) : undefined,
  };
}

function paintProto(gradient: import("./editor-protocol").DocumentLinearGradient | undefined, solid: DocumentColor): Paint {
  if (gradient) return { linearGradient: { startX: gradient.start[0], startY: gradient.start[1], endX: gradient.end[0], endY: gradient.end[1], stops: gradient.stops.map((stop) => ({ position: stop.position, color: colorProto(stop.color) })) } };
  return { solid: colorProto(solid) };
}

function colorProto(color: DocumentColor) {
  return { space: color.space === "srgb" ? ColorSpace.COLOR_SPACE_SRGB : color.space === "display-p3" ? ColorSpace.COLOR_SPACE_DISPLAY_P3 : ColorSpace.COLOR_SPACE_LINEAR_SRGB, red: color.components[0], green: color.components[1], blue: color.components[2], alpha: color.alpha };
}
function textPropertiesProto(properties: DocumentTextProperties | undefined) {
  const value = properties ?? {
    runs: [],
    paragraph: { alignment: "left" as const, paragraphSpacing: 0 },
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
function nodeKind(kind: CoreProjectionNode["kind"]) { return kind === "frame" ? NodeKind.NODE_KIND_FRAME : kind === "rectangle" ? NodeKind.NODE_KIND_RECTANGLE : kind === "ellipse" ? NodeKind.NODE_KIND_ELLIPSE : kind === "text" ? NodeKind.NODE_KIND_TEXT : NodeKind.NODE_KIND_IMAGE; }
function positionBytes(positionId: string | undefined, fallback: string): [Uint8Array, Uint8Array] { const [key = fallback, actor = "00000000000000000000000000000000"] = positionId?.split(":") ?? []; return [idBytes(key), idBytes(actor)]; }
export function idBytes(value: string): Uint8Array { const normalized = value.replaceAll("-", "").toLowerCase(); if (!/^[0-9a-f]{32}$/.test(normalized)) throw new TypeError(`Expected a stable 128-bit identifier, received ${value}.`); return Uint8Array.from(normalized.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16))); }

function hashBytes(value: string) { if (!/^[0-9a-f]{64}$/i.test(value)) throw new TypeError("Expected a SHA-256 content hash."); return Uint8Array.from(value.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16))); }

export function ackResultName(value: AckResult) { return AckResult[value]; }
