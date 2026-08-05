import { AckResult } from "@makefigma/protocol-types";
import { describe, expect, it } from "vitest";
import type { PendingRemoteOperation } from "./editor-protocol";
import { nextRetry, reconcilePendingOperation } from "./pending-operation-queue";

const pending: PendingRemoteOperation = {
  format: "pending-operation-v1", operationId: "operation", transactionId: "transaction", documentId: "document", baseRevision: 4,
  envelope: new Uint8Array([1]), payloadHash: "hash", localDocumentHash: "document-hash", createdAtMs: 1, attempts: 0,
};

describe("pending operation reconciliation", () => {
  it("only clears an operation after a server accepted revision", () => {
    expect(reconcilePendingOperation(pending, { operationId: "operation", result: AckResult.ACK_RESULT_ACCEPTED })).toEqual({ kind: "rejected", diagnostic: "The server permanently rejected this operation." });
    expect(reconcilePendingOperation(pending, { operationId: "operation", result: AckResult.ACK_RESULT_ACCEPTED, acceptedRevision: 5, documentHash: "accepted" })).toEqual({ kind: "accepted", acceptedRevision: 5, documentHash: "accepted" });
  });

  it("keeps transformed and conflicted results diagnosable", () => {
    expect(reconcilePendingOperation(pending, { operationId: "operation", result: AckResult.ACK_RESULT_ACCEPTED_WITH_TRANSFORM, acceptedRevision: 5 })).toMatchObject({ kind: "transformed", acceptedRevision: 5 });
    expect(reconcilePendingOperation(pending, { operationId: "operation", result: AckResult.ACK_RESULT_REJECTED_CONFLICT })).toMatchObject({ kind: "conflict" });
    expect(nextRetry(pending)).toMatchObject({ attempts: 1, operationId: "operation" });
  });
});
