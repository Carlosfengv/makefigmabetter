import type { CoreLocalSnapshot, LegacyProjectionSnapshot, LocalDocumentSnapshot, LocalJournalEntry, PendingRemoteOperation, ViewportRecord } from "@/lib/editor-protocol";

const DATABASE = "makefigma-local";
const DOCUMENTS = "documents";
const JOURNAL = "journal";
const PENDING_OPERATIONS = "pending-operations";
const SNAPSHOTS = "snapshots";
const KEY = "starter-document";
const VIEWPORT_KEY = `${KEY}:viewport`;
const OPFS_DIRECTORY = "makefigma-snapshots-v1";

/** Snapshot payloads moved to OPFS without changing old IndexedDB records. */
type SnapshotRecord = {
  id: string;
  format: "core-snapshot-record-v1";
  contentHash: string;
  storage?: "opfs-v1";
  snapshot?: CoreLocalSnapshot;
};
type Manifest = { format: "local-manifest-v1"; activeSnapshotKey: string; previousSnapshotKey?: string };
type OpfsSnapshotFile = { format: "opfs-core-snapshot-v1"; contentHash: string; snapshot: CoreLocalSnapshot };

export type LocalStorageHealth = {
  opfsAvailable: boolean;
  persistentStorageGranted: boolean;
  lowSpace: boolean;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 5);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DOCUMENTS)) request.result.createObjectStore(DOCUMENTS);
      if (!request.result.objectStoreNames.contains(JOURNAL)) request.result.createObjectStore(JOURNAL, { keyPath: "id" });
      if (!request.result.objectStoreNames.contains(PENDING_OPERATIONS)) request.result.createObjectStore(PENDING_OPERATIONS, { keyPath: "operationId" });
      if (!request.result.objectStoreNames.contains(SNAPSHOTS)) request.result.createObjectStore(SNAPSHOTS, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getValue<T>(database: IDBDatabase, store: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = database.transaction(store, "readonly").objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

function getAllJournal(database: IDBDatabase): Promise<LocalJournalEntry[]> {
  return new Promise((resolve, reject) => {
    const request = database.transaction(JOURNAL, "readonly").objectStore(JOURNAL).getAll();
    request.onsuccess = () => resolve((request.result as LocalJournalEntry[]).filter((entry) => entry.format === "rust-core-operation-v1").sort((a, b) => a.acceptedRevision - b.acceptedRevision));
    request.onerror = () => reject(request.error);
  });
}

function normalizedSnapshot(snapshot: CoreLocalSnapshot): CoreLocalSnapshot {
  return { format: "rust-core-v1", coreRevision: snapshot.coreRevision, coreSnapshot: snapshot.coreSnapshot, ...(snapshot.documentHash ? { documentHash: snapshot.documentHash } : {}), viewport: snapshot.viewport, presentation: snapshot.presentation };
}

async function contentHash(snapshot: CoreLocalSnapshot) {
  const bytes = new TextEncoder().encode(JSON.stringify(normalizedSnapshot(snapshot)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function storageManager() {
  if (typeof navigator === "undefined") return undefined;
  return navigator.storage as StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> };
}

async function opfsDirectory(create: boolean) {
  const storage = storageManager();
  if (!storage?.getDirectory) return undefined;
  try {
    const root = await storage.getDirectory();
    return await root.getDirectoryHandle(OPFS_DIRECTORY, { create });
  } catch {
    return undefined;
  }
}

function opfsFileName(id: string) {
  return `${id}.json`;
}

async function readOpfsSnapshot(id: string): Promise<OpfsSnapshotFile | undefined> {
  const directory = await opfsDirectory(false);
  if (!directory) return undefined;
  try {
    const file = await (await directory.getFileHandle(opfsFileName(id))).getFile();
    const decoded = JSON.parse(await file.text()) as OpfsSnapshotFile;
    return decoded.format === "opfs-core-snapshot-v1" ? decoded : undefined;
  } catch {
    return undefined;
  }
}

async function writeOpfsSnapshot(id: string, snapshot: CoreLocalSnapshot, hash: string) {
  const directory = await opfsDirectory(true);
  if (!directory) return false;
  const writer = await (await directory.getFileHandle(opfsFileName(id), { create: true })).createWritable();
  await writer.write(JSON.stringify({ format: "opfs-core-snapshot-v1", contentHash: hash, snapshot } satisfies OpfsSnapshotFile));
  await writer.close();
  const persisted = await readOpfsSnapshot(id);
  return Boolean(persisted && persisted.contentHash === hash && await contentHash(persisted.snapshot) === hash);
}

async function removeOpfsSnapshot(id: string) {
  const directory = await opfsDirectory(false);
  if (!directory) return;
  try { await directory.removeEntry(opfsFileName(id)); } catch { /* An orphan is harmless and will be retried by later cleanup. */ }
}

function isQuotaExceeded(error: unknown) {
  return error instanceof DOMException && error.name === "QuotaExceededError";
}

async function ensureStorageCapacity(bytes: number) {
  const storage = storageManager();
  if (!storage?.estimate) return;
  const estimate = await storage.estimate().catch(() => undefined);
  if (!estimate) return;
  if (estimate.quota !== undefined && estimate.usage !== undefined && estimate.quota - estimate.usage < bytes) {
    throw new Error("LOCAL_STORAGE_QUOTA_EXCEEDED");
  }
}

/** Requests durable browser storage when available. Rejection never blocks editing;
 * callers use the returned state to make the eviction risk visible in the UI. */
export async function prepareLocalStorage(): Promise<LocalStorageHealth> {
  const storage = storageManager();
  if (!storage) return { opfsAvailable: false, persistentStorageGranted: false, lowSpace: false };
  const [directory, persisted, estimate] = await Promise.all([
    opfsDirectory(true),
    storage.persist?.().catch(() => false) ?? Promise.resolve(false),
    storage.estimate?.().catch(() => undefined) ?? Promise.resolve(undefined),
  ]);
  const remaining = estimate?.quota !== undefined && estimate.usage !== undefined ? estimate.quota - estimate.usage : undefined;
  return { opfsAvailable: Boolean(directory), persistentStorageGranted: persisted, lowSpace: remaining !== undefined && remaining < 1024 * 1024 };
}

async function validSnapshot(record: SnapshotRecord | undefined): Promise<CoreLocalSnapshot | undefined> {
  if (!record || record.format !== "core-snapshot-record-v1") return undefined;
  try {
    const opfsFile = record.storage === "opfs-v1" ? await readOpfsSnapshot(record.id) : undefined;
    const snapshot = opfsFile?.snapshot ?? record.snapshot;
    if (opfsFile && opfsFile.contentHash !== record.contentHash) return undefined;
    if (!snapshot || snapshot.format !== "rust-core-v1" || await contentHash(snapshot) !== record.contentHash) return undefined;
    return snapshot;
  } catch {
    return undefined;
  }
}

function migrateCoreRevision(snapshot: CoreLocalSnapshot): CoreLocalSnapshot | undefined {
  if (typeof snapshot.coreRevision === "number") return snapshot;
  try { return { ...snapshot, coreRevision: Number((JSON.parse(snapshot.coreSnapshot) as { revision: number }).revision) }; } catch { return undefined; }
}

export async function loadLocalDocument(): Promise<LocalDocumentSnapshot | undefined> {
  const database = await openDatabase();
  const [stored, journal, viewportRecord] = await Promise.all([getValue<Manifest | CoreLocalSnapshot | Pick<LegacyProjectionSnapshot, "nodes" | "viewport">>(database, DOCUMENTS, KEY), getAllJournal(database), getValue<ViewportRecord>(database, DOCUMENTS, VIEWPORT_KEY)]);
  if (!stored) return undefined;

  if ("format" in stored && stored.format === "local-manifest-v1") {
    const manifest = stored as Manifest;
    const [active, previous] = await Promise.all([getValue<SnapshotRecord>(database, SNAPSHOTS, manifest.activeSnapshotKey), manifest.previousSnapshotKey ? getValue<SnapshotRecord>(database, SNAPSHOTS, manifest.previousSnapshotKey) : Promise.resolve(undefined)]);
    const current = await validSnapshot(active);
    if (current) return attachViewportRecord(current, journal, viewportRecord);
    const fallback = await validSnapshot(previous);
    if (fallback) return { ...attachViewportRecord(fallback, journal, viewportRecord), recoveredFromPrevious: true };
    return undefined;
  }

  if ("coreSnapshot" in stored && typeof stored.coreSnapshot === "string") {
    const snapshot = migrateCoreRevision(stored as CoreLocalSnapshot);
    return snapshot ? attachViewportRecord(snapshot, journal, viewportRecord) : undefined;
  }
  if ("nodes" in stored && Array.isArray(stored.nodes)) return { format: "legacy-projection-v0", nodes: stored.nodes, viewport: stored.viewport } satisfies LegacyProjectionSnapshot;
  return undefined;
}

function attachViewportRecord(snapshot: CoreLocalSnapshot, journal: LocalJournalEntry[], record: ViewportRecord | undefined): CoreLocalSnapshot {
  return { ...applyViewportRecord(snapshot, record), journal };
}

/** Applies only a record confirmed to belong to this exact Core revision. */
export function applyViewportRecord(snapshot: CoreLocalSnapshot, record: ViewportRecord | undefined): CoreLocalSnapshot {
  const matches = record?.format === "viewport-record-v1" && record.documentHash === snapshot.documentHash && record.coreRevision === snapshot.coreRevision;
  return matches ? { ...snapshot, viewport: record.viewport } : snapshot;
}

/** A viewport is UI state, so it has a tiny independent persistence path. */
export async function saveViewportRecord(record: ViewportRecord) {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const request = database.transaction(DOCUMENTS, "readwrite").objectStore(DOCUMENTS).put(record, VIEWPORT_KEY);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function appendLocalJournalEntry(entry: LocalJournalEntry) {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const request = database.transaction(JOURNAL, "readwrite").objectStore(JOURNAL).put(entry);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/** Pending server operations are deliberately separate from the local Core journal:
 * the latter protects local recovery, while this queue remains until a durable
 * service-side accepted revision (or a recorded reconciliation outcome) exists. */
export async function appendPendingRemoteOperation(operation: PendingRemoteOperation) {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const request = database.transaction(PENDING_OPERATIONS, "readwrite").objectStore(PENDING_OPERATIONS).put(operation);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function loadPendingRemoteOperations() {
  const database = await openDatabase();
  return new Promise<PendingRemoteOperation[]>((resolve, reject) => {
    const request = database.transaction(PENDING_OPERATIONS, "readonly").objectStore(PENDING_OPERATIONS).getAll();
    request.onsuccess = () => resolve((request.result as PendingRemoteOperation[])
      .filter((operation) => operation.format === "pending-operation-v1")
      .sort((left, right) => left.createdAtMs - right.createdAtMs || left.operationId.localeCompare(right.operationId)));
    request.onerror = () => reject(request.error);
  });
}

export async function replacePendingRemoteOperation(operation: PendingRemoteOperation) {
  return appendPendingRemoteOperation(operation);
}

export async function removePendingRemoteOperation(operationId: string) {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const request = database.transaction(PENDING_OPERATIONS, "readwrite").objectStore(PENDING_OPERATIONS).delete(operationId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export function pendingOperationIsCoveredBySnapshot(
  operation: PendingRemoteOperation,
  documentId: string,
  snapshotRevision: number,
) {
  const normalized = (value: string) => value.replaceAll("-", "").toLowerCase();
  return normalized(operation.documentId) === normalized(documentId)
    && Number.isSafeInteger(snapshotRevision)
    && snapshotRevision >= 0
    && Number.isSafeInteger(operation.baseRevision)
    && operation.baseRevision >= 0
    && operation.baseRevision < snapshotRevision;
}

/** A newly created remote root adopts the complete canonical snapshot. Operations
 * whose resulting revisions are already represented by that snapshot must not be
 * submitted again as if the server had started from revision zero. */
export async function removePendingRemoteOperationsCoveredBySnapshot(documentId: string, snapshotRevision: number) {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(PENDING_OPERATIONS, "readwrite");
    const cursor = transaction.objectStore(PENDING_OPERATIONS).openCursor();
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (!entry) return;
      if (pendingOperationIsCoveredBySnapshot(entry.value as PendingRemoteOperation, documentId, snapshotRevision)) entry.delete();
      entry.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Pending-operation cleanup aborted"));
  });
}

/** Writes an immutable record first, then atomically switches the Manifest pointer.
 * The previous pointer is retained so a corrupt active record never bricks recovery. */
export async function saveLocalDocument(snapshot: CoreLocalSnapshot) {
  const database = await openDatabase();
  const persisted = normalizedSnapshot(snapshot);
  const id = crypto.randomUUID();
  const hash = await contentHash(persisted);
  const encodedSize = new TextEncoder().encode(JSON.stringify(persisted)).byteLength;
  await ensureStorageCapacity(encodedSize);
  let usesOpfs = false;
  try {
    usesOpfs = await writeOpfsSnapshot(id, persisted, hash);
  } catch (error) {
    if (isQuotaExceeded(error)) throw new Error("LOCAL_STORAGE_QUOTA_EXCEEDED");
    // OPFS is an optional browser capability; keep the verified IndexedDB fallback
    // when a browser exposes but cannot yet write its file-system implementation.
  }
  const record: SnapshotRecord = usesOpfs
    ? { id, format: "core-snapshot-record-v1", contentHash: hash, storage: "opfs-v1" }
    : { id, format: "core-snapshot-record-v1", contentHash: hash, snapshot: persisted };
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction([DOCUMENTS, JOURNAL, SNAPSHOTS], "readwrite");
    const documentStore = transaction.objectStore(DOCUMENTS);
    const snapshotStore = transaction.objectStore(SNAPSHOTS);
    const journalStore = transaction.objectStore(JOURNAL);
    let staleSnapshotKey: string | undefined;
    const currentRequest = documentStore.get(KEY);
    currentRequest.onsuccess = () => {
      const current = currentRequest.result as Manifest | undefined;
      const previousSnapshotKey = current?.format === "local-manifest-v1" ? current.activeSnapshotKey : undefined;
      staleSnapshotKey = current?.format === "local-manifest-v1" ? current.previousSnapshotKey : undefined;
      snapshotStore.put(record);
      documentStore.put({ format: "local-manifest-v1", activeSnapshotKey: record.id, ...(previousSnapshotKey ? { previousSnapshotKey } : {}) } satisfies Manifest, KEY);
      if (staleSnapshotKey && staleSnapshotKey !== previousSnapshotKey) snapshotStore.delete(staleSnapshotKey);
      const cursor = journalStore.openCursor();
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) return;
        if ((entry.value as LocalJournalEntry).acceptedRevision <= persisted.coreRevision) entry.delete();
        entry.continue();
      };
    };
    transaction.oncomplete = () => {
      // The manifest no longer points at this immutable file. Cleanup happens only
      // after the transaction has committed, so a failed pointer switch cannot erase
      // the previous recovery target.
      if (staleSnapshotKey) void removeOpfsSnapshot(staleSnapshotKey);
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Local snapshot transaction aborted"));
  });
}
