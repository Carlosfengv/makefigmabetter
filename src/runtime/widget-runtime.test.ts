import { describe, expect, it } from "vitest";
import { createNode } from "../lib/editor-protocol";
import { isRuntimeError } from "./runtime-errors";
import { WidgetRuntime } from "./widget-runtime";

function widget() { return { ...createNode("widget", 0, 0), id: "widget-node", widgetMetadata: { widgetId: "com.example.widget", syncedState: { votes: 1 }, syncedMap: {} } }; }

describe("M7 Widget Runtime", () => {
  it("reconciles a bounded declarative tree and commits hook state through Canonical commands", () => {
    const runtime = new WidgetRuntime(widget(), "com.example.widget");
    const tree = runtime.render(({ useSyncedState }) => {
      const [votes, setVotes] = useSyncedState("votes", 0);
      setVotes(votes + 1);
      return { type: "AutoLayout", props: { spacing: 8 }, children: [{ type: "Text", props: { characters: `Votes: ${votes}` } }] };
    });
    runtime.setSyncedMap("participants", "ada", true);
    expect(tree.children?.[0]?.props?.characters).toBe("Votes: 1");
    expect(runtime.commit()).toMatchObject([{ type: "update", id: "widget-node", patch: { widgetMetadata: { syncedState: { votes: 2 }, syncedMap: { participants: { ada: true } } } } }]);
  });

  it("rejects cross-widget state writes and non-declarative UI values", () => {
    expect(() => new WidgetRuntime(widget(), "com.example.other")).toThrow();
    const runtime = new WidgetRuntime(widget(), "com.example.widget");
    expect(() => runtime.render(() => ({ type: "iframe" as never }))).toThrow();
    expect(() => runtime.setSyncedMap("participants", "__proto__", true)).toThrow();
  });

  it("runs effect callbacks only after a valid tree, replaces changed dependencies, and cleans up on disposal", () => {
    const runtime = new WidgetRuntime(widget(), "com.example.widget");
    const events: string[] = [];
    const render = (version: number) => runtime.render(({ useEffect: runEffect }) => {
      runEffect(() => { events.push(`start:${version}`); return () => events.push(`stop:${version}`); }, [version]);
      return { type: "Text", props: { characters: "ready" } };
    });
    render(1);
    render(1);
    render(2);
    runtime.dispose();
    expect(events).toEqual(["start:1", "stop:1", "start:2", "stop:2"]);
  });

  it("allows an effect to stage later synced state without exposing host capabilities", () => {
    const runtime = new WidgetRuntime(widget(), "com.example.widget");
    runtime.render(({ useSyncedState, useEffect: runEffect }) => {
      const [, setVotes] = useSyncedState("votes", 0);
      runEffect(() => { setVotes(3); }, []);
      return { type: "Text", props: { characters: "sync" } };
    });
    expect(runtime.commit()).toMatchObject([{ type: "update", patch: { widgetMetadata: { syncedState: { votes: 3 } } } }]);
  });

  it("dispatches only declared capability-free Widget events after a valid render", () => {
    const runtime = new WidgetRuntime(widget(), "com.example.widget");
    runtime.render(({ useSyncedState, useEvent }) => {
      const [votes, setVotes] = useSyncedState("votes", 0);
      useEvent("increment", "click", () => setVotes(votes + 1));
      return { type: "Button", props: { eventId: "increment", label: "Vote" } };
    });
    expect(runtime.dispatchEvent("increment", "click")).toBe(true);
    expect(runtime.dispatchEvent("increment", "click")).toBe(true);
    expect(runtime.dispatchEvent("missing", "click")).toBe(false);
    expect(runtime.commit()).toMatchObject([{ type: "update", patch: { widgetMetadata: { syncedState: { votes: 2 } } } }]);
  });

  it("does not install event handlers when the declared tree is invalid", () => {
    const runtime = new WidgetRuntime(widget(), "com.example.widget");
    expect(() => runtime.render(({ useEvent }) => {
      useEvent("increment", "click", () => undefined);
      return { type: "iframe" as never };
    })).toThrow();
    expect(runtime.dispatchEvent("increment", "click")).toBe(false);
  });

  it("requires every installed event handler to be referenced by a rendered Button", () => {
    const runtime = new WidgetRuntime(widget(), "com.example.widget");
    expect(() => runtime.render(({ useEvent }) => {
      useEvent("hidden-action", "click", () => undefined);
      return { type: "Text", props: { characters: "No action" } };
    })).toThrow();
    expect(() => runtime.render(() => ({ type: "Button", props: { eventId: "__proto__" } }))).toThrow();
  });

  it("serializes untrusted Widget handler failures as a Runtime error", () => {
    const runtime = new WidgetRuntime(widget(), "com.example.widget");
    runtime.render(({ useEvent }) => {
      useEvent("fail", "click", () => { throw new Error("host-only detail"); });
      return { type: "Button", props: { eventId: "fail" } };
    });
    let thrown: unknown;
    try {
      runtime.dispatchEvent("fail", "click");
    } catch (error) {
      thrown = error;
    }
    expect(isRuntimeError(thrown, "TRANSACTION_ABORTED")).toBe(true);
    expect((thrown as Error).message).not.toContain("host-only detail");
  });

  it("routes Widget hook/map writes through an optional collaboration replica and accepts remote merges", () => {
    const source = new WidgetRuntime(widget(), "com.example.widget", { actorId: "actor.source" });
    source.render(({ useSyncedState }) => {
      const [votes, setVotes] = useSyncedState("votes", 0);
      setVotes(votes + 1);
      return { type: "Text", props: { characters: "sync" } };
    });
    source.setSyncedMap("participants", "ada", true);
    const writes = source.drainCollaborationMutations();
    expect(writes).toHaveLength(2);
    expect(source.drainCollaborationMutations()).toEqual([]);
    expect(source.commit()).toMatchObject([{ type: "update", patch: { widgetMetadata: { syncedState: { votes: 2 }, syncedMap: { participants: { ada: true } } }, extensions: expect.any(Object) } }]);

    const target = new WidgetRuntime(widget(), "com.example.widget", { actorId: "actor.target" });
    expect(writes.map((write) => target.applyCollaboration(write))).toEqual([true, true]);
    target.deleteSyncedMap("participants", "ada");
    expect(target.commit()).toMatchObject([{ type: "update", patch: { widgetMetadata: { syncedState: { votes: 2 }, syncedMap: {} }, extensions: expect.any(Object) } }]);
  });

  it("forwards actor-scoped ordered-list writes and preserves their remote materialized order", () => {
    const source = new WidgetRuntime(widget(), "com.example.widget", { actorId: "actor.source" });
    const first = source.insertIntoSyncedList("tasks", "draft");
    source.insertIntoSyncedList("tasks", "review", first);
    const writes = source.drainCollaborationMutations();

    const target = new WidgetRuntime(widget(), "com.example.widget", { actorId: "actor.target" });
    writes.forEach((write) => target.applyCollaboration(write));
    expect(target.syncedListValues("tasks")).toEqual(["draft", "review"]);
    target.deleteSyncedList("tasks", first);
    const deletion = target.drainCollaborationMutations();
    deletion.forEach((write) => source.applyCollaboration(write));
    expect(source.syncedListValues("tasks")).toEqual(["review"]);
    expect(target.commit()).toMatchObject([{ type: "update", patch: { extensions: expect.any(Object) } }]);
  });

  it("forwards actor-scoped observed-remove set writes without exposing collection state to non-actors", () => {
    const source = new WidgetRuntime(widget(), "com.example.widget", { actorId: "actor.source" });
    source.addToSyncedSet("reviewers", "ada");
    source.addToSyncedSet("reviewers", "lin");
    const target = new WidgetRuntime(widget(), "com.example.widget", { actorId: "actor.target" });
    source.drainCollaborationMutations().forEach((write) => target.applyCollaboration(write));
    expect(target.syncedSetValues("reviewers")).toEqual(["ada", "lin"]);
    target.removeFromSyncedSet("reviewers", "ada");
    target.drainCollaborationMutations().forEach((write) => source.applyCollaboration(write));
    expect(source.syncedSetValues("reviewers")).toEqual(["lin"]);
  });

  it("rejects collaboration receive calls unless an actor-scoped replica was requested", () => {
    const runtime = new WidgetRuntime(widget(), "com.example.widget");
    expect(() => runtime.applyCollaboration({ widgetId: "com.example.widget", actorId: "actor.remote", counter: 1, writes: [{ scope: "state", key: "votes", value: 2 }] })).toThrow();
    expect(() => runtime.insertIntoSyncedList("tasks", "draft")).toThrow();
    expect(() => runtime.addToSyncedSet("reviewers", "ada")).toThrow();
  });
});
