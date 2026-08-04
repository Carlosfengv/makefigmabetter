import type { EditorCommand, EditorTransaction } from "./editor-protocol";

type PendingTransaction = {
  transaction: Omit<EditorTransaction, "baseRevision">;
  conflictRetries: number;
};

export type TransactionAcknowledgement = {
  transactionId: string;
  acceptedRevision?: number;
  errorCode?: "REVISION_CONFLICT" | "INVALID_TRANSACTION" | "RESOURCE_LIMIT";
};

/**
 * Keeps UI intents single-flight so multiple main-thread events cannot race the
 * Worker revision. A conflict is retried once after the caller has observed the
 * Worker's current revision through its preceding error/snapshot message.
 */
export function createEditorTransactionQueue({
  createId,
  currentRevision,
  send,
}: {
  createId: () => string;
  currentRevision: () => number;
  send: (transaction: EditorTransaction) => boolean;
}) {
  const pending: PendingTransaction[] = [];
  let inFlight: PendingTransaction | undefined;

  const pump = () => {
    if (inFlight || pending.length === 0) return;
    const next = pending[0];
    const transaction = { ...next.transaction, baseRevision: currentRevision() };
    if (!send(transaction)) return;
    pending.shift();
    inFlight = next;
  };

  return {
    enqueue(commands: EditorCommand[]) {
      const id = createId();
      pending.push({ transaction: { id, commands }, conflictRetries: 0 });
      pump();
      return id;
    },
    acknowledge(acknowledgement: TransactionAcknowledgement) {
      if (!inFlight || inFlight.transaction.id !== acknowledgement.transactionId) return { handled: false, retried: false };
      const completed = inFlight;
      inFlight = undefined;
      let retried = false;
      if (acknowledgement.errorCode === "REVISION_CONFLICT" && completed.conflictRetries < 1) {
        completed.conflictRetries += 1;
        pending.unshift(completed);
        retried = true;
      }
      pump();
      return { handled: true, retried, transaction: completed.transaction };
    },
    pump,
    reset() {
      pending.length = 0;
      inFlight = undefined;
    },
    state() {
      return { pending: pending.length, inFlight: inFlight?.transaction.id };
    },
  };
}
