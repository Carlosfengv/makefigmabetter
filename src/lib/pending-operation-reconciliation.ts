import type { PendingRemoteOperation } from "./editor-protocol";

export type PendingReconciliationPlan = {
  replayable: PendingRemoteOperation[];
  removeOperationIds: string[];
  discardedOperationIds: string[];
  blockedOperationIds: string[];
};

/** Separates operations that can be replayed from terminal and legacy records
 * before the Worker touches the authoritative remote snapshot. An older opaque
 * record without concrete replay data keeps its position: inferring a command
 * from it could silently invent a document mutation. */
export function planPendingOperationReconciliation(operations: readonly PendingRemoteOperation[]): PendingReconciliationPlan {
  const plan: PendingReconciliationPlan = {
    replayable: [],
    removeOperationIds: [],
    discardedOperationIds: [],
    blockedOperationIds: [],
  };
  for (const operation of operations) {
    if (operation.reconciliation) {
      // A conflict means the server applied nothing. Its local intent is the
      // first operation that must be replayed on the newer remote revision.
      if (operation.reconciliation.kind === "conflict" && operation.replay) {
        plan.replayable.push(operation);
        continue;
      }
      // A historical conflict record has not been accepted or rejected by the
      // server. Without its concrete local intent, leave it queued instead of
      // treating a retryable edit as a terminal result.
      if (operation.reconciliation.kind === "conflict") {
        plan.blockedOperationIds.push(operation.operationId);
        break;
      }
      plan.removeOperationIds.push(operation.operationId);
      if (operation.reconciliation.kind === "rejected") plan.discardedOperationIds.push(operation.operationId);
      continue;
    }
    if (!operation.replay) {
      plan.blockedOperationIds.push(operation.operationId);
      break;
    }
    plan.replayable.push(operation);
  }
  return plan;
}
