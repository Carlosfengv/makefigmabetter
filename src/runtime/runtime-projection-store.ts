import { runtimeError } from "./runtime-errors";
import type { DocumentTransformModifier } from "../lib/editor-protocol";
import type { DocumentTextStyleResource } from "../lib/editor-protocol";
import { isBoundedTransformModifierStack } from "../lib/transform-group-repeat";

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
  textStyles?: readonly DocumentTextStyleResource[];
}>;

export type PendingProjectionOperation =
  | Readonly<{ type: "create"; node: RuntimeProjectionNode }>
  | Readonly<{ type: "update"; nodeId: string; patch: Readonly<Record<string, unknown>>; ignoreConstraints?: true; convertToTextPath?: true }>
  | Readonly<{ type: "remove"; nodeId: string }>
  | Readonly<{
      type: "boolean";
      node: RuntimeProjectionNode;
      operandIds: readonly string[];
      operandPatches: readonly Readonly<Record<string, unknown>>[];
      siblingIndexes: readonly Readonly<{ nodeId: string; siblingIndex: number }>[];
      wrapperPatch: Readonly<Record<string, unknown>>;
      operation: "union" | "subtract" | "intersect" | "exclude";
    }>
  | Readonly<{
      type: "transformGroup";
      node: RuntimeProjectionNode;
      childIds: readonly string[];
      childPatches: readonly Readonly<Record<string, unknown>>[];
      siblingIndexes: readonly Readonly<{ nodeId: string; siblingIndex: number }>[];
      modifiers: readonly DocumentTransformModifier[];
      wrapperPatch: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      type: "flattenBoolean";
      booleanId: string;
      operandIds: readonly string[];
      replacement: RuntimeProjectionNode;
      siblingIndexes: readonly Readonly<{ nodeId: string; siblingIndex: number }>[];
    }>;

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
  private confirmedNodeMap: ReadonlyMap<string, RuntimeProjectionNode>;
  private readonly pending = new Map<string, PendingEntry>();
  private composedCache?: ReadonlyMap<string, RuntimeProjectionNode>;

  constructor(initial: RuntimeProjection) {
    this.confirmed = freezeProjection(initial);
    this.confirmedNodeMap = indexProjection(this.confirmed);
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

    validateOperations(this.composedNodeMap(), transaction.operations, transaction.transactionId);
    this.pending.set(transaction.transactionId, { transaction: freezeTransaction(transaction) });
    this.invalidateComposedCache();
  }

  /** Adds synchronous writes to the transaction currently being coalesced in
   * this event turn. The entry is immutable to callers, but its local
   * PendingProjection remains one atomic Core batch until it is acknowledged. */
  append(transactionId: string, operations: readonly PendingProjectionOperation[]): void {
    const entry = this.pending.get(transactionId);
    if (!entry || entry.acceptedRevision !== undefined || !operations.length) {
      throw runtimeError("INVALID_ARGUMENT", { transactionId });
    }
    const transaction = freezeTransaction({
      ...entry.transaction,
      operations: [...entry.transaction.operations, ...operations],
    });
    this.validatePendingReplacement(transactionId, transaction);
    this.pending.set(transactionId, { transaction });
    this.invalidateComposedCache();
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
    this.confirmedNodeMap = indexProjection(this.confirmed);
    const committedTransactionIds: string[] = [];
    for (const [transactionId, entry] of this.pending) {
      if (entry.acceptedRevision === projection.revision) {
        this.pending.delete(transactionId);
        committedTransactionIds.push(transactionId);
      }
    }
    this.invalidateComposedCache();
    return { committedTransactionIds };
  }

  rollback(transactionId: string): void {
    if (!this.pending.delete(transactionId)) throw runtimeError("INVALID_ARGUMENT", { transactionId });
    this.invalidateComposedCache();
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

  private composedNodeMap(): ReadonlyMap<string, RuntimeProjectionNode> {
    if (this.composedCache) return this.composedCache;
    const nodes = new Map(this.confirmedNodeMap);
    for (const { transaction } of this.pending.values()) applyOperations(nodes, transaction.operations, transaction.transactionId);
    this.composedCache = nodes;
    return this.composedCache;
  }

  private invalidateComposedCache(): void {
    this.composedCache = undefined;
  }

  private validatePendingReplacement(transactionId: string, replacement: PendingProjectionTransaction): void {
    const nodes = new Map(this.confirmedNodeMap);
    for (const [candidateId, entry] of this.pending) {
      const transaction = candidateId === transactionId ? replacement : entry.transaction;
      applyOperations(nodes, transaction.operations, transaction.transactionId);
    }
  }
}

function validateOperations(
  base: ReadonlyMap<string, RuntimeProjectionNode>,
  operations: readonly PendingProjectionOperation[],
  transactionId: string,
): void {
  const overlay = new Map<string, RuntimeProjectionNode>();
  const read = (nodeId: string) => overlay.get(nodeId) ?? base.get(nodeId);
  for (const operation of operations) {
    if (operation.type === "create" || operation.type === "boolean" || operation.type === "transformGroup") {
      if (!operation.node.id || !operation.node.type || read(operation.node.id)) {
        throw runtimeError("INVALID_ARGUMENT", { transactionId, nodeId: operation.node.id });
      }
      if (operation.type === "boolean") {
        validateBooleanOperation(read, operation, transactionId);
      }
      if (operation.type === "transformGroup") {
        validateTransformGroupOperation(read, operation, transactionId);
      }
      overlay.set(operation.node.id, cloneNode({ ...operation.node, ...(operation.type === "transformGroup" ? operation.wrapperPatch : {}), removed: false }));
      if (operation.type === "boolean") {
        operation.operandIds.forEach((nodeId, siblingIndex) => {
          const node = read(nodeId)!;
          overlay.set(nodeId, cloneNode({ ...node, ...operation.operandPatches[siblingIndex], parentId: operation.node.id, siblingIndex }));
        });
        operation.siblingIndexes.forEach(({ nodeId, siblingIndex }) => {
          overlay.set(nodeId, cloneNode({ ...read(nodeId)!, siblingIndex }));
        });
      }
      if (operation.type === "transformGroup") {
        operation.childIds.forEach((nodeId, siblingIndex) => {
          const node = read(nodeId)!;
          overlay.set(nodeId, cloneNode({ ...node, ...operation.childPatches[siblingIndex], parentId: operation.node.id, siblingIndex }));
        });
        operation.siblingIndexes.forEach(({ nodeId, siblingIndex }) => {
          overlay.set(nodeId, cloneNode({ ...read(nodeId)!, siblingIndex }));
        });
      }
      continue;
    }

    if (operation.type === "flattenBoolean") {
      validateFlattenOperation(read, operation, transactionId);
      overlay.set(operation.replacement.id, cloneNode({ ...operation.replacement, removed: false }));
      operation.operandIds.forEach((nodeId) => overlay.set(nodeId, cloneNode({ ...read(nodeId)!, removed: true })));
      overlay.set(operation.booleanId, cloneNode({ ...read(operation.booleanId)!, removed: true }));
      operation.siblingIndexes.forEach(({ nodeId, siblingIndex }) => overlay.set(nodeId, cloneNode({ ...read(nodeId)!, siblingIndex })));
      continue;
    }

    const node = read(operation.nodeId);
    if (!node) throw runtimeError("NODE_NOT_FOUND", { transactionId, nodeId: operation.nodeId });
    if (node.removed === true) throw runtimeError("NODE_REMOVED", { transactionId, nodeId: operation.nodeId });
    if (operation.type === "remove") {
      overlay.set(operation.nodeId, cloneNode({ ...node, removed: true }));
      continue;
    }
    validatePatch(operation.patch, transactionId, operation.nodeId, operation.convertToTextPath === true);
    overlay.set(operation.nodeId, cloneNode({ ...node, ...operation.patch }));
  }
}

function applyOperations(
  nodes: Map<string, RuntimeProjectionNode>,
  operations: readonly PendingProjectionOperation[],
  transactionId: string,
): void {
  for (const operation of operations) {
    if (operation.type === "create" || operation.type === "boolean" || operation.type === "transformGroup") {
      if (!operation.node.id || !operation.node.type || nodes.has(operation.node.id)) {
        throw runtimeError("INVALID_ARGUMENT", { transactionId, nodeId: operation.node.id });
      }
      if (operation.type === "boolean") validateBooleanOperation((nodeId) => nodes.get(nodeId), operation, transactionId);
      if (operation.type === "transformGroup") validateTransformGroupOperation((nodeId) => nodes.get(nodeId), operation, transactionId);
      nodes.set(operation.node.id, cloneNode({ ...operation.node, ...(operation.type === "transformGroup" ? operation.wrapperPatch : {}), removed: false }));
      if (operation.type === "boolean") {
        operation.operandIds.forEach((nodeId, siblingIndex) => {
          nodes.set(nodeId, cloneNode({ ...nodes.get(nodeId)!, ...operation.operandPatches[siblingIndex], parentId: operation.node.id, siblingIndex }));
        });
        operation.siblingIndexes.forEach(({ nodeId, siblingIndex }) => {
          nodes.set(nodeId, cloneNode({ ...nodes.get(nodeId)!, siblingIndex }));
        });
      }
      if (operation.type === "transformGroup") {
        operation.childIds.forEach((nodeId, siblingIndex) => {
          nodes.set(nodeId, cloneNode({ ...nodes.get(nodeId)!, ...operation.childPatches[siblingIndex], parentId: operation.node.id, siblingIndex }));
        });
        operation.siblingIndexes.forEach(({ nodeId, siblingIndex }) => {
          nodes.set(nodeId, cloneNode({ ...nodes.get(nodeId)!, siblingIndex }));
        });
      }
      continue;
    }

    if (operation.type === "flattenBoolean") {
      validateFlattenOperation((nodeId) => nodes.get(nodeId), operation, transactionId);
      nodes.set(operation.replacement.id, cloneNode({ ...operation.replacement, removed: false }));
      operation.operandIds.forEach((nodeId) => nodes.set(nodeId, cloneNode({ ...nodes.get(nodeId)!, removed: true })));
      nodes.set(operation.booleanId, cloneNode({ ...nodes.get(operation.booleanId)!, removed: true }));
      operation.siblingIndexes.forEach(({ nodeId, siblingIndex }) => nodes.set(nodeId, cloneNode({ ...nodes.get(nodeId)!, siblingIndex })));
      continue;
    }

    const node = nodes.get(operation.nodeId);
    if (!node) throw runtimeError("NODE_NOT_FOUND", { transactionId, nodeId: operation.nodeId });
    if (node.removed === true) throw runtimeError("NODE_REMOVED", { transactionId, nodeId: operation.nodeId });

    if (operation.type === "remove") {
      nodes.set(operation.nodeId, cloneNode({ ...node, removed: true }));
      continue;
    }

    validatePatch(operation.patch, transactionId, operation.nodeId, operation.convertToTextPath === true);
    nodes.set(operation.nodeId, cloneNode({ ...node, ...operation.patch }));
  }
}

function validateBooleanOperation(
  read: (nodeId: string) => RuntimeProjectionNode | undefined,
  operation: Extract<PendingProjectionOperation, { type: "boolean" }>,
  transactionId: string,
): void {
  if (
    operation.node.type !== "BOOLEAN_OPERATION" ||
    operation.operandIds.length < 2 ||
    new Set(operation.operandIds).size !== operation.operandIds.length ||
    operation.operandPatches.length !== operation.operandIds.length ||
    !["union", "subtract", "intersect", "exclude"].includes(operation.operation)
  ) throw runtimeError("INVALID_ARGUMENT", { transactionId, nodeId: operation.node.id });
  for (const nodeId of operation.operandIds) {
    const node = read(nodeId);
    if (!node) throw runtimeError("NODE_NOT_FOUND", { transactionId, nodeId });
    if (node.removed === true) throw runtimeError("NODE_REMOVED", { transactionId, nodeId });
    if (node.type !== "VECTOR" || projectionPageId(read, node) !== projectionPageId(read, operation.node)) {
      throw runtimeError("INVALID_ARGUMENT", { transactionId, nodeId });
    }
  }
  if (new Set(operation.siblingIndexes.map(({ nodeId }) => nodeId)).size !== operation.siblingIndexes.length) {
    throw runtimeError("INVALID_ARGUMENT", { transactionId, nodeId: operation.node.id });
  }
  const occupiedSiblingSlots = new Set<string>();
  for (const { nodeId, siblingIndex } of operation.siblingIndexes) {
    const node = read(nodeId);
    const slot = `${node?.parentId ?? "<root>"}:${siblingIndex}`;
    if (!node || node.removed === true || projectionPageId(read, node) !== projectionPageId(read, operation.node) || operation.operandIds.includes(nodeId) || !Number.isSafeInteger(siblingIndex) || siblingIndex < 0 || occupiedSiblingSlots.has(slot)) {
      throw runtimeError("INVALID_ARGUMENT", { transactionId, nodeId });
    }
    occupiedSiblingSlots.add(slot);
  }
}

function validateTransformGroupOperation(
  read: (nodeId: string) => RuntimeProjectionNode | undefined,
  operation: Extract<PendingProjectionOperation, { type: "transformGroup" }>,
  transactionId: string,
): void {
  if (
    operation.node.type !== "TRANSFORM_GROUP" ||
    operation.childIds.length < 1 ||
    new Set(operation.childIds).size !== operation.childIds.length ||
    operation.childPatches.length !== operation.childIds.length ||
    !isBoundedTransformModifierStack(operation.modifiers)
  ) throw runtimeError("INVALID_ARGUMENT", { transactionId, nodeId: operation.node.id });
  for (const nodeId of operation.childIds) {
    const node = read(nodeId);
    if (!node) throw runtimeError("NODE_NOT_FOUND", { transactionId, nodeId });
    if (node.removed === true) throw runtimeError("NODE_REMOVED", { transactionId, nodeId });
    if (node.type === "DOCUMENT" || node.type === "PAGE" || projectionPageId(read, node) !== projectionPageId(read, operation.node)) {
      throw runtimeError("INVALID_ARGUMENT", { transactionId, nodeId });
    }
  }
  if (new Set(operation.siblingIndexes.map(({ nodeId }) => nodeId)).size !== operation.siblingIndexes.length) {
    throw runtimeError("INVALID_ARGUMENT", { transactionId, nodeId: operation.node.id });
  }
  for (const { nodeId, siblingIndex } of operation.siblingIndexes) {
    const node = read(nodeId);
    if (!node || node.removed === true || operation.childIds.includes(nodeId) || !Number.isSafeInteger(siblingIndex) || siblingIndex < 0) {
      throw runtimeError("INVALID_ARGUMENT", { transactionId, nodeId });
    }
  }
}

function projectionPageId(
  read: (nodeId: string) => RuntimeProjectionNode | undefined,
  node: RuntimeProjectionNode,
): string | undefined {
  let current: RuntimeProjectionNode | undefined = node;
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    if (current.type === "PAGE") return current.id;
    visited.add(current.id);
    if (typeof current.pageId === "string") return current.pageId;
    current = typeof current.parentId === "string" ? read(current.parentId) : undefined;
  }
  return undefined;
}

function validateFlattenOperation(
  read: (nodeId: string) => RuntimeProjectionNode | undefined,
  operation: Extract<PendingProjectionOperation, { type: "flattenBoolean" }>,
  transactionId: string,
): void {
  const boolean = read(operation.booleanId);
  if (!boolean) throw runtimeError("NODE_NOT_FOUND", { transactionId, nodeId: operation.booleanId });
  if (boolean.removed === true) throw runtimeError("NODE_REMOVED", { transactionId, nodeId: operation.booleanId });
  if (
    boolean.type !== "BOOLEAN_OPERATION" ||
    !operation.replacement.id ||
    operation.replacement.type !== "VECTOR" ||
    read(operation.replacement.id) ||
    operation.operandIds.length < 2 ||
    new Set(operation.operandIds).size !== operation.operandIds.length ||
    projectionPageId(read, boolean) !== projectionPageId(read, operation.replacement) ||
    new Set(operation.siblingIndexes.map(({ nodeId }) => nodeId)).size !== operation.siblingIndexes.length
  ) throw runtimeError("INVALID_ARGUMENT", { transactionId, nodeId: operation.booleanId });
  for (const nodeId of operation.operandIds) {
    const node = read(nodeId);
    if (!node) throw runtimeError("NODE_NOT_FOUND", { transactionId, nodeId });
    if (node.removed === true) throw runtimeError("NODE_REMOVED", { transactionId, nodeId });
    if (node.parentId !== operation.booleanId || node.type !== "VECTOR") throw runtimeError("INVALID_ARGUMENT", { transactionId, nodeId });
  }
  const occupiedSiblingSlots = new Set<string>();
  for (const { nodeId, siblingIndex } of operation.siblingIndexes) {
    const node = read(nodeId);
    const slot = `${node?.parentId ?? "<root>"}:${siblingIndex}`;
    if (!node || node.removed === true || nodeId === operation.booleanId || operation.operandIds.includes(nodeId) || !Number.isSafeInteger(siblingIndex) || siblingIndex < 0 || occupiedSiblingSlots.has(slot)) {
      throw runtimeError("INVALID_ARGUMENT", { transactionId, nodeId });
    }
    occupiedSiblingSlots.add(slot);
  }
}

function validatePatch(patch: Readonly<Record<string, unknown>>, transactionId: string, nodeId: string, convertToTextPath = false): void {
  if (Object.hasOwn(patch, "id") || Object.hasOwn(patch, "removed") || (Object.hasOwn(patch, "type") && (!convertToTextPath || patch.type !== "TEXT_PATH"))) {
    throw runtimeError("INVALID_ARGUMENT", { transactionId, nodeId });
  }
}

function indexProjection(projection: RuntimeProjection): ReadonlyMap<string, RuntimeProjectionNode> {
  return new Map(projection.nodes.map((node) => [node.id, node]));
}

function freezeProjection(projection: RuntimeProjection): RuntimeProjection {
  if (!Number.isSafeInteger(projection.revision) || projection.revision < 0) throw runtimeError("INVALID_ARGUMENT", { revision: projection.revision });
  const ids = new Set<string>();
  const nodes = projection.nodes.map((node) => {
    if (!node.id || !node.type || ids.has(node.id)) throw runtimeError("INVALID_ARGUMENT", { nodeId: node.id });
    ids.add(node.id);
    return cloneNode(node);
  });
  const textStyles = projection.textStyles?.map((style) => deepFreeze(structuredClone(style)));
  return Object.freeze({
    revision: projection.revision,
    nodes: Object.freeze(nodes),
    ...(textStyles ? { textStyles: Object.freeze(textStyles) } : {}),
  });
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
