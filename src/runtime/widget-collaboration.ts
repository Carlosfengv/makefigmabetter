import type { CanvasNode, DocumentWidgetMetadata, EditorCommand } from "../lib/editor-protocol";
import { runtimeError } from "./runtime-errors";
import type { JsonValue } from "./widget-runtime";

export const WIDGET_SYNC_CLOCKS_EXTENSION = "makefigma.widget.sync-clocks.v1";
export const WIDGET_SYNC_SETS_EXTENSION = "makefigma.widget.sync-sets.v1";
export const WIDGET_SYNC_LISTS_EXTENSION = "makefigma.widget.sync-lists.v1";
export type WidgetSyncClock = Readonly<{ counter: number; actorId: string }>;
export type WidgetSyncWrite =
  | Readonly<{ scope: "state"; key: string; value: JsonValue }>
  | Readonly<{ scope: "map"; mapName: string; key: string; value: JsonValue }>
  | Readonly<{ scope: "map"; mapName: string; key: string; deleted: true }>
  | Readonly<{ scope: "set"; setName: string; member: string; operation: "add"; tag: string }>
  | Readonly<{ scope: "set"; setName: string; member: string; operation: "remove"; tags: readonly string[] }>
  | Readonly<{ scope: "list"; listName: string; operation: "insert"; itemId: string; afterId?: string; value: JsonValue }>
  | Readonly<{ scope: "list"; listName: string; operation: "delete"; itemId: string }>;
export type WidgetSyncMutation = Readonly<{ widgetId: string; actorId: string; counter: number; writes: readonly WidgetSyncWrite[] }>;
export type WidgetSyncSetState = Readonly<{ adds: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>; tombstones: readonly string[] }>;
export type WidgetSyncListState = Readonly<{ items: Readonly<Record<string, readonly Readonly<{ id: string; afterId?: string; value: JsonValue }> []>>; tombstones: Readonly<Record<string, readonly string[]>> }>;

/**
 * A small state-based LWW-register map for Widgets. Each state/map entry is
 * independently ordered by `(counter, actorId)`, so duplicated or reordered
 * collaboration delivery converges without making the Widget runtime execute
 * user code. Map deletes retain their clock as a tombstone, so a delayed older
 * write cannot resurrect a removed entry. It also provides an observed-remove
 * set: concurrent adds survive, while removal tombstones only the tags it has
 * observed. Its list is an RGA-style sequence: concurrent insertions after the
 * same item use stable item-ID order and deletes retain tombstones. Clock, set
 * and list metadata are persisted in opaque extensions.
 */
export class WidgetSyncReplica {
  private metadata: DocumentWidgetMetadata;
  private readonly clocks: Record<string, WidgetSyncClock>;
  private readonly setAdds: Record<string, Record<string, Set<string>>>;
  private readonly setTombstones: Set<string>;
  private readonly listItems: Record<string, Map<string, { afterId?: string; value: JsonValue }>>;
  private readonly listTombstones: Record<string, Set<string>>;
  private counter: number;

  constructor(readonly widgetId: string, readonly actorId: string, metadata: DocumentWidgetMetadata, clocks: Record<string, WidgetSyncClock> = {}, sets: WidgetSyncSetState = { adds: {}, tombstones: [] }, lists: WidgetSyncListState = { items: {}, tombstones: {} }) {
    if (!validActorId(actorId) || !validWidgetMetadata(metadata) || !validSetState(sets) || !validListState(lists)) throw runtimeError("INVALID_ARGUMENT");
    this.metadata = structuredClone(metadata);
    this.clocks = structuredClone(clocks);
    this.setAdds = setAddsFromState(sets);
    this.setTombstones = new Set(sets.tombstones);
    this.listItems = listItemsFromState(lists);
    this.listTombstones = listTombstonesFromState(lists);
    this.counter = Math.max(
      0,
      ...Object.values(this.clocks).map((clock) => clock.counter),
      ...Object.values(this.setAdds).flatMap((members) => Object.values(members).flatMap((tags) => [...tags])).map(crdtCounterFromId),
      ...Object.values(this.listItems).flatMap((items) => [...items.keys()]).map(crdtCounterFromId),
    );
  }

  writeState(key: string, value: JsonValue): WidgetSyncMutation { return this.write([{ scope: "state", key, value }]); }
  writeMap(mapName: string, key: string, value: JsonValue): WidgetSyncMutation { return this.write([{ scope: "map", mapName, key, value }]); }
  deleteMap(mapName: string, key: string): WidgetSyncMutation { return this.write([{ scope: "map", mapName, key, deleted: true }]); }
  addToSet(setName: string, member: string): WidgetSyncMutation {
    const counter = this.counter + 1;
    return this.write([{ scope: "set", setName, member, operation: "add", tag: `${this.actorId}:${counter}:0` }]);
  }
  removeFromSet(setName: string, member: string): WidgetSyncMutation {
    return this.write([{ scope: "set", setName, member, operation: "remove", tags: [...(this.setAdds[setName]?.[member] ?? new Set())].filter((tag) => !this.setTombstones.has(tag)).sort() }]);
  }
  insertIntoList(listName: string, value: JsonValue, afterId?: string): WidgetSyncMutation {
    if (!validKey(listName) || !isJsonValue(value) || afterId !== undefined && (!validCrdtId(afterId) || !this.listItems[listName]?.has(afterId))) throw runtimeError("INVALID_ARGUMENT");
    const counter = this.counter + 1;
    return this.write([{ scope: "list", listName, operation: "insert", itemId: `${this.actorId}:${counter}:list:0`, ...(afterId ? { afterId } : {}), value }]);
  }
  deleteFromList(listName: string, itemId: string): WidgetSyncMutation {
    if (!validKey(listName) || !validCrdtId(itemId)) throw runtimeError("INVALID_ARGUMENT");
    return this.write([{ scope: "list", listName, operation: "delete", itemId }]);
  }

  apply(mutation: WidgetSyncMutation): boolean {
    validateMutation(mutation, this.widgetId);
    let changed = false;
    const clock = { counter: mutation.counter, actorId: mutation.actorId };
    this.counter = Math.max(this.counter, clock.counter);
    for (const write of mutation.writes) {
      if (write.scope === "set") {
        changed = this.applySetWrite(write) || changed;
        continue;
      }
      if (write.scope === "list") {
        changed = this.applyListWrite(write) || changed;
        continue;
      }
      const path = writePath(write);
      const previous = this.clocks[path];
      if (previous && compareClock(clock, previous) <= 0) continue;
      this.clocks[path] = clock;
      if (write.scope === "state") this.metadata = { ...this.metadata, syncedState: { ...this.metadata.syncedState, [write.key]: structuredClone(write.value) } };
      else if ("deleted" in write) this.deleteMapValue(write.mapName, write.key);
      else this.metadata = { ...this.metadata, syncedMap: { ...this.metadata.syncedMap, [write.mapName]: { ...(this.metadata.syncedMap[write.mapName] ?? {}), [write.key]: structuredClone(write.value) } } };
      changed = true;
    }
    return changed;
  }

  snapshot(): DocumentWidgetMetadata { return structuredClone(this.metadata); }
  snapshotClocks(): Record<string, WidgetSyncClock> { return structuredClone(this.clocks); }
  setValues(setName: string): readonly string[] {
    if (!validKey(setName)) throw runtimeError("INVALID_ARGUMENT");
    return Object.entries(this.setAdds[setName] ?? {}).flatMap(([member, tags]) => [...tags].some((tag) => !this.setTombstones.has(tag)) ? [member] : []).sort();
  }
  snapshotSets(): WidgetSyncSetState {
    const adds = Object.fromEntries(Object.entries(this.setAdds).flatMap(([setName, members]) => {
      const entries = Object.entries(members).flatMap(([member, tags]) => tags.size ? [[member, [...tags].sort()]] : []);
      return entries.length ? [[setName, Object.fromEntries(entries)]] : [];
    }));
    return { adds, tombstones: [...this.setTombstones].sort() };
  }
  listValues(listName: string): readonly JsonValue[] {
    if (!validKey(listName)) throw runtimeError("INVALID_ARGUMENT");
    const items = this.listItems[listName] ?? new Map();
    const children = new Map<string | undefined, string[]>();
    for (const [id, item] of items) {
      const siblings = children.get(item.afterId) ?? [];
      siblings.push(id); children.set(item.afterId, siblings);
    }
    children.forEach((ids) => ids.sort());
    const values: JsonValue[] = [];
    const visit = (afterId: string | undefined, seen: Set<string>) => {
      for (const id of children.get(afterId) ?? []) {
        if (seen.has(id)) continue;
        seen.add(id);
        const item = items.get(id)!;
        if (!this.listTombstones[listName]?.has(id)) values.push(structuredClone(item.value));
        visit(id, seen);
      }
    };
    visit(undefined, new Set());
    return values;
  }
  snapshotLists(): WidgetSyncListState {
    const items = Object.fromEntries(Object.entries(this.listItems).flatMap(([listName, entries]) => {
      const values = [...entries.entries()].map(([id, item]) => ({ id, ...(item.afterId ? { afterId: item.afterId } : {}), value: structuredClone(item.value) })).sort((left, right) => left.id.localeCompare(right.id));
      return values.length ? [[listName, values]] : [];
    }));
    const tombstones = Object.fromEntries(Object.entries(this.listTombstones).flatMap(([listName, ids]) => ids.size ? [[listName, [...ids].sort()]] : []));
    return { items, tombstones };
  }

  private write(writes: readonly WidgetSyncWrite[]): WidgetSyncMutation {
    const mutation: WidgetSyncMutation = { widgetId: this.widgetId, actorId: this.actorId, counter: ++this.counter, writes: structuredClone(writes) };
    this.apply(mutation);
    return mutation;
  }

  private deleteMapValue(mapName: string, key: string): void {
    const map = { ...(this.metadata.syncedMap[mapName] ?? {}) };
    delete map[key];
    if (Object.keys(map).length) this.metadata = { ...this.metadata, syncedMap: { ...this.metadata.syncedMap, [mapName]: map } };
    else {
      const syncedMap = { ...this.metadata.syncedMap };
      delete syncedMap[mapName];
      this.metadata = { ...this.metadata, syncedMap };
    }
  }

  private applySetWrite(write: Extract<WidgetSyncWrite, { scope: "set" }>): boolean {
    if (write.operation === "add") {
      const tags = this.setAdds[write.setName] ??= {};
      const members = tags[write.member] ??= new Set<string>();
      const before = members.size;
      members.add(write.tag);
      return members.size !== before;
    }
    let changed = false;
    for (const tag of write.tags) {
      if (!this.setTombstones.has(tag)) { this.setTombstones.add(tag); changed = true; }
    }
    return changed;
  }

  private applyListWrite(write: Extract<WidgetSyncWrite, { scope: "list" }>): boolean {
    if (write.operation === "insert") {
      const items = this.listItems[write.listName] ??= new Map();
      if (items.has(write.itemId)) return false;
      items.set(write.itemId, { ...(write.afterId ? { afterId: write.afterId } : {}), value: structuredClone(write.value) });
      return true;
    }
    const tombstones = this.listTombstones[write.listName] ??= new Set<string>();
    const previous = tombstones.size;
    tombstones.add(write.itemId);
    return tombstones.size !== previous;
  }
}

/** Converts a merged Widget replica into one ordinary Canonical update command.
 * No local projection or remote collaboration state is mutated directly. */
export function widgetSyncCommit(node: CanvasNode, replica: WidgetSyncReplica): readonly EditorCommand[] {
  if (node.kind !== "widget" || node.widgetMetadata?.widgetId !== replica.widgetId) throw runtimeError("PERMISSION_DENIED", { nodeId: node.id });
  const extensions = {
    ...node.extensions,
    [WIDGET_SYNC_CLOCKS_EXTENSION]: encodedWidgetSyncExtension(replica.snapshotClocks()),
    [WIDGET_SYNC_SETS_EXTENSION]: encodedWidgetSyncExtension(replica.snapshotSets()),
    [WIDGET_SYNC_LISTS_EXTENSION]: encodedWidgetSyncExtension(replica.snapshotLists()),
  };
  return [{ type: "update", id: node.id, patch: { widgetMetadata: replica.snapshot(), extensions } }];
}

/** Rehydrates every persisted collaboration datatype from one Canonical Widget
 * node. Callers never need to decode opaque extension bytes themselves. */
export function widgetSyncReplicaFromNode(node: CanvasNode, actorId: string): WidgetSyncReplica {
  if (node.kind !== "widget" || !node.widgetMetadata) throw runtimeError("PERMISSION_DENIED", { nodeId: node.id });
  return new WidgetSyncReplica(node.widgetMetadata.widgetId, actorId, node.widgetMetadata, widgetSyncClocksFromNode(node), widgetSyncSetsFromNode(node), widgetSyncListsFromNode(node));
}

export function widgetSyncClocksFromNode(node: CanvasNode): Record<string, WidgetSyncClock> {
  const bytes = node.extensions?.[WIDGET_SYNC_CLOCKS_EXTENSION];
  if (!bytes || bytes.length > 64 * 1024) return {};
  try {
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes)));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length > 2_048) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([path, clock]) => validPath(path) && validClock(clock) ? [[path, clock]] : []));
  } catch { return {}; }
}

export function widgetSyncSetsFromNode(node: CanvasNode): WidgetSyncSetState {
  const bytes = node.extensions?.[WIDGET_SYNC_SETS_EXTENSION];
  if (!bytes || bytes.length > 64 * 1024) return { adds: {}, tombstones: [] };
  try {
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes)));
    return validSetState(parsed) ? { adds: structuredClone(parsed.adds), tombstones: [...parsed.tombstones] } : { adds: {}, tombstones: [] };
  } catch { return { adds: {}, tombstones: [] }; }
}

export function widgetSyncListsFromNode(node: CanvasNode): WidgetSyncListState {
  const bytes = node.extensions?.[WIDGET_SYNC_LISTS_EXTENSION];
  if (!bytes || bytes.length > 64 * 1024) return { items: {}, tombstones: {} };
  try {
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes)));
    return validListState(parsed) ? { items: structuredClone(parsed.items), tombstones: structuredClone(parsed.tombstones) } : { items: {}, tombstones: {} };
  } catch { return { items: {}, tombstones: {} }; }
}

function validateMutation(value: WidgetSyncMutation, widgetId: string): void {
  if (!value || value.widgetId !== widgetId || !validActorId(value.actorId) || !Number.isSafeInteger(value.counter) || value.counter < 1 || !Array.isArray(value.writes) || !value.writes.length || value.writes.length > 128 || !value.writes.every(validWrite)) throw runtimeError("INVALID_ARGUMENT");
}
function validWrite(write: unknown): write is WidgetSyncWrite {
  if (!write || typeof write !== "object" || Array.isArray(write)) return false;
  const item = write as Record<string, unknown>;
  if (item.scope === "state") return validKey(item.key) && isJsonValue(item.value) && item.mapName === undefined && item.deleted === undefined;
  if (item.scope === "map") return validKey(item.mapName) && validKey(item.key) && (item.deleted === true && item.value === undefined || item.deleted === undefined && isJsonValue(item.value));
  if (item.scope === "set") return validKey(item.setName) && validKey(item.member) && (item.operation === "add" && validSetTag(item.tag) || item.operation === "remove" && Array.isArray(item.tags) && item.tags.length <= 128 && item.tags.every(validSetTag));
  if (item.scope !== "list" || !validKey(item.listName) || !validCrdtId(item.itemId)) return false;
  return item.operation === "insert" && (item.afterId === undefined || validCrdtId(item.afterId)) && isJsonValue(item.value) || item.operation === "delete" && item.afterId === undefined && item.value === undefined;
}
function validWidgetMetadata(value: DocumentWidgetMetadata): boolean { return Boolean(value.widgetId && isJsonRecord(value.syncedState) && Object.values(value.syncedMap).every(isJsonRecord)); }
function validKey(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(value); }
function validActorId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value); }
function validPath(value: string) { return /^([sm])\/[A-Za-z][A-Za-z0-9_.-]{0,63}(?:\/[A-Za-z][A-Za-z0-9_.-]{0,63})?$/u.test(value); }
function validClock(value: unknown): value is WidgetSyncClock { return Boolean(value && typeof value === "object" && Number.isSafeInteger((value as WidgetSyncClock).counter) && (value as WidgetSyncClock).counter >= 1 && validActorId((value as WidgetSyncClock).actorId)); }
function validSetTag(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9._:-]{1,192}$/u.test(value); }
function validCrdtId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9._:-]{1,192}$/u.test(value); }
function validSetState(value: unknown): value is WidgetSyncSetState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (!isJsonRecord(state.adds) || !Array.isArray(state.tombstones) || state.tombstones.length > 8_192 || !state.tombstones.every(validSetTag)) return false;
  const sets = Object.entries(state.adds);
  return sets.length <= 128 && sets.every(([setName, members]) => validKey(setName) && isJsonRecord(members) && Object.entries(members).length <= 512 && Object.entries(members).every(([member, tags]) => validKey(member) && Array.isArray(tags) && tags.length <= 128 && tags.every(validSetTag)));
}
function setAddsFromState(state: WidgetSyncSetState): Record<string, Record<string, Set<string>>> { return Object.fromEntries(Object.entries(state.adds).map(([setName, members]) => [setName, Object.fromEntries(Object.entries(members).map(([member, tags]) => [member, new Set(tags)]))])); }
function validListState(value: unknown): value is WidgetSyncListState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (!isJsonRecord(state.items) || !isJsonRecord(state.tombstones)) return false;
  const lists = Object.entries(state.items);
  return lists.length <= 128 && lists.every(([listName, items]) => validKey(listName) && Array.isArray(items) && items.length <= 2_048 && items.every(validListItem)) && Object.entries(state.tombstones).length <= 128 && Object.entries(state.tombstones).every(([listName, ids]) => validKey(listName) && Array.isArray(ids) && ids.length <= 2_048 && ids.every(validCrdtId));
}
function validListItem(value: unknown): boolean { return Boolean(value && typeof value === "object" && !Array.isArray(value) && validCrdtId((value as Record<string, unknown>).id) && ((value as Record<string, unknown>).afterId === undefined || validCrdtId((value as Record<string, unknown>).afterId)) && isJsonValue((value as Record<string, unknown>).value)); }
function listItemsFromState(state: WidgetSyncListState): Record<string, Map<string, { afterId?: string; value: JsonValue }>> { return Object.fromEntries(Object.entries(state.items).map(([listName, items]) => [listName, new Map(items.map((item) => [item.id, { ...(item.afterId ? { afterId: item.afterId } : {}), value: structuredClone(item.value) }]))])); }
function listTombstonesFromState(state: WidgetSyncListState): Record<string, Set<string>> { return Object.fromEntries(Object.entries(state.tombstones).map(([listName, ids]) => [listName, new Set(ids)])); }
function crdtCounterFromId(value: string): number { const match = value.match(/:(\d+):(?:0|list:\d+)$/u); return match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : 0; }
function writePath(write: Exclude<WidgetSyncWrite, { scope: "set" | "list" }>) { return write.scope === "state" ? `s/${write.key}` : `m/${write.mapName}/${write.key}`; }
function compareClock(left: WidgetSyncClock, right: WidgetSyncClock) { return left.counter - right.counter || left.actorId.localeCompare(right.actorId); }
function isJsonRecord(value: unknown, depth = 0): value is Record<string, unknown> { return Boolean(depth < 8 && value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length <= 128 && Object.values(value).every((item) => isJsonValue(item, depth + 1))); }
function isJsonValue(value: unknown, depth = 0): value is JsonValue { return value === null || typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) || (depth < 8 && Array.isArray(value) && value.length <= 128 && value.every((item) => isJsonValue(item, depth + 1))) || isJsonRecord(value, depth); }
function encodedWidgetSyncExtension(value: unknown): number[] {
  const bytes = [...new TextEncoder().encode(JSON.stringify(value))];
  if (bytes.length > 64 * 1024) throw runtimeError("RESOURCE_LIMIT");
  return bytes;
}
