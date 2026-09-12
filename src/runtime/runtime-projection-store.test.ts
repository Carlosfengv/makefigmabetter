import { describe, expect, it } from "vitest";
import { RuntimeProjectionStore } from "./runtime-projection-store";
import { isRuntimeError } from "./runtime-errors";
import { resolveRevisionConflict } from "./runtime-transaction-policy";

const initial = {
  revision: 7,
  nodes: [
    { id: "page", type: "PAGE" },
    { id: "frame", type: "FRAME", parentId: "page", x: 0, y: 0 },
  ],
} as const;

describe("RuntimeProjectionStore", () => {
  it("provides synchronous read-your-writes across a created parent and child", () => {
    const store = new RuntimeProjectionStore(initial);
    store.stage({
      transactionId: "tx-create-card",
      baseRevision: 7,
      operations: [
        { type: "create", node: { id: "card", type: "FRAME", parentId: "page", x: 10 } },
        { type: "create", node: { id: "title", type: "TEXT", parentId: "card", characters: "Pending" } },
        { type: "update", nodeId: "frame", patch: { x: 120 } },
      ],
    });

    expect(store.getNode("card")).toMatchObject({ parentId: "page", x: 10, removed: false });
    expect(store.getNode("title")).toMatchObject({ parentId: "card", characters: "Pending" });
    expect(store.getNode("frame")).toMatchObject({ x: 120 });
    expect(initial.nodes[1].x).toBe(0);
  });

  it("does not settle a write until the matching accepted projection arrives", () => {
    const store = new RuntimeProjectionStore(initial);
    store.stage({ transactionId: "tx-1", baseRevision: 7, operations: [{ type: "update", nodeId: "frame", patch: { x: 42 } }] });
    store.acknowledge({ transactionId: "tx-1", acceptedRevision: 8 });

    expect(store.pendingTransactionIds()).toEqual(["tx-1"]);
    expect(store.applyConfirmedProjection({ revision: 9, nodes: [{ id: "page", type: "PAGE" }, { id: "frame", type: "FRAME", parentId: "page", x: 99 }] })).toEqual({ committedTransactionIds: [] });
    expect(store.getNode("frame")).toMatchObject({ x: 42 });
    expect(store.pendingTransactionIds()).toEqual(["tx-1"]);

    const fresh = new RuntimeProjectionStore(initial);
    fresh.stage({ transactionId: "tx-2", baseRevision: 7, operations: [{ type: "update", nodeId: "frame", patch: { x: 42 } }] });
    fresh.acknowledge({ transactionId: "tx-2", acceptedRevision: 8 });
    expect(fresh.applyConfirmedProjection({ revision: 8, nodes: [{ id: "page", type: "PAGE" }, { id: "frame", type: "FRAME", parentId: "page", x: 42 }] })).toEqual({ committedTransactionIds: ["tx-2"] });
    expect(fresh.pendingTransactionIds()).toEqual([]);
    expect(fresh.getNode("frame")).toMatchObject({ x: 42 });
  });

  it("exposes a removed node immediately and restores the view on rollback", () => {
    const store = new RuntimeProjectionStore(initial);
    store.stage({ transactionId: "tx-remove", baseRevision: 7, operations: [{ type: "remove", nodeId: "frame" }] });
    expect(store.getNode("frame")).toMatchObject({ id: "frame", type: "FRAME", removed: true });
    expect(store.listLiveNodes().map((node) => node.id)).toEqual(["page"]);
    store.rollback("tx-remove");
    expect(store.getNode("frame")).toMatchObject({ x: 0 });
    expect(store.getNode("frame")).not.toHaveProperty("removed");
  });

  it("rejects stale base revisions and writes through a removed node", () => {
    const store = new RuntimeProjectionStore(initial);
    const staleError = captureError(() => store.stage({ transactionId: "old", baseRevision: 6, operations: [{ type: "update", nodeId: "frame", patch: { x: 1 } }] }));
    expect(isRuntimeError(staleError, "REVISION_CONFLICT")).toBe(true);
    store.stage({ transactionId: "remove", baseRevision: 7, operations: [{ type: "remove", nodeId: "frame" }] });
    const removedError = captureError(() => store.stage({ transactionId: "update-removed", baseRevision: 7, operations: [{ type: "update", nodeId: "frame", patch: { x: 1 } }] }));
    expect(isRuntimeError(removedError, "NODE_REMOVED")).toBe(true);
  });
});

function captureError(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected action to throw.");
}

describe("M0B transaction policies", () => {
  it("requires rebase for commands derived from a stale projection", () => {
    expect(resolveRevisionConflict("register-asset")).toEqual({ type: "retry" });
    expect(resolveRevisionConflict("reparent-node")).toEqual({ type: "rebase" });
    expect(resolveRevisionConflict("text-range-update")).toEqual({ type: "rebase" });
    expect(resolveRevisionConflict("external-authorized-import")).toEqual({ type: "reject" });
  });
});
