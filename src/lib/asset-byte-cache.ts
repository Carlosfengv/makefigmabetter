import type { DocumentAsset } from "./editor-protocol";
import { sha256Hex } from "./sha256";

export const MAX_CACHED_ASSET_BYTES = 128 * 1024 * 1024;
const DIRECTORY_NAME = "makefigma-assets-v1";
const INDEX_NAME = "index.json";

type CacheEntry = Pick<DocumentAsset, "assetId" | "contentHash" | "mediaType" | "byteLength"> & { lastUsedAt: number };
type CacheIndex = { format: "asset-cache-v1"; entries: CacheEntry[] };

let serial = Promise.resolve();

/**
 * A best-effort OPFS cache for verified Asset Service responses. The document
 * contains only AssetId/contentHash; deleting or corrupting this cache merely
 * causes a controlled re-download and can never alter Canonical state.
 */
export function readCachedAsset(asset: DocumentAsset): Promise<Blob | undefined> {
  return exclusive(async () => {
    const directory = await directoryHandle(false);
    if (!directory) return undefined;
    const index = await readIndex(directory);
    const entry = index.entries.find((candidate) => candidate.assetId === asset.assetId);
    if (!entry || !matchesAsset(entry, asset)) return undefined;
    try {
      const file = await (await directory.getFileHandle(fileName(asset.assetId))).getFile();
      if (file.size !== asset.byteLength || await sha256Hex(await file.arrayBuffer()) !== asset.contentHash.toLowerCase()) {
        await removeEntry(directory, index, asset.assetId);
        return undefined;
      }
      entry.lastUsedAt = Date.now();
      await writeIndex(directory, index);
      return file.slice(0, file.size, asset.mediaType);
    } catch {
      await removeEntry(directory, index, asset.assetId);
      return undefined;
    }
  }).catch(() => undefined);
}

export function cacheAsset(asset: DocumentAsset, blob: Blob): Promise<void> {
  return exclusive(async () => {
    if (blob.size !== asset.byteLength || asset.byteLength > MAX_CACHED_ASSET_BYTES) return;
    const directory = await directoryHandle(true);
    if (!directory) return;
    const index = await readIndex(directory);
    await evictFor(directory, index, asset.assetId, asset.byteLength);
    const writer = await (await directory.getFileHandle(fileName(asset.assetId), { create: true })).createWritable();
    await writer.write(blob);
    await writer.close();
    index.entries = index.entries.filter((entry) => entry.assetId !== asset.assetId);
    index.entries.push({ assetId: asset.assetId, contentHash: asset.contentHash, mediaType: asset.mediaType, byteLength: asset.byteLength, lastUsedAt: Date.now() });
    await writeIndex(directory, index);
  }).catch(() => undefined);
}

function exclusive<T>(task: () => Promise<T>) {
  const next = serial.then(task, task);
  serial = next.then(() => undefined, () => undefined);
  return next;
}

function storageManager() {
  if (typeof navigator === "undefined") return undefined;
  return navigator.storage as StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> };
}

async function directoryHandle(create: boolean) {
  const storage = storageManager();
  if (!storage?.getDirectory) return undefined;
  try { return await (await storage.getDirectory()).getDirectoryHandle(DIRECTORY_NAME, { create }); } catch { return undefined; }
}

async function readIndex(directory: FileSystemDirectoryHandle): Promise<CacheIndex> {
  try {
    const parsed = JSON.parse(await (await directory.getFileHandle(INDEX_NAME)).getFile().then((file) => file.text())) as CacheIndex;
    if (parsed.format === "asset-cache-v1" && Array.isArray(parsed.entries)) return { format: parsed.format, entries: parsed.entries.filter(validEntry) };
  } catch { /* Missing or malformed cache metadata is treated as empty. */ }
  return { format: "asset-cache-v1", entries: [] };
}

async function writeIndex(directory: FileSystemDirectoryHandle, index: CacheIndex) {
  const writer = await (await directory.getFileHandle(INDEX_NAME, { create: true })).createWritable();
  await writer.write(JSON.stringify(index));
  await writer.close();
}

async function removeEntry(directory: FileSystemDirectoryHandle, index: CacheIndex, assetId: string) {
  index.entries = index.entries.filter((entry) => entry.assetId !== assetId);
  try { await directory.removeEntry(fileName(assetId)); } catch { /* An absent cache entry is already safe. */ }
  await writeIndex(directory, index);
}

async function evictFor(directory: FileSystemDirectoryHandle, index: CacheIndex, protectedId: string, incomingBytes: number) {
  let total = index.entries.reduce((sum, entry) => sum + entry.byteLength, 0) - (index.entries.find((entry) => entry.assetId === protectedId)?.byteLength ?? 0);
  for (const entry of [...index.entries].filter((entry) => entry.assetId !== protectedId).sort((left, right) => left.lastUsedAt - right.lastUsedAt)) {
    if (total + incomingBytes <= MAX_CACHED_ASSET_BYTES) break;
    index.entries = index.entries.filter((candidate) => candidate.assetId !== entry.assetId);
    total -= entry.byteLength;
    try { await directory.removeEntry(fileName(entry.assetId)); } catch { /* Index repair continues. */ }
  }
}

function matchesAsset(entry: CacheEntry, asset: DocumentAsset) {
  return entry.contentHash.toLowerCase() === asset.contentHash.toLowerCase() && entry.mediaType === asset.mediaType && entry.byteLength === asset.byteLength;
}

function validEntry(entry: CacheEntry): boolean {
  return typeof entry.assetId === "string" && /^[0-9a-f-]{36}$/i.test(entry.assetId) && /^[0-9a-f]{64}$/i.test(entry.contentHash) && typeof entry.mediaType === "string" && Number.isSafeInteger(entry.byteLength) && entry.byteLength > 0 && Number.isSafeInteger(entry.lastUsedAt);
}

function fileName(assetId: string) { return `${assetId.replaceAll("-", "")}.bin`; }
