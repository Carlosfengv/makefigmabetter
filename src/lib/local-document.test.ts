import { describe, expect, it } from "vitest";
import { applyViewportRecord, comparePendingRemoteOperations, pendingOperationIsCoveredBySnapshot } from "./local-document";
import type { CoreLocalSnapshot, PendingRemoteOperation, ViewportRecord } from "./editor-protocol";

const snapshot: CoreLocalSnapshot = { format: "rust-core-v1", coreRevision: 4, documentHash: "same-core", coreSnapshot: "{}", viewport: { x: 0, y: 0, zoom: 1 }, presentation: [] };
const record: ViewportRecord = { format: "viewport-record-v1", coreRevision: 4, documentHash: "same-core", viewport: { x: 20, y: -4, zoom: 1.5 } };

describe("viewport record recovery", () => {
  it("restores a viewport only for the matching Core hash and revision", () => {
    expect(applyViewportRecord(snapshot, record).viewport).toEqual(record.viewport);
    expect(applyViewportRecord(snapshot, { ...record, documentHash: "other" })).toBe(snapshot);
    expect(applyViewportRecord(snapshot, { ...record, coreRevision: 5 })).toBe(snapshot);
  });

  it("leaves a Core document untouched when a viewport write is absent or stale", () => {
    expect(applyViewportRecord(snapshot, undefined)).toBe(snapshot);
  });
});

describe("remote root adoption", () => {
  const operation: PendingRemoteOperation = {
    format: "pending-operation-v1",
    operationId: "operation",
    transactionId: "transaction",
    documentId: "00000000-0000-0000-0000-000000000001",
    baseRevision: 3,
    envelope: new Uint8Array(),
    payloadHash: "hash",
    localDocumentHash: "document-hash",
    createdAtMs: 1,
    attempts: 0,
  };

  it("removes only operations already represented by an adopted snapshot", () => {
    expect(pendingOperationIsCoveredBySnapshot(operation, operation.documentId.replaceAll("-", ""), 4)).toBe(true);
    expect(pendingOperationIsCoveredBySnapshot(operation, operation.documentId, 3)).toBe(false);
    expect(pendingOperationIsCoveredBySnapshot(operation, "00000000-0000-0000-0000-000000000002", 4)).toBe(false);
  });
});

describe("pending remote operation order", () => {
  it("keeps same-millisecond operations in document revision order", () => {
    const base: PendingRemoteOperation = {
      format: "pending-operation-v1",
      transactionId: "transaction",
      documentId: "00000000-0000-0000-0000-000000000001",
      envelope: new Uint8Array(),
      payloadHash: "hash",
      localDocumentHash: "document-hash",
      createdAtMs: 100,
      attempts: 0,
      operationId: "z-later",
      baseRevision: 5,
    };
    const ordered = [base, { ...base, operationId: "a-earlier", baseRevision: 4 }]
      .sort(comparePendingRemoteOperations);
    expect(ordered.map((operation) => operation.baseRevision)).toEqual([4, 5]);
  });
});
