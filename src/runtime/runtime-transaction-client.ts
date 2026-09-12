import { runtimeError, type RuntimeErrorCode } from "./runtime-errors";
import type { PendingProjectionTransaction, RuntimeProjection } from "./runtime-projection-store";
import { RuntimeProjectionStore } from "./runtime-projection-store";

export type RuntimeTransactionResult =
  | Readonly<{ type: "accepted"; acceptedRevision: number; projection: RuntimeProjection }>
  | Readonly<{ type: "rejected"; errorCode: RuntimeErrorCode }>;

/** A transport resolves only after it has observed both the Core Ack and the
 * Projection at that Ack's revision. This keeps Runtime free of Worker globals
 * while preserving the required two-part commit fence. */
export interface RuntimeTransactionTransport {
  submit(transaction: PendingProjectionTransaction): Promise<RuntimeTransactionResult>;
}

export class RuntimeTransactionClient {
  constructor(
    private readonly store: RuntimeProjectionStore,
    private readonly transport: RuntimeTransactionTransport,
    private readonly onConfirmed: (projection: RuntimeProjection) => void,
  ) {}

  async commit(transactionId: string): Promise<number> {
    const transaction = this.store.transaction(transactionId);
    if (!transaction) throw runtimeError("INVALID_ARGUMENT", { transactionId });
    let result: RuntimeTransactionResult;
    try {
      result = await this.transport.submit(transaction);
    } catch {
      this.store.rollback(transactionId);
      throw runtimeError("TRANSACTION_ABORTED", { transactionId });
    }
    if (result.type === "rejected") {
      this.store.rollback(transactionId);
      throw runtimeError(result.errorCode, { transactionId });
    }
    this.store.acknowledge({ transactionId, acceptedRevision: result.acceptedRevision });
    const fence = this.store.applyConfirmedProjection(result.projection);
    this.onConfirmed(result.projection);
    if (!fence.committedTransactionIds.includes(transactionId)) {
      throw runtimeError("INTERNAL_ERROR", { transactionId, revision: result.acceptedRevision });
    }
    return result.acceptedRevision;
  }
}
