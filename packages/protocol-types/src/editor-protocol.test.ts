import { describe, expect, it } from "vitest";
import { OperationEnvelope } from "./editor/v1/editor";

describe("generated editor protocol", () => {
  it("round-trips an operation envelope without a hand-written wire type", () => {
    const operation = OperationEnvelope.create({
      schemaVersion: 1,
      documentId: new Uint8Array(16).fill(1),
      operationId: new Uint8Array(16).fill(2),
      transactionId: new Uint8Array(16).fill(3),
      actorId: new Uint8Array(16).fill(4),
      sessionId: new Uint8Array(16).fill(5),
      clientSequence: "9",
      baseRevision: "7",
      payload: new Uint8Array([42]),
      payloadHash: new Uint8Array(32).fill(9),
    });
    const decoded = OperationEnvelope.decode(OperationEnvelope.encode(operation).finish());
    expect(decoded).toEqual(operation);
  });
});
