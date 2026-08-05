import { AckResult } from "@makefigma/protocol-types";
import { describe, expect, it } from "vitest";
import type { PendingRemoteOperation } from "./editor-protocol";
import { PendingOperationSynchronizer, type PendingOperationStore } from "./pending-operation-sync";

function operation(id: string): PendingRemoteOperation {
  return { format: "pending-operation-v1", operationId: id, transactionId: `tx-${id}`, documentId: "doc", baseRevision: 0, envelope: new Uint8Array([1]), payloadHash: "hash", localDocumentHash: "local", createdAtMs: 1, attempts: 0 };
}

function store(initial: PendingRemoteOperation[]): PendingOperationStore & { operations: PendingRemoteOperation[] } {
  const value = { operations: [...initial] } as PendingOperationStore & { operations: PendingRemoteOperation[] };
  value.load = async () => [...value.operations];
  value.replace = async (next) => { value.operations = value.operations.map((current) => current.operationId === next.operationId ? next : current); };
  value.remove = async (operationId) => { value.operations = value.operations.filter((current) => current.operationId !== operationId); };
  return value;
}

describe("PendingOperationSynchronizer", () => {
  it("removes accepted operations and stops at a retry without skipping order", async () => {
    const durableStore = store([operation("one"), operation("two"), operation("three")]);
    const submitted: string[] = [];
    const sync = new PendingOperationSynchronizer(durableStore, { submit: async (next) => {
      submitted.push(next.operationId);
      if (next.operationId === "two") throw new TypeError("offline");
      return { operationId: next.operationId, result: AckResult.ACK_RESULT_ACCEPTED, acceptedRevision: 1 };
    } }, () => 20);
    const report = await sync.flush();
    expect(submitted).toEqual(["one", "two"]);
    expect(report.acceptedOperationIds).toEqual(["one"]);
    expect(report.retryingOperationIds).toEqual(["two"]);
    expect(durableStore.operations.map((next) => next.operationId)).toEqual(["two", "three"]);
    expect(durableStore.operations[0]).toMatchObject({ attempts: 1, lastAttemptAtMs: 20 });
  });

  it("delivers same-millisecond operations in base-revision order instead of UUID order", async () => {
    const later = { ...operation("a-later"), baseRevision: 5, createdAtMs: 10 };
    const earlier = { ...operation("z-earlier"), baseRevision: 4, createdAtMs: 10 };
    const durableStore = store([later, earlier]);
    const submitted: number[] = [];
    const sync = new PendingOperationSynchronizer(durableStore, {
      submit: async (next) => {
        submitted.push(next.baseRevision);
        return { operationId: next.operationId, result: AckResult.ACK_RESULT_ACCEPTED, acceptedRevision: next.baseRevision + 1 };
      },
    });

    await sync.flush();
    expect(submitted).toEqual([4, 5]);
  });

  it("persists a terminal outcome and blocks operations derived from it", async () => {
    const durableStore = store([operation("conflict"), operation("transformed")]);
    const submitted: string[] = [];
    const sync = new PendingOperationSynchronizer(durableStore, { submit: async (next) => {
      submitted.push(next.operationId);
      return next.operationId === "conflict"
        ? { operationId: next.operationId, result: AckResult.ACK_RESULT_REJECTED_CONFLICT, safeMessage: "stale base" }
        : { operationId: next.operationId, result: AckResult.ACK_RESULT_ACCEPTED_WITH_TRANSFORM, acceptedRevision: 2, documentHash: "server", safeMessage: "position repaired" };
    } });
    const first = await sync.flush();
    expect(first.reconciliationRequiredOperationIds).toEqual(["conflict"]);
    expect(durableStore.operations.map((next) => next.reconciliation?.kind)).toEqual(["conflict", undefined]);
    await sync.flush();
    expect(submitted).toEqual(["conflict"]);
  });

  it("retries the identical opaque envelope after a service restart and accepts it exactly once", async () => {
    const pending = { ...operation("restart"), envelope: Uint8Array.from([0xde, 0xad, 0xbe, 0xef]) };
    const durableStore = store([pending]);
    const attemptedEnvelopes: Uint8Array[] = [];
    let available = false;
    const sync = new PendingOperationSynchronizer(durableStore, {
      submit: async (next) => {
        attemptedEnvelopes.push(next.envelope);
        if (!available) throw new TypeError("document service is restarting");
        return { operationId: next.operationId, result: AckResult.ACK_RESULT_ACCEPTED, acceptedRevision: 7 };
      },
    }, () => 50);

    await expect(sync.flush()).resolves.toMatchObject({ retryingOperationIds: ["restart"] });
    expect(durableStore.operations).toHaveLength(1);
    expect(durableStore.operations[0]).toMatchObject({ attempts: 1, lastAttemptAtMs: 50 });
    expect([...durableStore.operations[0].envelope]).toEqual([0xde, 0xad, 0xbe, 0xef]);

    available = true;
    await expect(sync.flush()).resolves.toMatchObject({ acceptedOperationIds: ["restart"] });
    expect(durableStore.operations).toEqual([]);
    expect(attemptedEnvelopes.map((envelope) => [...envelope])).toEqual([
      [0xde, 0xad, 0xbe, 0xef],
      [0xde, 0xad, 0xbe, 0xef],
    ]);
  });

  it("durably records a permanent rejection and never sends its descendant before reconciliation", async () => {
    const durableStore = store([operation("rejected"), operation("descendant")]);
    const submitted: string[] = [];
    const sync = new PendingOperationSynchronizer(durableStore, {
      submit: async (next) => {
        submitted.push(next.operationId);
        return { operationId: next.operationId, result: AckResult.ACK_RESULT_REJECTED_PERMANENT, safeMessage: "document quota exceeded" };
      },
    }, () => 75);

    const report = await sync.flush();
    expect(report.reconciliationRequiredOperationIds).toEqual(["rejected"]);
    expect(submitted).toEqual(["rejected"]);
    expect(durableStore.operations).toMatchObject([
      { operationId: "rejected", reconciliation: { kind: "rejected", diagnostic: "document quota exceeded" }, lastAttemptAtMs: 75 },
      { operationId: "descendant" },
    ]);
    expect(durableStore.operations.map((operation) => operation.reconciliation)).toEqual([
      { kind: "rejected", diagnostic: "document quota exceeded" },
      undefined,
    ]);

    await sync.flush();
    expect(submitted).toEqual(["rejected"]);
  });
});
