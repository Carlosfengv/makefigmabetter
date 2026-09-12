import type { CanvasNode, DocumentWidgetMetadata, EditorCommand } from "../lib/editor-protocol";
import { setFigmaPluginWidgetSyncedState } from "../lib/figma-plugin-node-mutation";
import { WidgetSyncReplica, type WidgetSyncMutation, widgetSyncCommit, widgetSyncReplicaFromNode } from "./widget-collaboration";
import { isRuntimeError, runtimeError } from "./runtime-errors";

export type WidgetElement = Readonly<{
  type: "AutoLayout" | "Text" | "Rectangle" | "Button";
  props?: Readonly<Record<string, string | number | boolean>>;
  children?: readonly WidgetElement[];
}>;

export type WidgetRenderContext = Readonly<{
  useSyncedState<T extends JsonValue>(key: string, initial: T): readonly [T, (next: T) => void];
  useEffect(effect: WidgetEffect, dependencies?: readonly JsonValue[]): void;
  useEvent(eventId: string, type: WidgetEventType, handler: WidgetEventHandler): void;
}>;
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type WidgetEffect = () => void | (() => void);
export type WidgetEventType = "click";
export type WidgetEventHandler = () => void;
export type WidgetCollaborationOptions = Readonly<{ actorId: string }>;

type EffectSlot = Readonly<{ dependencies: readonly JsonValue[]; cleanup?: () => void }>;

/** A small, deterministic Widget reconciler. It accepts a serializable element
 * tree rather than evaluating JSX or giving widgets host DOM access. */
export class WidgetRuntime {
  private metadata: DocumentWidgetMetadata;
  private effects: EffectSlot[] = [];
  private events = new Map<string, Readonly<{ type: WidgetEventType; handler: WidgetEventHandler }>>();
  private rendering = false;
  private readonly collaboration?: WidgetSyncReplica;
  private pendingCollaboration: WidgetSyncMutation[] = [];

  constructor(private readonly node: CanvasNode, readonly widgetId: string, collaboration?: WidgetCollaborationOptions) {
    if (node.kind !== "widget" || !node.widgetMetadata || node.widgetMetadata.widgetId !== widgetId) throw runtimeError("PERMISSION_DENIED", { nodeId: node.id });
    this.collaboration = collaboration ? widgetSyncReplicaFromNode(node, collaboration.actorId) : undefined;
    this.metadata = this.collaboration?.snapshot() ?? structuredClone(node.widgetMetadata);
  }

  render(renderWidget: (context: WidgetRenderContext) => WidgetElement): WidgetElement {
    const staged: Record<string, JsonValue> = {};
    const nextEffects: Array<Readonly<{ effect: WidgetEffect; dependencies: readonly JsonValue[] }>> = [];
    const nextEvents = new Map<string, Readonly<{ type: WidgetEventType; handler: WidgetEventHandler }>>();
    this.rendering = true;
    let tree: WidgetElement;
    try {
      tree = renderWidget({
        useSyncedState: <T extends JsonValue>(key: string, initial: T) => {
          validateStateKey(key);
          const current = this.metadata.syncedState[key];
          const value = isJsonValue(current) ? structuredClone(current) as T : structuredClone(initial);
          return [value, (next: T) => {
            if (!isJsonValue(next)) throw runtimeError("INVALID_ARGUMENT");
            if (this.rendering) staged[key] = structuredClone(next);
            else this.writeSyncedState(key, next);
          }] as const;
        },
        useEffect: (effect, dependencies = []) => {
          if (typeof effect !== "function" || !validEffectDependencies(dependencies) || nextEffects.length >= 32) throw runtimeError("INVALID_ARGUMENT");
          nextEffects.push({ effect, dependencies: structuredClone(dependencies) });
        },
        useEvent: (eventId, type, handler) => {
          validateStateKey(eventId);
          if (type !== "click" || typeof handler !== "function" || nextEvents.has(eventId) || nextEvents.size >= 32) throw runtimeError("INVALID_ARGUMENT");
          nextEvents.set(eventId, { type, handler });
        },
      });
    } finally {
      this.rendering = false;
    }
    validateWidgetTree(tree);
    const renderedEventIds = widgetEventIds(tree);
    if ([...nextEvents.keys()].some((eventId) => !renderedEventIds.has(eventId))) throw runtimeError("INVALID_ARGUMENT");
    Object.entries(staged).forEach(([key, value]) => this.writeSyncedState(key, value));
    this.events = nextEvents;
    this.reconcileEffects(nextEffects);
    return structuredClone(tree);
  }

  setSyncedMap(mapName: string, key: string, value: JsonValue): void {
    validateStateKey(mapName); validateStateKey(key);
    if (!isJsonValue(value)) throw runtimeError("INVALID_ARGUMENT");
    if (this.collaboration) {
      this.recordCollaboration(this.collaboration.writeMap(mapName, key, value));
      return;
    }
    this.metadata = { ...this.metadata, syncedMap: { ...this.metadata.syncedMap, [mapName]: { ...(this.metadata.syncedMap[mapName] ?? {}), [key]: structuredClone(value) } } };
  }

  deleteSyncedMap(mapName: string, key: string): void {
    validateStateKey(mapName); validateStateKey(key);
    if (this.collaboration) {
      this.recordCollaboration(this.collaboration.deleteMap(mapName, key));
      return;
    }
    const map = { ...(this.metadata.syncedMap[mapName] ?? {}) };
    delete map[key];
    const syncedMap = { ...this.metadata.syncedMap };
    if (Object.keys(map).length) syncedMap[mapName] = map;
    else delete syncedMap[mapName];
    this.metadata = { ...this.metadata, syncedMap };
  }

  /** Inserts a serializable value into an actor-scoped ordered list. The
   * returned stable ID can be supplied to later insertions or deletions. */
  insertIntoSyncedList(listName: string, value: JsonValue, afterId?: string): string {
    const mutation = this.requireCollaboration().insertIntoList(listName, value, afterId);
    const write = mutation.writes[0];
    if (!write || write.scope !== "list" || write.operation !== "insert") throw runtimeError("TRANSACTION_ABORTED", { nodeId: this.node.id });
    this.recordCollaboration(mutation);
    return write.itemId;
  }

  /** Deletes one stable list item. The collaboration replica retains the
   * tombstone so delayed inserts cannot make it visible again. */
  deleteSyncedList(listName: string, itemId: string): void {
    this.recordCollaboration(this.requireCollaboration().deleteFromList(listName, itemId));
  }

  /** Reads the materialized, deterministic order of an actor-scoped list. */
  syncedListValues(listName: string): readonly JsonValue[] {
    return this.requireCollaboration().listValues(listName);
  }

  /** Adds one identifier to an actor-scoped observed-remove set. Concurrent
   * additions are preserved unless this replica has observed their tag. */
  addToSyncedSet(setName: string, member: string): void {
    this.recordCollaboration(this.requireCollaboration().addToSet(setName, member));
  }

  /** Removes the currently observed additions for an identifier. */
  removeFromSyncedSet(setName: string, member: string): void {
    this.recordCollaboration(this.requireCollaboration().removeFromSet(setName, member));
  }

  /** Reads an actor-scoped set in deterministic lexical order. */
  syncedSetValues(setName: string): readonly string[] {
    return this.requireCollaboration().setValues(setName);
  }

  /** Returns locally generated mutations once so callers can send them through
   * their collaboration transport without exposing the Widget to that host. */
  drainCollaborationMutations(): readonly WidgetSyncMutation[] {
    const mutations = this.pendingCollaboration;
    this.pendingCollaboration = [];
    return mutations;
  }

  /** Applies validated remote state to the local Widget projection. This never
   * runs user code and does not re-enqueue the received mutation for transport. */
  applyCollaboration(mutation: WidgetSyncMutation): boolean {
    if (!this.collaboration) throw runtimeError("PERMISSION_DENIED", { nodeId: this.node.id });
    const changed = this.collaboration.apply(mutation);
    if (changed) this.metadata = this.collaboration.snapshot();
    return changed;
  }

  /** The returned command goes through the same Canonical transaction fence as
   * ordinary node mutations; it does not mutate the editor projection. */
  commit(): readonly EditorCommand[] {
    if (this.collaboration) return widgetSyncCommit(this.node, this.collaboration);
    const result = setFigmaPluginWidgetSyncedState({ ...this.node, widgetMetadata: this.metadata }, this.widgetId, this.metadata.syncedState, this.metadata.syncedMap);
    if (!result.ok) throw runtimeError("TRANSACTION_ABORTED", { nodeId: this.node.id });
    return result.commands;
  }

  /** Dispatches a declared, capability-free Widget event. The handler receives
   * no DOM/Event object; it can only use values deliberately closed over by
   * its render function, such as a synced-state setter. */
  dispatchEvent(eventId: string, type: WidgetEventType): boolean {
    validateStateKey(eventId);
    const event = this.events.get(eventId);
    if (!event || event.type !== type) return false;
    try {
      event.handler();
    } catch (error) {
      if (isRuntimeError(error)) throw error;
      throw runtimeError("TRANSACTION_ABORTED", { nodeId: this.node.id });
    }
    return true;
  }

  /** Releases runtime-only resources. Effects receive no host DOM, network, or
   * Plugin API capability; they can only use values intentionally closed over
   * by the caller. */
  dispose(): void {
    const active = this.effects;
    this.effects = [];
    this.events.clear();
    let failure: unknown;
    for (const slot of [...active].reverse()) {
      try { slot.cleanup?.(); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }

  private reconcileEffects(next: readonly Readonly<{ effect: WidgetEffect; dependencies: readonly JsonValue[] }>[]): void {
    const reconciled: EffectSlot[] = [];
    for (let index = 0; index < next.length; index += 1) {
      const candidate = next[index];
      const previous = this.effects[index];
      if (previous && equalJson(previous.dependencies, candidate.dependencies)) {
        reconciled.push(previous);
        continue;
      }
      previous?.cleanup?.();
      const cleanup = candidate.effect();
      if (cleanup !== undefined && typeof cleanup !== "function") throw runtimeError("INVALID_ARGUMENT");
      reconciled.push({ dependencies: candidate.dependencies, ...(cleanup ? { cleanup } : {}) });
    }
    for (let index = next.length; index < this.effects.length; index += 1) this.effects[index].cleanup?.();
    this.effects = reconciled;
  }

  private writeSyncedState(key: string, value: JsonValue): void {
    if (this.collaboration) {
      this.recordCollaboration(this.collaboration.writeState(key, value));
      return;
    }
    this.metadata = { ...this.metadata, syncedState: { ...this.metadata.syncedState, [key]: structuredClone(value) } };
  }

  private requireCollaboration(): WidgetSyncReplica {
    if (!this.collaboration) throw runtimeError("PERMISSION_DENIED", { nodeId: this.node.id });
    return this.collaboration;
  }

  private recordCollaboration(mutation: WidgetSyncMutation): void {
    this.pendingCollaboration.push(mutation);
    this.metadata = this.collaboration!.snapshot();
  }
}

export function validateWidgetTree(value: unknown, depth = 0): asserts value is WidgetElement {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 32) throw runtimeError("INVALID_ARGUMENT");
  const element = value as Record<string, unknown>;
  if (!["AutoLayout", "Text", "Rectangle", "Button"].includes(String(element.type)) || (element.props !== undefined && !validProps(element.props)) || (element.children !== undefined && (!Array.isArray(element.children) || element.children.length > 256))) throw runtimeError("INVALID_ARGUMENT");
  (element.children as unknown[] | undefined)?.forEach((child) => validateWidgetTree(child, depth + 1));
}

function widgetEventIds(tree: WidgetElement): ReadonlySet<string> {
  const eventIds = new Set<string>();
  const visit = (element: WidgetElement) => {
    const eventId = element.type === "Button" ? element.props?.eventId : undefined;
    if (eventId !== undefined) {
      if (typeof eventId !== "string") throw runtimeError("INVALID_ARGUMENT");
      validateStateKey(eventId);
      eventIds.add(eventId);
    }
    element.children?.forEach(visit);
  };
  visit(tree);
  return eventIds;
}

function validProps(value: unknown): boolean { return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.entries(value).length <= 32 && Object.entries(value as Record<string, unknown>).every(([key, entry]) => key.length <= 64 && (["string", "number", "boolean"].includes(typeof entry)) && (typeof entry !== "number" || Number.isFinite(entry)))); }
function validateStateKey(key: string) { if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key)) throw runtimeError("INVALID_ARGUMENT"); }
function validEffectDependencies(value: unknown): value is readonly JsonValue[] { return Array.isArray(value) && value.length <= 32 && value.every((dependency) => isJsonValue(dependency)); }
function equalJson(left: readonly JsonValue[], right: readonly JsonValue[]): boolean { return left.length === right.length && left.every((value, index) => JSON.stringify(value) === JSON.stringify(right[index])); }
function isJsonValue(value: unknown, depth = 0): value is JsonValue { return value === null || typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) || (depth < 8 && Array.isArray(value) && value.length <= 128 && value.every((item) => isJsonValue(item, depth + 1))) || (depth < 8 && Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.entries(value).length <= 128 && Object.values(value).every((item) => isJsonValue(item, depth + 1)))); }
