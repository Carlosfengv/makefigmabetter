import { describe, expect, it } from "vitest";
import type { PendingRemoteOperation } from "./editor-protocol";
import { planPendingOperationReconciliation } from "./pending-operation-reconciliation";

function operation(id: string, replay = true): PendingRemoteOperation {
  return {
    format: "pending-operation-v1", operationId: id, transactionId: `tx-${id}`, documentId: "document", baseRevision: 0,
    envelope: new Uint8Array([1]), payloadHash: "hash", localDocumentHash: "local", createdAtMs: 1, attempts: 0,
    ...(replay ? { replay: { kind: "core-batch" as const, batch: [{ type: "delete" as const, ids: [id] }] } } : {}),
  };
}

describe("pending operation reconciliation planning", () => {
  it("replays a conflicted intent and removes only transformed or permanently rejected operations", () => {
    const conflicted = { ...operation("conflict"), reconciliation: { kind: "conflict" as const, diagnostic: "stale" } };
    const transformed = { ...operation("transformed"), reconciliation: { kind: "transformed" as const, acceptedRevision: 3, diagnostic: "server normalized" } };
    const plan = planPendingOperationReconciliation([conflicted, transformed, operation("later")]);
    expect(plan.removeOperationIds).toEqual(["transformed"]);
    expect(plan.discardedOperationIds).toEqual([]);
    expect(plan.replayable.map((item) => item.operationId)).toEqual(["conflict", "later"]);
    expect(plan.blockedOperationIds).toEqual([]);
  });

  it("does not guess the intent of a legacy opaque record", () => {
    const plan = planPendingOperationReconciliation([operation("legacy", false), operation("later")]);
    expect(plan.blockedOperationIds).toEqual(["legacy"]);
    expect(plan.replayable).toEqual([]);
    expect(plan.removeOperationIds).toEqual([]);
  });

  it("preserves an old conflicted record that has no replayable intent", () => {
    const legacyConflict = {
      ...operation("legacy-conflict", false),
      reconciliation: { kind: "conflict" as const, diagnostic: "stale" },
    };
    const plan = planPendingOperationReconciliation([legacyConflict, operation("later")]);
    expect(plan.blockedOperationIds).toEqual(["legacy-conflict"]);
    expect(plan.replayable).toEqual([]);
    expect(plan.removeOperationIds).toEqual([]);
  });

  it("removes a permanent rejection but can continue with an independent later intent", () => {
    const rejected = {
      ...operation("rejected"),
      reconciliation: { kind: "rejected" as const, diagnostic: "payload exceeds the document quota" },
    };
    const plan = planPendingOperationReconciliation([rejected, operation("later")]);
    expect(plan.removeOperationIds).toEqual(["rejected"]);
    expect(plan.discardedOperationIds).toEqual(["rejected"]);
    expect(plan.replayable.map((item) => item.operationId)).toEqual(["later"]);
  });
});
