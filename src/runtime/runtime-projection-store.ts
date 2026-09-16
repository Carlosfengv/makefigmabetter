import { runtimeError } from "./runtime-errors";
import type { DocumentTransformModifier } from "../lib/editor-protocol";
import type { DocumentPaintStyleResource, DocumentTextStyleResource, DocumentVariableCollectionResource, DocumentVariableResource } from "../lib/editor-protocol";
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
  paintStyles?: readonly DocumentPaintStyleResource[];
  variableCollections?: readonly DocumentVariableCollectionResource[];
  variables?: readonly DocumentVariableResource[];
}>;

export type PendingProjectionOperation =
  | Readonly<{ type: "registerTextStyle"; style: DocumentTextStyleResource }>
  | Readonly<{ type: "registerPaintStyle"; style: DocumentPaintStyleResource }>
  | Readonly<{ type: "registerVariableCollection"; collection: DocumentVariableCollectionResource }>
  | Readonly<{ type: "registerVariable"; variable: DocumentVariableResource }>
  | Readonly<{ type: "setVariable"; variable: DocumentVariableResource }>
  | Readonly<{ type: "deleteVariable"; id: string }>
  | Readonly<{ type: "setVariableCollection"; collection: DocumentVariableCollectionResource; variables: readonly DocumentVariableResource[] }>
  | Readonly<{ type: "deleteVariableCollection"; id: string }>
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
      type: "componentSet";
      node: RuntimeProjectionNode;
      childIds: readonly string[];
      childPatches: readonly Readonly<Record<string, unknown>>[];
      siblingIndexes: readonly Readonly<{ nodeId: string; siblingIndex: number }>[];
    }>
  | Readonly<{
      type: "flattenBoolean";
      booleanId: string;
      operandIds: readonly string[];
      replacement: RuntimeProjectionNode;
      siblingIndexes: readonly Readonly<{ nodeId: string; siblingIndex: number }>[];
    }>
  | Readonly<{
      type: "flattenNode";
      sourceId: string;
      replacement: RuntimeProjectionNode;
      siblingIndexes: readonly Readonly<{ nodeId: string; siblingIndex: number }>[];
    }>
  | Readonly<{
      type: "componentFromNode";
      sourceId: string;
      replacement: RuntimeProjectionNode;
      childIds: readonly string[];
      temporaryPositionId: string;
      finalPositionId: string;
    }>
  | Readonly<{
      type: "replaceContainer";
      sourceId: string;
      replacement: RuntimeProjectionNode;
      childIds: readonly string[];
      temporaryPositionId: string;
      finalPositionId: string;
    }>
  | Readonly<{
      type: "detachInstance";
      sourceId: string;
      sourceIds: readonly string[];
      replacements: readonly RuntimeProjectionNode[];
      temporaryPositionId: string;
      finalPositionId: string;
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

    validateResourceOperations(
      this.listTextStyles(),
      this.listPaintStyles(),
      this.listVariableCollections(),
      this.listVariables(),
      transaction.operations,
      transaction.transactionId,
    );
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

  listTextStyles(): readonly DocumentTextStyleResource[] {
    const styles = new Map((this.confirmed.textStyles ?? []).map((value) => [value.id, value]));
    for (const { transaction } of this.pending.values()) {
      for (const operation of transaction.operations) {
        if (operation.type === "registerTextStyle") styles.set(operation.style.id, operation.style);
      }
    }
    return [...styles.values()];
  }

  listPaintStyles(): readonly DocumentPaintStyleResource[] {
    const styles = new Map((this.confirmed.paintStyles ?? []).map((value) => [value.id, value]));
    for (const { transaction } of this.pending.values()) {
      for (const operation of transaction.operations) {
        if (operation.type === "registerPaintStyle") styles.set(operation.style.id, operation.style);
      }
    }
    return [...styles.values()];
  }

  listVariableCollections(): readonly DocumentVariableCollectionResource[] {
    const collections = new Map((this.confirmed.variableCollections ?? []).map((value) => [value.id, value]));
    for (const { transaction } of this.pending.values()) {
      for (const operation of transaction.operations) {
        if (operation.type === "registerVariableCollection") collections.set(operation.collection.id, operation.collection);
        if (operation.type === "setVariableCollection") collections.set(operation.collection.id, operation.collection);
        if (operation.type === "deleteVariableCollection") collections.delete(operation.id);
      }
    }
    return [...collections.values()];
  }

  listVariables(): readonly DocumentVariableResource[] {
    const variables = new Map((this.confirmed.variables ?? []).map((value) => [value.id, value]));
    for (const { transaction } of this.pending.values()) {
      for (const operation of transaction.operations) {
        if (operation.type === "registerVariable") variables.set(operation.variable.id, operation.variable);
        if (operation.type === "setVariable") variables.set(operation.variable.id, operation.variable);
        if (operation.type === "deleteVariable") variables.delete(operation.id);
        if (operation.type === "setVariableCollection") {
          [...variables.values()].filter((value) => value.collectionId === operation.collection.id).forEach((value) => variables.delete(value.id));
          operation.variables.forEach((value) => variables.set(value.id, value));
        }
        if (operation.type === "deleteVariableCollection") {
          [...variables.values()].filter((value) => value.collectionId === operation.id).forEach((value) => variables.delete(value.id));
        }
      }
    }
    return [...variables.values()];
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
    const textStyles = new Map((this.confirmed.textStyles ?? []).map((value) => [value.id, value]));
    const paintStyles = new Map((this.confirmed.paintStyles ?? []).map((value) => [value.id, value]));
    const collections = new Map((this.confirmed.variableCollections ?? []).map((value) => [value.id, value]));
    const variables = new Map((this.confirmed.variables ?? []).map((value) => [value.id, value]));
    for (const [candidateId, entry] of this.pending) {
      const transaction = candidateId === transactionId ? replacement : entry.transaction;
      validateResourceOperations(
        [...textStyles.values()],
        [...paintStyles.values()],
        [...collections.values()],
        [...variables.values()],
        transaction.operations,
        transaction.transactionId,
      );
      applyResourceOperations(textStyles, paintStyles, collections, variables, transaction.operations);
      applyOperations(nodes, transaction.operations, transaction.transactionId);
    }
  }
}

function validateResourceOperations(
  baseTextStyles: readonly DocumentTextStyleResource[],
  basePaintStyles: readonly DocumentPaintStyleResource[],
  baseCollections: readonly DocumentVariableCollectionResource[],
  baseVariables: readonly DocumentVariableResource[],
  operations: readonly PendingProjectionOperation[],
  transactionId: string,
): void {
  const textStyles = new Map(baseTextStyles.map((value) => [value.id, value]));
  const paintStyles = new Map(basePaintStyles.map((value) => [value.id, value]));
  const collections = new Map(baseCollections.map((value) => [value.id, value]));
  const variables = new Map(baseVariables.map((value) => [value.id, value]));
  for (const operation of operations) {
    if (operation.type === "registerTextStyle") {
      const value = operation.style;
      if (!validPendingStyleIdentity(value) || value.remote || textStyles.has(value.id) || paintStyles.has(value.id)
        || !Number.isFinite(value.style.fontSize) || value.style.fontSize <= 0
        || !Number.isFinite(value.style.letterSpacing) || !Number.isFinite(value.paragraph.paragraphSpacing)) {
        throw runtimeError("INVALID_ARGUMENT", { transactionId });
      }
      textStyles.set(value.id, value);
    } else if (operation.type === "registerPaintStyle") {
      const value = operation.style;
      if (!validPendingStyleIdentity(value) || value.remote || textStyles.has(value.id) || paintStyles.has(value.id)
        || !value.paints || !Array.isArray(value.paints.layers)) {
        throw runtimeError("INVALID_ARGUMENT", { transactionId });
      }
      paintStyles.set(value.id, value);
    } else if (operation.type === "registerVariableCollection") {
      const value = operation.collection;
      if (!value.id || !value.name.trim() || collections.has(value.id) || !value.modes.length || !value.modes.some((mode) => mode.modeId === value.defaultModeId)) {
        throw runtimeError("INVALID_ARGUMENT", { transactionId });
      }
      collections.set(value.id, value);
    } else if (operation.type === "registerVariable") {
      const value = operation.variable;
      const collection = collections.get(value.collectionId);
      if (!value.id || !value.name.trim() || variables.has(value.id) || !collection || collection.modes.some((mode) => value.valuesByMode[mode.modeId] === undefined)) {
        throw runtimeError("INVALID_ARGUMENT", { transactionId });
      }
      variables.set(value.id, value);
      validateVariableAliases(variables, transactionId);
    } else if (operation.type === "setVariable") {
      const value = operation.variable;
      const before = variables.get(value.id);
      const collection = collections.get(value.collectionId);
      if (!before || before.remote || !collection || before.key !== value.key || before.remote !== value.remote || before.collectionId !== value.collectionId || before.resolvedType !== value.resolvedType || !value.name.trim() || collection.modes.some((mode) => value.valuesByMode[mode.modeId] === undefined)) {
        throw runtimeError("INVALID_ARGUMENT", { transactionId });
      }
      variables.set(value.id, value);
      validateVariableAliases(variables, transactionId);
    } else if (operation.type === "deleteVariable") {
      if (variables.get(operation.id)?.remote !== false || [...variables.values()].some((value) => value.id !== operation.id && Object.values(value.valuesByMode).some((candidate) => typeof candidate === "object" && candidate !== null && "type" in candidate && candidate.type === "VARIABLE_ALIAS" && candidate.id === operation.id))) {
        throw runtimeError("INVALID_ARGUMENT", { transactionId });
      }
      variables.delete(operation.id);
    } else if (operation.type === "setVariableCollection") {
      const before = collections.get(operation.collection.id);
      const current = [...variables.values()].filter((value) => value.collectionId === operation.collection.id);
      if (!before || before.remote || before.key !== operation.collection.key || operation.collection.remote || current.length !== operation.variables.length || new Set(operation.variables.map((value) => value.id)).size !== current.length || current.some((value) => !operation.variables.some((candidate) => candidate.id === value.id))) {
        throw runtimeError("INVALID_ARGUMENT", { transactionId });
      }
      collections.set(operation.collection.id, operation.collection);
      current.forEach((value) => variables.delete(value.id));
      operation.variables.forEach((value) => variables.set(value.id, value));
      validateVariableAliases(variables, transactionId);
    } else if (operation.type === "deleteVariableCollection") {
      const collection = collections.get(operation.id);
      if (!collection || collection.remote) throw runtimeError("INVALID_ARGUMENT", { transactionId });
      const removed = new Set([...variables.values()].filter((value) => value.collectionId === operation.id).map((value) => value.id));
      if ([...variables.values()].some((value) => value.collectionId !== operation.id && Object.values(value.valuesByMode).some((candidate) => typeof candidate === "object" && candidate !== null && "type" in candidate && candidate.type === "VARIABLE_ALIAS" && removed.has(candidate.id)))) throw runtimeError("INVALID_ARGUMENT", { transactionId });
      removed.forEach((id) => variables.delete(id));
      collections.delete(operation.id);
    }
  }
}

function validPendingStyleIdentity(value: DocumentTextStyleResource | DocumentPaintStyleResource): boolean {
  return Boolean(value.id && !value.id.includes("\0") && value.name.trim() && !value.name.includes("\0")
    && !value.description.includes("\0") && value.key === "");
}

function validateVariableAliases(variables: ReadonlyMap<string, DocumentVariableResource>, transactionId: string): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw runtimeError("INVALID_ARGUMENT", { transactionId });
    if (visited.has(id)) return;
    const variable = variables.get(id);
    if (!variable) throw runtimeError("INVALID_ARGUMENT", { transactionId });
    visiting.add(id);
    for (const value of Object.values(variable.valuesByMode)) {
      if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "VARIABLE_ALIAS") continue;
      const target = variables.get(value.id);
      if (!target || target.resolvedType !== variable.resolvedType) throw runtimeError("INVALID_ARGUMENT", { transactionId });
      visit(target.id);
    }
    visiting.delete(id);
    visited.add(id);
  };
  variables.forEach((_value, id) => visit(id));
}

function applyResourceOperations(
  textStyles: Map<string, DocumentTextStyleResource>,
  paintStyles: Map<string, DocumentPaintStyleResource>,
  collections: Map<string, DocumentVariableCollectionResource>,
  variables: Map<string, DocumentVariableResource>,
  operations: readonly PendingProjectionOperation[],
): void {
  for (const operation of operations) {
    if (operation.type === "registerTextStyle") textStyles.set(operation.style.id, operation.style);
    if (operation.type === "registerPaintStyle") paintStyles.set(operation.style.id, operation.style);
    if (operation.type === "registerVariableCollection") collections.set(operation.collection.id, operation.collection);
    if (operation.type === "registerVariable") variables.set(operation.variable.id, operation.variable);
    if (operation.type === "setVariable") variables.set(operation.variable.id, operation.variable);
    if (operation.type === "deleteVariable") variables.delete(operation.id);
    if (operation.type === "setVariableCollection") {
      collections.set(operation.collection.id, operation.collection);
      [...variables.values()].filter((value) => value.collectionId === operation.collection.id).forEach((value) => variables.delete(value.id));
      operation.variables.forEach((value) => variables.set(value.id, value));
    }
    if (operation.type === "deleteVariableCollection") {
      collections.delete(operation.id);
      [...variables.values()].filter((value) => value.collectionId === operation.id).forEach((value) => variables.delete(value.id));
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
  const structural = createStructuralProjectionIndex(
    read,
    () => new Set([...base.keys(), ...overlay.keys()]),
    (nodeId, node) => overlay.set(nodeId, node),
  );
  for (const operation of operations) {
    if (operation.type === "registerTextStyle" || operation.type === "registerPaintStyle" || operation.type === "registerVariableCollection" || operation.type === "registerVariable" || operation.type === "setVariable" || operation.type === "deleteVariable" || operation.type === "setVariableCollection" || operation.type === "deleteVariableCollection") continue;
    if (operation.type !== "update" && operation.type !== "remove") structural.invalidate();
    if (operation.type === "create" || operation.type === "boolean" || operation.type === "transformGroup" || operation.type === "componentSet") {
      if (!operation.node.id || !operation.node.type || read(operation.node.id)) {
        throw runtimeError("INVALID_ARGUMENT", { transactionId, nodeId: operation.node.id });
      }
      if (operation.type === "boolean") {
        validateBooleanOperation(read, operation, transactionId);
      }
      if (operation.type === "transformGroup") {
        validateTransformGroupOperation(read, operation, transactionId);
      }
      if (operation.type === "componentSet") {
        validateComponentSetOperation(read, operation, transactionId);
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
      if (operation.type === "componentSet") {
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

    if (operation.type === "flattenNode") {
      validateFlattenNodeOperation(read, operation, transactionId);
      overlay.set(operation.replacement.id, cloneNode({ ...operation.replacement, removed: false }));
      overlay.set(operation.sourceId, cloneNode({ ...read(operation.sourceId)!, removed: true }));
      operation.siblingIndexes.forEach(({ nodeId, siblingIndex }) => overlay.set(nodeId, cloneNode({ ...read(nodeId)!, siblingIndex })));
      continue;
    }

    if (operation.type === "componentFromNode") {
      validateComponentFromNodeOperation(read, operation, transactionId);
      overlay.set(operation.replacement.id, cloneNode({ ...operation.replacement, positionId: operation.finalPositionId, removed: false }));
      operation.childIds.forEach((nodeId, siblingIndex) => {
        overlay.set(nodeId, cloneNode({ ...read(nodeId)!, parentId: operation.replacement.id, siblingIndex }));
      });
      overlay.set(operation.sourceId, cloneNode({ ...read(operation.sourceId)!, removed: true }));
      continue;
    }

    if (operation.type === "replaceContainer") {
      validateReplaceContainerOperation(read, operation, transactionId);
      overlay.set(operation.replacement.id, cloneNode({ ...operation.replacement, positionId: operation.finalPositionId, removed: false }));
      operation.childIds.forEach((nodeId, siblingIndex) => {
        overlay.set(nodeId, cloneNode({ ...read(nodeId)!, parentId: operation.replacement.id, siblingIndex }));
      });
      overlay.set(operation.sourceId, cloneNode({ ...read(operation.sourceId)!, removed: true }));
      continue;
    }

    if (operation.type === "detachInstance") {
      validateDetachInstanceOperation(read, operation, transactionId);
      operation.replacements.forEach((replacement, index) => {
        overlay.set(replacement.id, cloneNode({
          ...replacement,
          ...(index === 0 ? { positionId: operation.finalPositionId } : {}),
          removed: false,
        }));
      });
      operation.sourceIds.forEach((nodeId) => overlay.set(nodeId, cloneNode({ ...read(nodeId)!, removed: true })));
      continue;
    }

    const node = read(operation.nodeId);
    if (!node) throw runtimeError("NODE_NOT_FOUND", { transactionId, nodeId: operation.nodeId });
    if (node.removed === true) throw runtimeError("NODE_REMOVED", { transactionId, nodeId: operation.nodeId });
    if (operation.type === "remove") {
      overlay.set(operation.nodeId, cloneNode({ ...node, removed: true }));
      structural.noteRemove(node.id, typeof node.parentId === "string" ? node.parentId : undefined);
      structural.dissolveFrom(typeof node.parentId === "string" ? node.parentId : undefined);
      continue;
    }
    validatePatch(operation.patch, transactionId, operation.nodeId, operation.convertToTextPath === true);
    overlay.set(operation.nodeId, cloneNode({ ...node, ...operation.patch }));
    if (Object.hasOwn(operation.patch, "parentId") && operation.patch.parentId !== node.parentId) {
      const beforeParentId = typeof node.parentId === "string" ? node.parentId : undefined;
      const afterParentId = typeof operation.patch.parentId === "string" ? operation.patch.parentId : undefined;
      structural.noteMove(node.id, beforeParentId, afterParentId);
      structural.dissolveFrom(beforeParentId);
    }
  }
}

function applyOperations(
  nodes: Map<string, RuntimeProjectionNode>,
  operations: readonly PendingProjectionOperation[],
  transactionId: string,
): void {
  const structural = createStructuralProjectionIndex(
    (nodeId) => nodes.get(nodeId),
    () => nodes.keys(),
    (nodeId, node) => nodes.set(nodeId, node),
  );
  for (const operation of operations) {
    if (operation.type === "registerTextStyle" || operation.type === "registerPaintStyle" || operation.type === "registerVariableCollection" || operation.type === "registerVariable" || operation.type === "setVariable" || operation.type === "deleteVariable" || operation.type === "setVariableCollection" || operation.type === "deleteVariableCollection") continue;
    if (operation.type !== "update" && operation.type !== "remove") structural.invalidate();
    if (operation.type === "create" || operation.type === "boolean" || operation.type === "transformGroup" || operation.type === "componentSet") {
      if (!operation.node.id || !operation.node.type || nodes.has(operation.node.id)) {
        throw runtimeError("INVALID_ARGUMENT", { transactionId, nodeId: operation.node.id });
      }
      if (operation.type === "boolean") validateBooleanOperation((nodeId) => nodes.get(nodeId), operation, transactionId);
      if (operation.type === "transformGroup") validateTransformGroupOperation((nodeId) => nodes.get(nodeId), operation, transactionId);
      if (operation.type === "componentSet") validateComponentSetOperation((nodeId) => nodes.get(nodeId), operation, transactionId);
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
      if (operation.type === "componentSet") {
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

    if (operation.type === "flattenNode") {
      validateFlattenNodeOperation((nodeId) => nodes.get(nodeId), operation, transactionId);
      nodes.set(operation.replacement.id, cloneNode({ ...operation.replacement, removed: false }));
      nodes.set(operation.sourceId, cloneNode({ ...nodes.get(operation.sourceId)!, removed: true }));
      operation.siblingIndexes.forEach(({ nodeId, siblingIndex }) => nodes.set(nodeId, cloneNode({ ...nodes.get(nodeId)!, siblingIndex })));
      continue;
    }

    if (operation.type === "componentFromNode") {
      validateComponentFromNodeOperation((nodeId) => nodes.get(nodeId), operation, transactionId);
      nodes.set(operation.replacement.id, cloneNode({ ...operation.replacement, positionId: operation.finalPositionId, removed: false }));
      operation.childIds.forEach((nodeId, siblingIndex) => {
        nodes.set(nodeId, cloneNode({ ...nodes.get(nodeId)!, parentId: operation.replacement.id, siblingIndex }));
      });
      nodes.set(operation.sourceId, cloneNode({ ...nodes.get(operation.sourceId)!, removed: true }));
      continue;
    }

    if (operation.type === "replaceContainer") {
      validateReplaceContainerOperation((nodeId) => nodes.get(nodeId), operation, transactionId);
      nodes.set(operation.replacement.id, cloneNode({ ...operation.replacement, positionId: operation.finalPositionId, removed: false }));
      operation.childIds.forEach((nodeId, siblingIndex) => {
        nodes.set(nodeId, cloneNode({ ...nodes.get(nodeId)!, parentId: operation.replacement.id, siblingIndex }));
      });
      nodes.set(operation.sourceId, cloneNode({ ...nodes.get(operation.sourceId)!, removed: true }));
      continue;
    }

    if (operation.type === "detachInstance") {
      validateDetachInstanceOperation((nodeId) => nodes.get(nodeId), operation, transactionId);
      operation.replacements.forEach((replacement, index) => {
        nodes.set(replacement.id, cloneNode({
          ...replacement,
          ...(index === 0 ? { positionId: operation.finalPositionId } : {}),
          removed: false,
        }));
      });
      operation.sourceIds.forEach((nodeId) => nodes.set(nodeId, cloneNode({ ...nodes.get(nodeId)!, removed: true })));
      continue;
    }

    const node = nodes.get(operation.nodeId);
    if (!node) throw runtimeError("NODE_NOT_FOUND", { transactionId, nodeId: operation.nodeId });
    if (node.removed === true) throw runtimeError("NODE_REMOVED", { transactionId, nodeId: operation.nodeId });

    if (operation.type === "remove") {
      nodes.set(operation.nodeId, cloneNode({ ...node, removed: true }));
      structural.noteRemove(node.id, typeof node.parentId === "string" ? node.parentId : undefined);
      structural.dissolveFrom(typeof node.parentId === "string" ? node.parentId : undefined);
      continue;
    }

    validatePatch(operation.patch, transactionId, operation.nodeId, operation.convertToTextPath === true);
    nodes.set(operation.nodeId, cloneNode({ ...node, ...operation.patch }));
    if (Object.hasOwn(operation.patch, "parentId") && operation.patch.parentId !== node.parentId) {
      const beforeParentId = typeof node.parentId === "string" ? node.parentId : undefined;
      const afterParentId = typeof operation.patch.parentId === "string" ? operation.patch.parentId : undefined;
      structural.noteMove(node.id, beforeParentId, afterParentId);
      structural.dissolveFrom(beforeParentId);
    }
  }
}

function createStructuralProjectionIndex(
  read: (nodeId: string) => RuntimeProjectionNode | undefined,
  nodeIds: () => Iterable<string>,
  write: (nodeId: string, node: RuntimeProjectionNode) => void,
): Readonly<{
  invalidate(): void;
  noteMove(nodeId: string, beforeParentId: string | undefined, afterParentId: string | undefined): void;
  noteRemove(nodeId: string, parentId: string | undefined): void;
  dissolveFrom(parentId: string | undefined): void;
}> {
  let childrenByParent: Map<string, Set<string>> | undefined;
  const ensure = (): Map<string, Set<string>> => {
    if (childrenByParent) return childrenByParent;
    childrenByParent = new Map();
    for (const nodeId of nodeIds()) {
      const node = read(nodeId);
      if (!node || node.removed === true || typeof node.parentId !== "string") continue;
      const children = childrenByParent.get(node.parentId) ?? new Set<string>();
      children.add(node.id);
      childrenByParent.set(node.parentId, children);
    }
    return childrenByParent;
  };
  return {
    invalidate(): void { childrenByParent = undefined; },
    noteMove(nodeId, beforeParentId, afterParentId): void {
      if (!childrenByParent) return;
      if (beforeParentId) childrenByParent.get(beforeParentId)?.delete(nodeId);
      if (afterParentId) {
        const children = childrenByParent.get(afterParentId) ?? new Set<string>();
        children.add(nodeId);
        childrenByParent.set(afterParentId, children);
      }
    },
    noteRemove(nodeId, parentId): void {
      if (childrenByParent && parentId) childrenByParent.get(parentId)?.delete(nodeId);
    },
    dissolveFrom(initialParentId): void {
      const children = ensure();
      let parentId = initialParentId;
      const visited = new Set<string>();
      while (parentId && !visited.has(parentId)) {
        visited.add(parentId);
        const container = read(parentId);
        if (!container || container.removed === true || (container.type !== "GROUP" && container.type !== "COMPONENT_SET")) return;
        if ((children.get(container.id)?.size ?? 0) > 0) return;
        write(container.id, cloneNode({ ...container, removed: true }));
        const ancestorId = typeof container.parentId === "string" ? container.parentId : undefined;
        if (ancestorId) children.get(ancestorId)?.delete(container.id);
        parentId = ancestorId;
      }
    },
  };
}

function validateComponentFromNodeOperation(
  read: (nodeId: string) => RuntimeProjectionNode | undefined,
  operation: Extract<PendingProjectionOperation, { type: "componentFromNode" }>,
  transactionId: string,
): void {
  const source = read(operation.sourceId);
  if (
    !source ||
    source.removed === true ||
    (source.type !== "FRAME" && source.type !== "GROUP") ||
    !operation.replacement.id ||
    read(operation.replacement.id) ||
    operation.replacement.type !== "COMPONENT" ||
    operation.replacement.parentId !== source.parentId ||
    operation.replacement.id === source.id ||
    !operation.temporaryPositionId ||
    !operation.finalPositionId ||
    operation.temporaryPositionId === operation.finalPositionId ||
    new Set(operation.childIds).size !== operation.childIds.length
  ) throw runtimeError("INVALID_ARGUMENT", { transactionId, nodeId: operation.sourceId });
  operation.childIds.forEach((nodeId) => {
    const child = read(nodeId);
    if (!child || child.removed === true || child.parentId !== source.id) {
      throw runtimeError("INVALID_ARGUMENT", { transactionId, nodeId });
    }
  });
}

function validateReplaceContainerOperation(
  read: (nodeId: string) => RuntimeProjectionNode | undefined,
  operation: Extract<PendingProjectionOperation, { type: "replaceContainer" }>,
  transactionId: string,
): void {
  const source = read(operation.sourceId);
  const pair = `${source?.type ?? ""}:${operation.replacement.type}`;
  if (
    !source ||
    source.removed === true ||
    !["FRAME:SLOT", "SLOT:FRAME"].includes(pair) ||
    !operation.replacement.id ||
    read(operation.replacement.id) ||
    operation.replacement.parentId !== source.parentId ||
    operation.replacement.id === source.id ||
    !operation.temporaryPositionId ||
    !operation.finalPositionId ||
    operation.temporaryPositionId === operation.finalPositionId ||
    new Set(operation.childIds).size !== operation.childIds.length
  ) throw runtimeError("INVALID_ARGUMENT", { transactionId, nodeId: operation.sourceId });
  operation.childIds.forEach((nodeId) => {
    const child = read(nodeId);
    if (!child || child.removed === true || child.parentId !== source.id) {
      throw runtimeError("INVALID_ARGUMENT", { transactionId, nodeId });
    }
  });
}

function validateDetachInstanceOperation(
  read: (nodeId: string) => RuntimeProjectionNode | undefined,
  operation: Extract<PendingProjectionOperation, { type: "detachInstance" }>,
  transactionId: string,
): void {
  const source = read(operation.sourceId);
  const sourceIds = new Set(operation.sourceIds);
  const replacementIds = new Set(operation.replacements.map((node) => node.id));
  const root = operation.replacements[0];
  if (
    !source ||
    source.removed === true ||
    source.type !== "INSTANCE" ||
    operation.sourceIds[0] !== source.id ||
    sourceIds.size !== operation.sourceIds.length ||
    replacementIds.size !== operation.replacements.length ||
    operation.sourceIds.length !== operation.replacements.length ||
    !root ||
    root.type !== "FRAME" ||
    root.parentId !== source.parentId ||
    replacementIds.has(source.id) ||
    !operation.temporaryPositionId ||
    !operation.finalPositionId ||
    operation.temporaryPositionId === operation.finalPositionId
  ) throw runtimeError("INVALID_ARGUMENT", { transactionId, nodeId: operation.sourceId });

  operation.sourceIds.forEach((nodeId, index) => {
    const node = read(nodeId);
    const replacement = operation.replacements[index];
    if (
      !node ||
      node.removed === true ||
      !replacement ||
      read(replacement.id) ||
      (index > 0 && (!node.parentId || !sourceIds.has(node.parentId))) ||
      (index > 0 && (!replacement.parentId || !replacementIds.has(replacement.parentId)))
    ) throw runtimeError("INVALID_ARGUMENT", { transactionId, nodeId });
  });
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

function validateComponentSetOperation(
  read: (nodeId: string) => RuntimeProjectionNode | undefined,
  operation: Extract<PendingProjectionOperation, { type: "componentSet" }>,
  transactionId: string,
): void {
  if (
    operation.node.type !== "COMPONENT_SET" ||
    !operation.childIds.length ||
    new Set(operation.childIds).size !== operation.childIds.length ||
    operation.childPatches.length !== operation.childIds.length ||
    !operation.node.componentSetMetadata ||
    typeof operation.node.componentSetMetadata !== "object" ||
    !("componentPropertyDefinitions" in operation.node.componentSetMetadata) ||
    !operation.node.componentSetMetadata.componentPropertyDefinitions ||
    typeof operation.node.componentSetMetadata.componentPropertyDefinitions !== "object"
  ) throw runtimeError("INVALID_ARGUMENT", { transactionId, nodeId: operation.node.id });
  operation.childIds.forEach((nodeId, siblingIndex) => {
    const node = read(nodeId);
    const patch = operation.childPatches[siblingIndex];
    if (
      !node ||
      node.removed === true ||
      node.type !== "COMPONENT" ||
      projectionPageId(read, node) !== projectionPageId(read, operation.node) ||
      !patch ||
      patch.parentId !== operation.node.id
    ) {
      throw runtimeError("INVALID_ARGUMENT", { transactionId, nodeId });
    }
  });
  if (new Set(operation.siblingIndexes.map(({ nodeId }) => nodeId)).size !== operation.siblingIndexes.length) {
    throw runtimeError("INVALID_ARGUMENT", { transactionId, nodeId: operation.node.id });
  }
  const occupiedSiblingSlots = new Set<string>();
  for (const { nodeId, siblingIndex } of operation.siblingIndexes) {
    const node = read(nodeId);
    const slot = `${node?.parentId ?? "<root>"}:${siblingIndex}`;
    if (
      !node ||
      node.removed === true ||
      projectionPageId(read, node) !== projectionPageId(read, operation.node) ||
      operation.childIds.includes(nodeId) ||
      !Number.isSafeInteger(siblingIndex) ||
      siblingIndex < 0 ||
      occupiedSiblingSlots.has(slot)
    ) {
      throw runtimeError("INVALID_ARGUMENT", { transactionId, nodeId });
    }
    occupiedSiblingSlots.add(slot);
  }
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
    !operation.replacement.vectorPath ||
    typeof operation.replacement.vectorPath !== "object" ||
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

function validateFlattenNodeOperation(
  read: (nodeId: string) => RuntimeProjectionNode | undefined,
  operation: Extract<PendingProjectionOperation, { type: "flattenNode" }>,
  transactionId: string,
): void {
  const source = read(operation.sourceId);
  if (!source) throw runtimeError("NODE_NOT_FOUND", { transactionId, nodeId: operation.sourceId });
  if (source.removed === true) throw runtimeError("NODE_REMOVED", { transactionId, nodeId: operation.sourceId });
  if (
    !["VECTOR", "RECTANGLE", "ELLIPSE", "POLYGON", "STAR", "LINE"].includes(source.type) ||
    !operation.replacement.id ||
    operation.replacement.type !== "VECTOR" ||
    !operation.replacement.vectorPath ||
    typeof operation.replacement.vectorPath !== "object" ||
    read(operation.replacement.id) ||
    projectionPageId(read, source) !== projectionPageId(read, operation.replacement) ||
    new Set(operation.siblingIndexes.map(({ nodeId }) => nodeId)).size !== operation.siblingIndexes.length
  ) throw runtimeError("INVALID_ARGUMENT", { transactionId, nodeId: operation.sourceId });
  const occupiedSiblingSlots = new Set<string>();
  for (const { nodeId, siblingIndex } of operation.siblingIndexes) {
    const node = read(nodeId);
    const slot = `${node?.parentId ?? "<root>"}:${siblingIndex}`;
    if (!node || node.removed === true || nodeId === operation.sourceId || !Number.isSafeInteger(siblingIndex) || siblingIndex < 0 || occupiedSiblingSlots.has(slot)) {
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
  const paintStyles = projection.paintStyles?.map((style) => deepFreeze(structuredClone(style)));
  const variableCollections = projection.variableCollections?.map((collection) => deepFreeze(structuredClone(collection)));
  const variables = projection.variables?.map((variable) => deepFreeze(structuredClone(variable)));
  return Object.freeze({
    revision: projection.revision,
    nodes: Object.freeze(nodes),
    ...(textStyles ? { textStyles: Object.freeze(textStyles) } : {}),
    ...(paintStyles ? { paintStyles: Object.freeze(paintStyles) } : {}),
    ...(variableCollections ? { variableCollections: Object.freeze(variableCollections) } : {}),
    ...(variables ? { variables: Object.freeze(variables) } : {}),
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
