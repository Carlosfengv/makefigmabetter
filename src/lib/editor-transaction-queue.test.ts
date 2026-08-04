import { describe, expect, it } from "vitest";
import type { EditorTransaction } from "./editor-protocol";
import { createEditorTransactionQueue } from "./editor-transaction-queue";

describe("editor transaction queue", () => {
  it("keeps commands single-flight and uses the latest confirmed revision", () => {
    let revision = 4;
    let nextId = 0;
    const sent: EditorTransaction[] = [];
    const queue = createEditorTransactionQueue({
      createId: () => `transaction-${++nextId}`,
      currentRevision: () => revision,
      send: (transaction) => { sent.push(transaction); return true; },
    });

    queue.enqueue([{ type: "select", ids: ["one"] }]);
    queue.enqueue([{ type: "select", ids: ["two"] }]);
    expect(sent).toHaveLength(1);
    revision = 5;
    queue.acknowledge({ transactionId: "transaction-1", acceptedRevision: 5 });
    expect(sent[1]).toMatchObject({ id: "transaction-2", baseRevision: 5 });
  });

  it("retries one revision conflict without duplicating later intents", () => {
    let revision = 7;
    let nextId = 0;
    const sent: EditorTransaction[] = [];
    const queue = createEditorTransactionQueue({
      createId: () => `transaction-${++nextId}`,
      currentRevision: () => revision,
      send: (transaction) => { sent.push(transaction); return true; },
    });

    queue.enqueue([{ type: "undo" }]);
    queue.enqueue([{ type: "redo" }]);
    revision = 8;
    queue.acknowledge({ transactionId: "transaction-1", errorCode: "REVISION_CONFLICT" });
    expect(sent.map(({ id, baseRevision }) => [id, baseRevision])).toEqual([
      ["transaction-1", 7],
      ["transaction-1", 8],
    ]);
    queue.acknowledge({ transactionId: "transaction-1", acceptedRevision: 9 });
    expect(sent.at(-1)?.id).toBe("transaction-2");
  });

  it("keeps work queued until a sender becomes available", () => {
    let available = false;
    const sent: EditorTransaction[] = [];
    const queue = createEditorTransactionQueue({
      createId: () => "transaction-1",
      currentRevision: () => 2,
      send: (transaction) => {
        if (!available) return false;
        sent.push(transaction);
        return true;
      },
    });
    queue.enqueue([{ type: "select", ids: [] }]);
    expect(queue.state()).toEqual({ pending: 1, inFlight: undefined });
    available = true;
    queue.pump();
    expect(sent).toHaveLength(1);
  });
});
