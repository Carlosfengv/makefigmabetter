import { runtimeError } from "./runtime-errors";

export type RuntimeProjectionNode = Readonly<{
  id: string;
  type: string;
  parentId?: string;
  removed?: boolean;
  [property: string]: unknown;
}>;

export type RuntimeProjection = Readonly<{
  revision: number;
  nodes: readonly RuntimeProjectionNode[];
}>;

export type PendingProjectionOperation =
  | Readonly<{ type: "create"; node: RuntimeProjectionNode }>
  | Readonly<{ type: "update"; nodeId: string; patch: Readonly<Record<string, unknown>> }>
  | Readonly<{ type: "remove"; nodeId: string }>;

export type PendingProjectionTransaction = Readonly<{
  transactionId: string;
  baseRevision: number;
  operations: readonly PendingProjectionOperation[];
}>;

export type ProjectionAcknowledgement = Readonly<{
  transactionId: string;
  acceptedRevision: number;
}>;

export type ProjectionFenceResult = Readonly<{
  committedTransactionIds: readonly string[];
}>;

type PendingEntry = Readonly<{
  transaction: PendingProjectionTransaction;
  acceptedRevision?: number;
}>;

/**
 * M0B's Session-local projection store. It never writes Canonical state: it
 * overlays queued writes on the most recently confirmed projection so a
 * synchronous API can read its own writes until the Core transaction settles.
 */
export class RuntimeProjectionStore {
  private confirmed: RuntimeProjection;
  private readonly pending = new Map<string, PendingEntry>();

  constructor(initial: RuntimeProjection) {
    this.confirmed = freezeProjection(initial);
  }

  get confirmedRevision(): number {
    return this.confirmed.revision;
  }

  /** Frozen Canonical input for a RevisionLease consumer. */
  get confirmedProjection(): RuntimeProjection {
    return this.confirmed;
  }

  stage(transaction: PendingProjectionTransaction): void {
    if (!transaction.transactionId || this.pending.has(transaction.transactionId)) {
      throw runtimeError("INVALID_ARGUMENT", { transactionId: transaction.transactionId });
    }
    if (transaction.baseRevision !== this.confirmed.revision) {
      throw runtimeError("REVISION_CONFLICT", { transactionId: transaction.transactionId, revision: this.confirmed.revision });
    }
    if (!transaction.operations.length) throw runtimeError("INVALID_ARGUMENT", { transactionId: transaction.transactionId });

    const candidate = this.composedNodeMap();
    applyOperations(candidate, transaction.operations, transaction.transactionId);
    this.pending.set(transaction.transactionId, { transaction: freezeTransaction(transaction) });
  }

  /** Adds synchronous writes to the transaction currently being coalesced in
   * this event turn. The entry is immutable to callers, but its local
   * PendingProjection remains one atomic Core batch until it is acknowledged. */
  append(transactionId: string, operations: readonly PendingProjectionOperation[]): void {
    const entry = this.pending.get(transactionId);
    if (!entry || entry.acceptedRevision !== undefined || !operations.length) {
      throw runtimeError("INVALID_ARGUMENT", { transactionId });
    }
    const candidate = this.composedNodeMap();
    applyOperations(candidate, operations, transactionId);
    this.pending.set(transactionId, {
      transaction: freezeTransaction({
        ...entry.transaction,
        operations: [...entry.transaction.operations, ...operations],
      }),
    });
  }

  transaction(transactionId: string): PendingProjectionTransaction | undefined {
    return this.pending.get(transactionId)?.transaction;
  }

  acknowledge(acknowledgement: ProjectionAcknowledgement): void {
    const entry = this.pending.get(acknowledgement.transactionId);
    if (!entry || acknowledgement.acceptedRevision <= this.confirmed.revision) {
      throw runtimeError("INVALID_ARGUMENT", { transactionId: acknowledgement.transactionId, revision: acknowledgement.acceptedRevision });
    }
    this.pending.set(acknowledgement.transactionId, { ...entry, acceptedRevision: acknowledgement.acceptedRevision });
  }

  /**
   * Applies a Worker/Service projection. A transaction settles only when this
   * exact revision follows its Ack; an Ack by itself is deliberately invisible
   * to committed Runtime observers.
   */
  applyConfirmedProjection(projection: RuntimeProjection): ProjectionFenceResult {
    if (projection.revision < this.confirmed.revision) {
      throw runtimeError("REVISION_CONFLICT", { revision: this.confirmed.revision });
    }
    this.confirmed = freezeProjection(projection);
    const committedTransactionIds: string[] = [];
    for (const [transactionId, entry] of this.pending) {
      if (entry.acceptedRevision === projection.revision) {
        this.pending.delete(transactionId);
        committedTransactionIds.push(transactionId);
      }
    }
    return { committedTransactionIds };
  }

  rollback(transactionId: string): void {
    if (!this.pending.delete(transactionId)) throw runtimeError("INVALID_ARGUMENT", { transactionId });
  }

  getNode(nodeId: string): RuntimeProjectionNode | undefined {
    return this.composedNodeMap().get(nodeId);
  }

  listLiveNodes(): readonly RuntimeProjectionNode[] {
    return [...this.composedNodeMap().values()].filter((node) => node.removed !== true);
  }

  pendingTransactionIds(): readonly string[] {
    return [...this.pending.keys()];
  }

  private composedNodeMap(): Map<string, RuntimeProjectionNode> {
    const nodes = new Map(this.confirmed.nodes.map((node) => [node.id, cloneNode(node)]));
    for (const { transaction } of this.pending.values()) applyOperations(nodes, transaction.operations, transaction.transactionId);
    return nodes;
  }
}

function applyOperations(
  nodes: Map<string, RuntimeProjectionNode>,
  operations: readonly PendingProjectionOperation[],
  transactionId: string,
): void {
  for (const operation of operations) {
    if (operation.type === "create") {
      if (!operation.node.id || !operation.node.type || nodes.has(operation.node.id)) {
        throw runtimeError("INVALID_ARGUMENT", { transactionId, nodeId: operation.node.id });
      }
      nodes.set(operation.node.id, cloneNode({ ...operation.node, removed: false }));
      continue;
    }

    const node = nodes.get(operation.nodeId);
    if (!node) throw runtimeError("NODE_NOT_FOUND", { transactionId, nodeId: operation.nodeId });
    if (node.removed === true) throw runtimeError("NODE_REMOVED", { transactionId, nodeId: operation.nodeId });

    if (operation.type === "remove") {
      nodes.set(operation.nodeId, cloneNode({ ...node, removed: true }));
      continue;
    }

    if (Object.hasOwn(operation.patch, "id") || Object.hasOwn(operation.patch, "type") || Object.hasOwn(operation.patch, "removed")) {
      throw runtimeError("INVALID_ARGUMENT", { transactionId, nodeId: operation.nodeId });
    }
    nodes.set(operation.nodeId, cloneNode({ ...node, ...operation.patch }));
  }
}

function freezeProjection(projection: RuntimeProjection): RuntimeProjection {
  if (!Number.isSafeInteger(projection.revision) || projection.revision < 0) throw runtimeError("INVALID_ARGUMENT", { revision: projection.revision });
  const ids = new Set<string>();
  const nodes = projection.nodes.map((node) => {
    if (!node.id || !node.type || ids.has(node.id)) throw runtimeError("INVALID_ARGUMENT", { nodeId: node.id });
    ids.add(node.id);
    return cloneNode(node);
  });
  return Object.freeze({ revision: projection.revision, nodes: Object.freeze(nodes) });
}

function freezeTransaction(transaction: PendingProjectionTransaction): PendingProjectionTransaction {
  return Object.freeze({
    transactionId: transaction.transactionId,
    baseRevision: transaction.baseRevision,
    operations: Object.freeze(transaction.operations.map((operation) => deepFreeze(structuredClone(operation)))),
  });
}

function cloneNode(node: RuntimeProjectionNode): RuntimeProjectionNode {
  return deepFreeze(structuredClone(node));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
