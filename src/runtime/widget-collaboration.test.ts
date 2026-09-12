import { describe, expect, it } from "vitest";
import { createNode } from "../lib/editor-protocol";
import { WidgetSyncReplica, widgetSyncClocksFromNode, widgetSyncCommit, widgetSyncListsFromNode, widgetSyncReplicaFromNode, widgetSyncSetsFromNode } from "./widget-collaboration";

function metadata() { return { widgetId: "com.example.widget", syncedState: { votes: 0 }, syncedMap: {} }; }

describe("M7 Widget collaboration", () => {
  it("converges concurrent state writes independently of delivery order", () => {
    const left = new WidgetSyncReplica("com.example.widget", "actor.a", metadata());
    const right = new WidgetSyncReplica("com.example.widget", "actor.b", metadata());
    const leftWrite = left.writeState("votes", 1);
    const rightWrite = right.writeState("votes", 2);
    left.apply(rightWrite);
    right.apply(leftWrite);
    expect(left.snapshot()).toEqual(right.snapshot());
    expect(left.snapshot().syncedState).toEqual({ votes: 2 });
    expect(left.apply(rightWrite)).toBe(false);
  });

  it("keeps map keys independently mergeable and persists their clocks beside Canonical metadata", () => {
    const first = new WidgetSyncReplica("com.example.widget", "actor.a", metadata());
    const second = new WidgetSyncReplica("com.example.widget", "actor.b", metadata());
    const ada = first.writeMap("participants", "ada", true);
    const ben = second.writeMap("participants", "ben", true);
    first.apply(ben); second.apply(ada);
    const node = { ...createNode("widget", 0, 0), id: "widget-node", widgetMetadata: first.snapshot() };
    const command = widgetSyncCommit(node, first)[0]!;
    expect(command).toMatchObject({ type: "update", patch: { widgetMetadata: { syncedMap: { participants: { ada: true, ben: true } } } } });
    const persisted = { ...node, extensions: (command as Extract<typeof command, { type: "update" }>).patch.extensions };
    expect(widgetSyncClocksFromNode(persisted)).toEqual(first.snapshotClocks());
  });

  it("persists a map-delete tombstone so delayed writes cannot resurrect an entry", () => {
    const initial = { widgetId: "com.example.widget", syncedState: {}, syncedMap: { participants: { ada: true } } };
    const source = new WidgetSyncReplica("com.example.widget", "source", initial);
    const olderWrite = source.writeMap("participants", "ada", true);
    const deletion = source.deleteMap("participants", "ada");
    const replica = new WidgetSyncReplica("com.example.widget", "target", initial);
    expect(replica.apply(deletion)).toBe(true);
    expect(replica.apply(olderWrite)).toBe(false);
    expect(replica.snapshot().syncedMap).toEqual({});
    expect(replica.snapshotClocks()).toHaveProperty("m/participants/ada", { counter: deletion.counter, actorId: "source" });
  });

  it("converges concurrent observed-remove set writes and preserves their tombstones", () => {
    const left = new WidgetSyncReplica("com.example.widget", "actor.left", metadata());
    const right = new WidgetSyncReplica("com.example.widget", "actor.right", metadata());
    const leftAdd = left.addToSet("reviewers", "ada");
    const rightAdd = right.addToSet("reviewers", "ada");
    left.apply(rightAdd); right.apply(leftAdd);
    const remove = left.removeFromSet("reviewers", "ada");
    right.apply(remove);
    expect(left.setValues("reviewers")).toEqual([]);
    expect(right.setValues("reviewers")).toEqual([]);
    right.apply(rightAdd);
    expect(right.setValues("reviewers")).toEqual([]);
    const delayed = new WidgetSyncReplica("com.example.widget", "actor.delayed", metadata());
    delayed.apply(remove);
    delayed.apply(rightAdd);
    expect(delayed.setValues("reviewers")).toEqual([]);
    const node = { ...createNode("widget", 0, 0), id: "widget-set", widgetMetadata: left.snapshot() };
    const command = widgetSyncCommit(node, left)[0]!;
    const persisted = { ...node, extensions: (command as Extract<typeof command, { type: "update" }>).patch.extensions };
    expect(widgetSyncSetsFromNode(persisted)).toEqual(left.snapshotSets());
    expect(widgetSyncReplicaFromNode(persisted, "actor.reloaded").setValues("reviewers")).toEqual([]);
    const recovered = widgetSyncReplicaFromNode(persisted, "actor.left");
    const recoveredAdd = recovered.addToSet("reviewers", "grace");
    expect(recoveredAdd.writes).toMatchObject([{ scope: "set", operation: "add", tag: "actor.left:2:0" }]);
  });

  it("converges concurrent ordered-list inserts and keeps delete tombstones ahead of delayed inserts", () => {
    const left = new WidgetSyncReplica("com.example.widget", "actor.left", metadata());
    const right = new WidgetSyncReplica("com.example.widget", "actor.right", metadata());
    const first = left.insertIntoList("tasks", "first");
    right.apply(first);
    const leftSecond = left.insertIntoList("tasks", "left", first.writes[0]!.itemId);
    const rightSecond = right.insertIntoList("tasks", "right", first.writes[0]!.itemId);
    left.apply(rightSecond); right.apply(leftSecond);
    expect(left.listValues("tasks")).toEqual(right.listValues("tasks"));
    const remove = left.deleteFromList("tasks", rightSecond.writes[0]!.itemId);
    const delayed = new WidgetSyncReplica("com.example.widget", "actor.delayed", metadata());
    delayed.apply(remove); delayed.apply(rightSecond); delayed.apply(first); delayed.apply(leftSecond);
    expect(delayed.listValues("tasks")).toEqual(["first", "left"]);
    const node = { ...createNode("widget", 0, 0), id: "widget-list", widgetMetadata: left.snapshot() };
    const command = widgetSyncCommit(node, left)[0]!;
    const persisted = { ...node, extensions: (command as Extract<typeof command, { type: "update" }>).patch.extensions };
    expect(widgetSyncListsFromNode(persisted)).toEqual(left.snapshotLists());
    expect(widgetSyncReplicaFromNode(persisted, "actor.reloaded").listValues("tasks")).toEqual(left.listValues("tasks"));
  });

  it("rejects an operation addressed to another widget", () => {
    const replica = new WidgetSyncReplica("com.example.widget", "actor.a", metadata());
    expect(() => replica.apply({ widgetId: "com.example.other", actorId: "actor.b", counter: 1, writes: [{ scope: "state", key: "votes", value: 1 }] })).toThrow();
  });
});
