import type { CanvasNode, DocumentAsset, EditorClipboard } from "./editor-protocol";
import { sha256Hex } from "./sha256";

/** Stable, browser-transferable envelope. It never includes resource bytes. */
export const NODE_CLIPBOARD_FORMAT = "makefigma-node-clipboard-v1" as const;
export const MAX_CLIPBOARD_NODES = 10_000;
export const MAX_CLIPBOARD_DEPTH = 128;
export const MAX_CLIPBOARD_BYTES = 8 * 1024 * 1024;

export type NodeClipboardPayload = Readonly<{
  format: typeof NODE_CLIPBOARD_FORMAT;
  schemaVersion: number;
  sourceDocumentId: string;
  sourcePageId?: string;
  rootIds: string[];
  nodes: CanvasNode[];
  // v1 originally contained just `assetId` and `contentHash`. Newer writers
  // append resource metadata so an authorized destination can register it.
  // Keep accepting the old authenticated envelope rather than repurposing the
  // protocol version into a breaking change.
  assets: Array<Pick<DocumentAsset, "assetId" | "contentHash"> & Partial<Omit<DocumentAsset, "assetId" | "contentHash">>>;
  fonts: Array<{ assetId: string; contentHash: string; faceIndex: number }>;
  payloadSha256: string;
}>;

export type ClipboardValidationFailure =
  | "INVALID_FORMAT"
  | "UNSUPPORTED_SCHEMA"
  | "INVALID_HASH"
  | "RESOURCE_LIMIT"
  | "INVALID_TREE";

/** Validates the in-memory projection before it can become a Core create batch.
 * This deliberately performs no recovery: invalid clipboard input must leave
 * selection, history and the document untouched. */
export function validateClipboardCapture(clipboard: EditorClipboard, expectedSchemaVersion?: number): ClipboardValidationFailure | undefined {
  // `expectedSchemaVersion` is the newest schema the destination understands,
  // not an equality constraint. A newer document must remain able to paste a
  // signed older envelope; only a source from the future is unsafe to accept.
  if (!Number.isSafeInteger(clipboard.schemaVersion) || clipboard.schemaVersion < 1 || (expectedSchemaVersion !== undefined && clipboard.schemaVersion > expectedSchemaVersion)) return "UNSUPPORTED_SCHEMA";
  if (!clipboard.rootIds.length || clipboard.rootIds.length > MAX_CLIPBOARD_NODES || clipboard.nodes.length > MAX_CLIPBOARD_NODES || jsonBytes(clipboard) > MAX_CLIPBOARD_BYTES) return "RESOURCE_LIMIT";
  if (new Set(clipboard.rootIds).size !== clipboard.rootIds.length || new Set(clipboard.nodes.map((node) => node.id)).size !== clipboard.nodes.length) return "INVALID_TREE";

  const rootIds = new Set(clipboard.rootIds);
  const seen = new Set<string>();
  const depthById = new Map<string, number>();
  for (const node of clipboard.nodes) {
    if (!isNodeProjection(node) || seen.has(node.id)) return "INVALID_TREE";
    const isRoot = rootIds.has(node.id);
    const parentDepth = node.parentId ? depthById.get(node.parentId) : undefined;
    // Roots are allowed to retain an original parent outside the capture: paste
    // deliberately re-homes them to the target. Every non-root must instead
    // point to an already captured parent, preserving parent-before-child order.
    if ((isRoot && node.parentId && (node.parentId === node.id || depthById.has(node.parentId))) || (!isRoot && parentDepth === undefined)) return "INVALID_TREE";
    const depth = isRoot ? 1 : parentDepth! + 1;
    if (depth > MAX_CLIPBOARD_DEPTH) return "RESOURCE_LIMIT";
    depthById.set(node.id, depth);
    seen.add(node.id);
  }
  if (clipboard.rootIds.some((id) => !seen.has(id))) return "INVALID_TREE";
  const capturedIds = new Set(clipboard.nodes.map((node) => node.id));
  if (clipboard.nodes.some((node) => rootIds.has(node.id) && node.parentId && capturedIds.has(node.parentId))) return "INVALID_TREE";
  const actualAssetIds = [...new Set(clipboard.nodes.flatMap((node) => [
    ...(node.kind === "image" && node.assetId ? [node.assetId] : []),
    ...(node.fillStack?.layers.flatMap((layer) => layer.image ? [layer.image.assetId] : []) ?? []),
    ...(node.strokeStack?.layers.flatMap((layer) => layer.image ? [layer.image.assetId] : []) ?? []),
    ...(node.textProperties?.runs.flatMap((run) => run.font ? [run.font.assetId] : []) ?? []),
    ...(node.textProperties?.baseStyle?.font ? [node.textProperties.baseStyle.font.assetId] : []),
    ...(node.textProperties?.runs.flatMap((run) => run.fillStack?.layers.flatMap((layer) => layer.image ? [layer.image.assetId] : []) ?? []) ?? []),
    ...(node.textProperties?.baseStyle?.fillStack?.layers.flatMap((layer) => layer.image ? [layer.image.assetId] : []) ?? []),
    ...(node.textProperties?.fallbackFonts?.map((font) => font.assetId) ?? []),
  ]))].sort();
  const declaredAssetIds = [...new Set(clipboard.assetIds)].sort();
  if (actualAssetIds.length !== declaredAssetIds.length || !actualAssetIds.every((id, index) => id === declaredAssetIds[index])) return "INVALID_TREE";
  if (clipboard.assetContentHashes && (Object.keys(clipboard.assetContentHashes).length !== declaredAssetIds.length || declaredAssetIds.some((assetId) => !isSha256(clipboard.assetContentHashes?.[assetId])))) return "INVALID_TREE";
  if (clipboard.resourceAssets && (
    clipboard.resourceAssets.length !== declaredAssetIds.length
    || new Set(clipboard.resourceAssets.map((asset) => asset.assetId)).size !== clipboard.resourceAssets.length
    || clipboard.resourceAssets.some((asset) => !isAssetReference(asset) || !declaredAssetIds.includes(asset.assetId) || clipboard.assetContentHashes?.[asset.assetId] !== asset.contentHash)
  )) return "INVALID_TREE";
  return undefined;
}

/** Makes the system-clipboard representation and authenticates exactly the
 * canonical JSON bytes. The caller may store it in navigator.clipboard or a
 * serializable cross-tab fallback. */
export async function encodeNodeClipboard(
  clipboard: EditorClipboard,
  source: { documentId: string; pageId?: string },
  assets: readonly DocumentAsset[],
): Promise<string | undefined> {
  if (validateClipboardCapture(clipboard) || !source.documentId) return undefined;
  const assetById = new Map(assets.map((asset) => [asset.assetId, asset]));
  const referencedAssets = clipboard.assetIds.map((assetId) => assetById.get(assetId));
  if (referencedAssets.some((asset) => !asset)) return undefined;
  const fonts = [...fontReferences(clipboard.nodes)].map(({ assetId, faceIndex }) => {
    const asset = assetById.get(assetId);
    return asset && { assetId, contentHash: asset.contentHash, faceIndex };
  });
  if (fonts.some((font) => !font)) return undefined;
  const unsigned = {
    format: NODE_CLIPBOARD_FORMAT,
    schemaVersion: clipboard.schemaVersion,
    sourceDocumentId: source.documentId,
    ...(source.pageId ? { sourcePageId: source.pageId } : {}),
    rootIds: clipboard.rootIds,
    nodes: clipboard.nodes,
    assets: referencedAssets.map((asset) => ({ ...asset! })),
    fonts: fonts as Array<{ assetId: string; contentHash: string; faceIndex: number }>,
  };
  return JSON.stringify({ ...unsigned, payloadSha256: await sha256(JSON.stringify(unsigned)) });
}

/** Decodes untrusted browser clipboard text. Schema, digest, geometry, tree,
 * byte, node-count and depth checks happen before it reaches the Worker. */
export async function decodeNodeClipboard(text: string, expectedSchemaVersion: number): Promise<{ clipboard: EditorClipboard; sourceDocumentId: string; sourcePageId?: string } | undefined> {
  if (typeof text !== "string" || byteLength(text) > MAX_CLIPBOARD_BYTES) return undefined;
  let payload: NodeClipboardPayload;
  try { payload = JSON.parse(text) as NodeClipboardPayload; } catch { return undefined; }
  if (!payload || payload.format !== NODE_CLIPBOARD_FORMAT || !isSha256(payload.payloadSha256) || !payload.sourceDocumentId || !Array.isArray(payload.assets) || !Array.isArray(payload.fonts)) return undefined;
  const { payloadSha256, ...unsigned } = payload;
  if (await sha256(JSON.stringify(unsigned)) !== payloadSha256) return undefined;
  const assetIds = payload.assets.map((asset) => asset?.assetId);
  const resourceAssets = payload.assets.map(resourceAssetFromPayload);
  if (assetIds.some((assetId) => typeof assetId !== "string") || payload.assets.some((asset) => !isLegacyAssetReference(asset)) || resourceAssets.some((asset) => asset === false) || payload.fonts.some((font) => typeof font?.assetId !== "string" || !Number.isSafeInteger(font.faceIndex) || font.faceIndex < 0 || !isSha256(font.contentHash))) return undefined;
  const clipboard: EditorClipboard = { schemaVersion: payload.schemaVersion, rootIds: payload.rootIds, nodes: payload.nodes, assetIds, assetContentHashes: Object.fromEntries(payload.assets.map((asset) => [asset.assetId, asset.contentHash])), ...(resourceAssets.length && resourceAssets.every(Boolean) ? { resourceAssets: resourceAssets as DocumentAsset[] } : {}) };
  if (validateClipboardCapture(clipboard, expectedSchemaVersion)) return undefined;
  return { clipboard, sourceDocumentId: payload.sourceDocumentId, ...(payload.sourcePageId ? { sourcePageId: payload.sourcePageId } : {}) };
}

function isNodeProjection(node: CanvasNode | undefined): node is CanvasNode {
  return Boolean(node && typeof node.id === "string" && node.id && typeof node.name === "string" && ["frame", "group", "section", "rectangle", "ellipse", "polygon", "star", "vector", "booleanOperation", "slice", "line", "text", "image"].includes(node.kind) && [node.x, node.y, node.width, node.height, node.rotation, node.opacity, node.radius, node.strokeWidth].every(Number.isFinite) && node.width >= 0 && node.height >= 0);
}

function isAssetReference(asset: DocumentAsset | undefined): asset is DocumentAsset {
  if (!asset) return false;
  const { pixelWidth, pixelHeight } = asset;
  const hasDimensions = pixelWidth !== undefined && pixelHeight !== undefined;
  return typeof asset.assetId === "string" && Boolean(asset.assetId)
    && isSha256(asset.contentHash)
    && typeof asset.mediaType === "string" && Boolean(asset.mediaType)
    && Number.isSafeInteger(asset.byteLength) && asset.byteLength >= 0
    && (pixelWidth === undefined) === (pixelHeight === undefined)
    && (!hasDimensions || (Number.isSafeInteger(pixelWidth) && pixelWidth > 0 && Number.isSafeInteger(pixelHeight) && pixelHeight > 0));
}

function isLegacyAssetReference(asset: NodeClipboardPayload["assets"][number] | undefined): asset is NodeClipboardPayload["assets"][number] {
  return Boolean(asset && typeof asset.assetId === "string" && asset.assetId && isSha256(asset.contentHash));
}

/** `undefined` means a valid legacy v1 asset; `false` means a malformed
 * partial upgrade which must be rejected instead of silently losing metadata. */
function resourceAssetFromPayload(asset: NodeClipboardPayload["assets"][number]): DocumentAsset | undefined | false {
  const hasAnyMetadata = asset.mediaType !== undefined || asset.byteLength !== undefined || asset.pixelWidth !== undefined || asset.pixelHeight !== undefined;
  if (!hasAnyMetadata) return undefined;
  const candidate = asset as DocumentAsset;
  return isAssetReference(candidate) ? candidate : false;
}

function fontReferences(nodes: readonly CanvasNode[]) {
  const result = new Map<string, { assetId: string; faceIndex: number }>();
  for (const node of nodes) {
    for (const run of node.textProperties?.runs ?? []) if (run.font) result.set(`${run.font.assetId}:${run.font.faceIndex}`, { assetId: run.font.assetId, faceIndex: run.font.faceIndex });
    const baseFont = node.textProperties?.baseStyle?.font;
    if (baseFont) result.set(`${baseFont.assetId}:${baseFont.faceIndex}`, { assetId: baseFont.assetId, faceIndex: baseFont.faceIndex });
    for (const font of node.textProperties?.fallbackFonts ?? []) result.set(`${font.assetId}:${font.faceIndex}`, { assetId: font.assetId, faceIndex: font.faceIndex });
  }
  return result.values();
}

function jsonBytes(value: unknown) { return byteLength(JSON.stringify(value)); }
function byteLength(value: string) { return new TextEncoder().encode(value).byteLength; }
function isSha256(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value); }
async function sha256(value: string) {
  return sha256Hex(new TextEncoder().encode(value));
}
