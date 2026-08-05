import { AckResult } from "@makefigma/protocol-types";
import type { PendingOperationResolution, PendingRemoteOperation } from "./editor-protocol";

export type ServerOperationAck = {
  operationId: string;
  result: AckResult;
  acceptedRevision?: number;
  documentHash?: string;
  safeMessage?: string;
};

/** Maps generated protocol ACKs into the small set of reconciliation outcomes the
 * editor can present. The caller only deletes persistence after `accepted` or a
 * server-provided transform has been durably recorded. */
export function reconcilePendingOperation(operation: PendingRemoteOperation, ack: ServerOperationAck): PendingOperationResolution {
  if (ack.operationId !== operation.operationId) return { kind: "conflict", diagnostic: "Received an acknowledgement for a different operation." };
  const acceptedRevision = ack.acceptedRevision;
  if (ack.result === AckResult.ACK_RESULT_ACCEPTED && acceptedRevision !== undefined) {
    return { kind: "accepted", acceptedRevision, documentHash: ack.documentHash };
  }
  if (ack.result === AckResult.ACK_RESULT_ACCEPTED_WITH_TRANSFORM && acceptedRevision !== undefined) {
    return { kind: "transformed", acceptedRevision, documentHash: ack.documentHash, diagnostic: ack.safeMessage ?? "The server accepted a transformed operation." };
  }
  if (ack.result === AckResult.ACK_RESULT_REJECTED_CONFLICT) {
    return { kind: "conflict", diagnostic: ack.safeMessage ?? "The operation conflicts with the accepted document revision." };
  }
  return { kind: "rejected", diagnostic: ack.safeMessage ?? "The server permanently rejected this operation." };
}

export function nextRetry(operation: PendingRemoteOperation): PendingRemoteOperation {
  return { ...operation, attempts: operation.attempts + 1 };
}
