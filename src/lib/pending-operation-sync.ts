import type { PendingOperationResolution, PendingRemoteOperation } from "./editor-protocol";
import { nextRetry, reconcilePendingOperation, type ServerOperationAck } from "./pending-operation-queue";

export type PendingOperationStore = {
  load(): Promise<PendingRemoteOperation[]>;
  replace(operation: PendingRemoteOperation): Promise<void>;
  remove(operationId: string): Promise<void>;
};

export type PendingOperationTransport = {
  submit(operation: PendingRemoteOperation): Promise<ServerOperationAck>;
};

export type PendingSyncEvent = {
  operation: PendingRemoteOperation;
  resolution: PendingOperationResolution | "retrying";
};

export type PendingSyncReport = {
  acceptedOperationIds: string[];
  retryingOperationIds: string[];
  reconciliationRequiredOperationIds: string[];
  events: PendingSyncEvent[];
};

const terminalResolution = (resolution: PendingOperationResolution): resolution is Extract<PendingOperationResolution, { kind: "transformed" | "conflict" | "rejected" }> => resolution.kind !== "accepted";

function causalOperationOrder(left: PendingRemoteOperation, right: PendingRemoteOperation) {
  const normalizeDocumentId = (value: string) => value.replaceAll("-", "").toLowerCase();
  if (normalizeDocumentId(left.documentId) === normalizeDocumentId(right.documentId)
    && left.baseRevision !== right.baseRevision) {
    return left.baseRevision - right.baseRevision;
  }
  return left.createdAtMs - right.createdAtMs;
}

/**
 * Sends local operations one at a time. Ordering is deliberate: the server's
 * accepted revision is the single-client sequence authority, so a later pending
 * operation cannot leapfrog an earlier retry. Network errors retain exactly the
 * same opaque protobuf envelope; terminal server responses are retained as
 * diagnostic state instead of being accidentally retried.
 */
export class PendingOperationSynchronizer {
  constructor(
    private readonly store: PendingOperationStore,
    private readonly transport: PendingOperationTransport,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async flush(): Promise<PendingSyncReport> {
    const report: PendingSyncReport = { acceptedOperationIds: [], retryingOperationIds: [], reconciliationRequiredOperationIds: [], events: [] };
    // Storage may legitimately preserve several commits with the same
    // millisecond timestamp. Reassert the document's revision-chain order at
    // the delivery boundary so a random UUID tie-breaker can never submit a
    // later base revision first.
    const operations = [...await this.store.load()].sort(causalOperationOrder);
    for (const operation of operations) {
      if (operation.reconciliation) {
        report.reconciliationRequiredOperationIds.push(operation.operationId);
        report.events.push({ operation, resolution: operation.reconciliation });
        // The queue remains causally blocked until a reconciler replaces this
        // operation and its descendants with a new base sequence.
        break;
      }
      try {
        const ack = await this.transport.submit(operation);
        const resolution = reconcilePendingOperation(operation, ack);
        if (resolution.kind === "accepted") {
          await this.store.remove(operation.operationId);
          report.acceptedOperationIds.push(operation.operationId);
        } else if (terminalResolution(resolution)) {
          await this.store.replace({ ...operation, reconciliation: resolution, lastAttemptAtMs: this.now() });
          report.reconciliationRequiredOperationIds.push(operation.operationId);
          report.events.push({ operation, resolution });
          // Every later operation was derived from the local state produced by
          // this one. Do not let it leapfrog a conflict, rejection, or server
          // transform until reconciliation has established a new base state.
          break;
        }
        report.events.push({ operation, resolution });
      } catch {
        const retry = { ...nextRetry(operation), lastAttemptAtMs: this.now() };
        await this.store.replace(retry);
        report.retryingOperationIds.push(operation.operationId);
        report.events.push({ operation: retry, resolution: "retrying" });
        // The unconfirmed earlier operation must keep its place in the sequence.
        break;
      }
    }
    return report;
  }
}
