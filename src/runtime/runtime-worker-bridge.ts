import { createId, type CanvasNode, type DocumentAsset, type DocumentAutoLayout, type DocumentTextPathMetadata, type DocumentTransformModifier, type DocumentVectorPath, type EditorCommand, type EditorSnapshot, type EditorTransaction, type MainToWorker, type WorkerToMain } from "../lib/editor-protocol";
import { figmaPluginNodeType } from "../lib/figma-plugin-node-projection";
import { runtimeError } from "./runtime-errors";
import type { PendingProjectionTransaction, RuntimeProjection, RuntimeProjectionNode } from "./runtime-projection-store";
import type { RuntimeTransactionResult, RuntimeTransactionTransport } from "./runtime-transaction-client";

export function runtimeProjectionFromEditorSnapshot(snapshot: EditorSnapshot): RuntimeProjection {
  const documentId = runtimeDocumentNodeId(snapshot.documentId);
  const nextSiblingIndexByParent = new Map<string, number>();
  const sceneNodes = snapshot.nodes.flatMap((node) => {
    const type = node.kind === "image" ? "IMAGE" : figmaPluginNodeType(node.kind);
    if (!type) return [];
    const parentId = node.parentId ?? node.pageId ?? snapshot.activePageId;
    const siblingIndex = nextSiblingIndexByParent.get(parentId) ?? 0;
    nextSiblingIndexByParent.set(parentId, siblingIndex + 1);
    return [{
      ...node,
      type,
      parentId,
      siblingIndex,
      characters: node.text,
    }];
  });
  return {
    revision: snapshot.revision,
    textStyles: structuredClone(snapshot.textStyles ?? []),
    paintStyles: structuredClone(snapshot.paintStyles ?? []),
    effectStyles: structuredClone(snapshot.effectStyles ?? []),
    gridStyles: structuredClone(snapshot.gridStyles ?? []),
    variableCollections: structuredClone(snapshot.variableCollections ?? []),
    variables: structuredClone(snapshot.variables ?? []),
    nodes: [
      {
        id: documentId,
        type: "DOCUMENT",
        name: "Document",
        assets: snapshot.assets ?? [],
        fontAvailability: snapshot.fontAvailability ?? {},
        selectedIds: snapshot.selectedIds,
      },
      ...snapshot.pages.map((page, siblingIndex) => ({
        id: page.id,
        type: "PAGE",
        parentId: documentId,
        name: page.name,
        siblingIndex,
      })),
      ...sceneNodes,
    ],
  };
}

export function runtimeDocumentNodeId(documentId: string): string {
  return `runtime-document:${documentId}`;
}

/** Bridges the existing worker's separate Ack and Snapshot messages into the
 * Runtime's single fence-aware transport result. Integrators should call
 * observe() for every WorkerToMain message before updating presentation state. */
export class RuntimeWorkerBridge implements RuntimeTransactionTransport {
  private readonly waiting = new Map<string, {
    resolve: (value: RuntimeTransactionResult) => void;
    reject: (reason?: unknown) => void;
    acceptedRevision?: number;
  }>();
  private readonly snapshots = new Map<number, RuntimeProjection>();
  private readonly pageIds = new Set<string>();
  private readonly fontLoadWaiters = new Map<string, { resolve: () => void; reject: (reason?: unknown) => void; timeoutId: ReturnType<typeof setTimeout> }>();
  private readonly assetRegistrationWaiters = new Map<string, { assetId: string; resolve: () => void; reject: (reason?: unknown) => void; timeoutId: ReturnType<typeof setTimeout> }>();
  private readonly pageWaiters = new Map<string, { resolve: () => void; reject: (reason?: unknown) => void; timeoutId: ReturnType<typeof setTimeout> }>();
  private readonly selectionWaiters: Array<{ ids: readonly string[]; resolve: () => void; reject: (reason?: unknown) => void; timeoutId: ReturnType<typeof setTimeout> }> = [];
  private readonly booleanPathWaiters = new Map<string, { revision: number; resolve: (paths: ReadonlyMap<string, DocumentVectorPath>) => void; reject: (reason?: unknown) => void; timeoutId: ReturnType<typeof setTimeout> }>();
  private readonly viewStateListeners = new Set<(state: RuntimeWorkerViewState) => void>();
  private latestSnapshot?: EditorSnapshot;

  constructor(private readonly post: (message: MainToWorker) => void) {}

  get hasPendingTransactions(): boolean {
    return this.waiting.size > 0;
  }

  submit(transaction: PendingProjectionTransaction): Promise<RuntimeTransactionResult> {
    if (this.waiting.has(transaction.transactionId)) throw runtimeError("INVALID_ARGUMENT", { transactionId: transaction.transactionId });
    const message: EditorTransaction = {
      id: transaction.transactionId,
      baseRevision: transaction.baseRevision,
      commands: transactionToEditorCommands(transaction.operations, this.pageIds),
    };
    return new Promise<RuntimeTransactionResult>((resolve, reject) => {
      this.waiting.set(transaction.transactionId, { resolve, reject });
      try {
        this.post({ type: "transaction", transaction: message });
      } catch (error) {
        this.waiting.delete(transaction.transactionId);
        reject(error);
      }
    });
  }

  observe(message: WorkerToMain): void {
    if (message.type === "runtime-export-boolean-paths-result") {
      const waiter = this.booleanPathWaiters.get(message.requestId);
      if (!waiter) return;
      clearTimeout(waiter.timeoutId);
      this.booleanPathWaiters.delete(message.requestId);
      if (message.errorCode || message.revision !== waiter.revision) {
        waiter.reject(runtimeError(message.errorCode === "RESOURCE_LIMIT" ? "RESOURCE_LIMIT" : message.errorCode === "INVALID_REQUEST" ? "INVALID_ARGUMENT" : "REVISION_CONFLICT", { revision: waiter.revision }));
        return;
      }
      waiter.resolve(new Map(Object.entries(message.paths ?? {})));
      return;
    }
    if (message.type === "snapshot") {
      this.latestSnapshot = message.snapshot;
      this.pageIds.clear();
      message.snapshot.pages.forEach((page) => this.pageIds.add(page.id));
      const projection = runtimeProjectionFromEditorSnapshot(message.snapshot);
      this.snapshots.set(projection.revision, projection);
      while (this.snapshots.size > 32) this.snapshots.delete(this.snapshots.keys().next().value!);
      for (const [transactionId, waiter] of this.waiting) {
        if (waiter.acceptedRevision === projection.revision) this.resolveAccepted(transactionId, waiter, projection);
      }
      this.settleFontLoads(message.snapshot);
      this.settleAssetRegistrations(message.snapshot);
      this.settlePageLoad(message.snapshot);
      return;
    }
    if (message.type === "view-state") {
      const state: RuntimeWorkerViewState = { activePageId: message.activePageId, selectedIds: message.selectedIds, viewport: message.viewport };
      this.viewStateListeners.forEach((listener) => listener(state));
      this.settleSelection(message.selectedIds);
      return;
    }
    if (message.type === "error") {
      if (message.transactionId) {
        const waiter = this.assetRegistrationWaiters.get(message.transactionId);
        if (waiter) {
          clearTimeout(waiter.timeoutId);
          this.assetRegistrationWaiters.delete(message.transactionId);
          waiter.reject(runtimeError(message.code === "RESOURCE_LIMIT" ? "RESOURCE_LIMIT" : "RESOURCE_UNAVAILABLE", { transactionId: message.transactionId }));
        }
      }
      return;
    }
    if (message.type !== "ack") return;
    const waiter = this.waiting.get(message.transactionId);
    if (!waiter) return;
    if (message.errorCode) {
      this.waiting.delete(message.transactionId);
      waiter.resolve({ type: "rejected", errorCode: message.errorCode === "REVISION_CONFLICT" ? "REVISION_CONFLICT" : message.errorCode === "RESOURCE_LIMIT" ? "RESOURCE_LIMIT" : "TRANSACTION_ABORTED" });
      return;
    }
    if (message.acceptedRevision === undefined) {
      this.waiting.delete(message.transactionId);
      waiter.reject(runtimeError("INTERNAL_ERROR", { transactionId: message.transactionId }));
      return;
    }
    waiter.acceptedRevision = message.acceptedRevision;
    const projection = this.snapshots.get(message.acceptedRevision);
    if (projection) this.resolveAccepted(message.transactionId, waiter, projection);
  }

  close(reason = runtimeError("RUNTIME_CLOSED")): void {
    for (const waiter of this.waiting.values()) waiter.reject(reason);
    this.waiting.clear();
    this.snapshots.clear();
    for (const waiter of this.fontLoadWaiters.values()) {
      clearTimeout(waiter.timeoutId);
      waiter.reject(reason);
    }
    this.fontLoadWaiters.clear();
    for (const waiter of this.assetRegistrationWaiters.values()) {
      clearTimeout(waiter.timeoutId);
      waiter.reject(reason);
    }
    this.assetRegistrationWaiters.clear();
    for (const waiter of this.pageWaiters.values()) {
      clearTimeout(waiter.timeoutId);
      waiter.reject(reason);
    }
    this.pageWaiters.clear();
    this.selectionWaiters.splice(0).forEach((waiter) => {
      clearTimeout(waiter.timeoutId);
      waiter.reject(reason);
    });
    for (const waiter of this.booleanPathWaiters.values()) {
      clearTimeout(waiter.timeoutId);
      waiter.reject(reason);
    }
    this.booleanPathWaiters.clear();
  }

  resolveBooleanPathsAsync(revision: number, nodeIds: readonly string[], timeoutMs = 10_000): Promise<ReadonlyMap<string, DocumentVectorPath>> {
    if (!Number.isSafeInteger(revision) || revision < 0 || nodeIds.length < 1 || nodeIds.length > 256 || new Set(nodeIds).size !== nodeIds.length || nodeIds.some((id) => !id)) {
      return Promise.reject(runtimeError("INVALID_ARGUMENT", { revision }));
    }
    const requestId = createId();
    return new Promise((resolve, reject) => {
      const timeoutId = globalThis.setTimeout(() => {
        if (!this.booleanPathWaiters.has(requestId)) return;
        this.booleanPathWaiters.delete(requestId);
        reject(runtimeError("TIMEOUT", { revision }));
      }, timeoutMs);
      this.booleanPathWaiters.set(requestId, { revision, resolve, reject, timeoutId });
      try {
        this.post({ type: "runtime-export-boolean-paths", requestId, revision, nodeIds: [...nodeIds] });
      } catch (error) {
        clearTimeout(timeoutId);
        this.booleanPathWaiters.delete(requestId);
        reject(error);
      }
    });
  }

  subscribeViewState(listener: (state: RuntimeWorkerViewState) => void): () => void {
    this.viewStateListeners.add(listener);
    return () => this.viewStateListeners.delete(listener);
  }

  setCurrentPageAsync(pageId: string, timeoutMs = 10_000): Promise<void> {
    if (!pageId) return Promise.reject(runtimeError("INVALID_ARGUMENT"));
    if (this.latestSnapshot?.activePageId === pageId) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timeoutId = globalThis.setTimeout(() => {
        if (!this.pageWaiters.has(pageId)) return;
        this.pageWaiters.delete(pageId);
        reject(runtimeError("TIMEOUT"));
      }, timeoutMs);
      this.pageWaiters.set(pageId, { resolve, reject, timeoutId });
      try { this.post({ type: "command", command: { type: "select-page", id: pageId } }); }
      catch (error) { clearTimeout(timeoutId); this.pageWaiters.delete(pageId); reject(error); }
    });
  }

  setSelectionAsync(ids: readonly string[], timeoutMs = 10_000): Promise<void> {
    if (new Set(ids).size !== ids.length || ids.some((id) => !id)) return Promise.reject(runtimeError("INVALID_ARGUMENT"));
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        ids: [...ids], resolve, reject,
        timeoutId: globalThis.setTimeout(() => {
          const index = this.selectionWaiters.indexOf(waiter);
          if (index >= 0) this.selectionWaiters.splice(index, 1);
          reject(runtimeError("TIMEOUT"));
        }, timeoutMs),
      };
      this.selectionWaiters.push(waiter);
      try { this.post({ type: "command", command: { type: "select", ids: [...ids] } }); }
      catch (error) {
        clearTimeout(waiter.timeoutId);
        this.selectionWaiters.splice(this.selectionWaiters.indexOf(waiter), 1);
        reject(error);
      }
    });
  }

  /** Loads an admitted font in the real Worker and resolves only after its
   * subsequent Snapshot reports the FontFace as ready. */
  loadFontAsync(assetId: string, timeoutMs = 10_000): Promise<void> {
    const current = this.latestSnapshot;
    const asset = current?.assets?.find((candidate) => candidate.assetId === assetId);
    if (!current || !asset || !asset.mediaType.startsWith("font/")) return Promise.reject(runtimeError("RESOURCE_UNAVAILABLE"));
    const status = current.fontAvailability?.[assetId] ?? "idle";
    if (status === "ready") return Promise.resolve();
    if (status === "unavailable") return Promise.reject(runtimeError("RESOURCE_UNAVAILABLE"));
    const existing = this.fontLoadWaiters.get(assetId);
    if (existing) return new Promise<void>((resolve, reject) => {
      const previousResolve = existing.resolve;
      const previousReject = existing.reject;
      existing.resolve = () => { previousResolve(); resolve(); };
      existing.reject = (reason) => { previousReject(reason); reject(reason); };
    });
    return new Promise<void>((resolve, reject) => {
      const timeoutId = globalThis.setTimeout(() => {
        if (this.fontLoadWaiters.get(assetId)?.timeoutId !== timeoutId) return;
        this.fontLoadWaiters.delete(assetId);
        reject(runtimeError("TIMEOUT"));
      }, timeoutMs);
      this.fontLoadWaiters.set(assetId, { resolve, reject, timeoutId });
      try {
        this.post({ type: "load-font", assetId });
      } catch (error) {
        clearTimeout(timeoutId);
        this.fontLoadWaiters.delete(assetId);
        reject(error);
      }
    });
  }

  /** Registers only validated metadata in Core, then seeds the corresponding
   * transient bytes for Worker-side decode. The promise is fenced by the
   * Snapshot that first exposes the Resource Index record. */
  registerAssetAsync(asset: DocumentAsset, bytes: Uint8Array, timeoutMs = 10_000): Promise<void> {
    if (!asset.assetId || !asset.contentHash || !asset.mediaType || asset.byteLength !== bytes.byteLength) {
      return Promise.reject(runtimeError("INVALID_ARGUMENT"));
    }
    if (this.latestSnapshot?.assets?.some((candidate) => candidate.assetId === asset.assetId)) {
      this.post({ type: "asset-bytes", assetId: asset.assetId, mediaType: asset.mediaType, bytes: bytes.slice().buffer });
      return Promise.resolve();
    }
    const transactionId = createId();
    return new Promise<void>((resolve, reject) => {
      const timeoutId = globalThis.setTimeout(() => {
        if (!this.assetRegistrationWaiters.has(transactionId)) return;
        this.assetRegistrationWaiters.delete(transactionId);
        reject(runtimeError("TIMEOUT", { transactionId }));
      }, timeoutMs);
      this.assetRegistrationWaiters.set(transactionId, { assetId: asset.assetId, resolve, reject, timeoutId });
      try {
        this.post({ type: "register-asset", transactionId, asset });
        this.post({ type: "asset-bytes", assetId: asset.assetId, mediaType: asset.mediaType, bytes: bytes.slice().buffer });
      } catch (error) {
        clearTimeout(timeoutId);
        this.assetRegistrationWaiters.delete(transactionId);
        reject(error);
      }
    });
  }

  private resolveAccepted(
    transactionId: string,
    waiter: { resolve: (value: RuntimeTransactionResult) => void; acceptedRevision?: number },
    projection: RuntimeProjection,
  ): void {
    this.waiting.delete(transactionId);
    waiter.resolve({ type: "accepted", acceptedRevision: projection.revision, projection });
  }

  private settleFontLoads(snapshot: EditorSnapshot): void {
    for (const [assetId, waiter] of this.fontLoadWaiters) {
      const status = snapshot.fontAvailability?.[assetId] ?? "idle";
      if (status !== "ready" && status !== "unavailable") continue;
      clearTimeout(waiter.timeoutId);
      this.fontLoadWaiters.delete(assetId);
      if (status === "ready") waiter.resolve();
      else waiter.reject(runtimeError("RESOURCE_UNAVAILABLE"));
    }
  }

  private settleAssetRegistrations(snapshot: EditorSnapshot): void {
    for (const [transactionId, waiter] of this.assetRegistrationWaiters) {
      if (!snapshot.assets?.some((asset) => asset.assetId === waiter.assetId)) continue;
      clearTimeout(waiter.timeoutId);
      this.assetRegistrationWaiters.delete(transactionId);
      waiter.resolve();
    }
  }

  private settlePageLoad(snapshot: EditorSnapshot): void {
    const waiter = this.pageWaiters.get(snapshot.activePageId);
    if (!waiter) return;
    clearTimeout(waiter.timeoutId);
    this.pageWaiters.delete(snapshot.activePageId);
    waiter.resolve();
  }

  private settleSelection(ids: readonly string[]): void {
    for (let index = this.selectionWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.selectionWaiters[index]!;
      if (waiter.ids.length !== ids.length || waiter.ids.some((id, position) => ids[position] !== id)) continue;
      clearTimeout(waiter.timeoutId);
      this.selectionWaiters.splice(index, 1);
      waiter.resolve();
    }
  }
}

export type RuntimeWorkerViewState = Readonly<{ activePageId: string; selectedIds: readonly string[]; viewport: Readonly<{ x: number; y: number; zoom: number }> }>;

function transactionToEditorCommands(
  operations: PendingProjectionTransaction["operations"],
  pageIds: ReadonlySet<string>,
): EditorTransaction["commands"] {
  const created = new Map<string, RuntimeProjectionNode>();
  const createdBooleans = new Map<string, Extract<PendingProjectionTransaction["operations"][number], { type: "boolean" }>>();
  const createdTransformGroups = new Map<string, Extract<PendingProjectionTransaction["operations"][number], { type: "transformGroup" }>>();
  const createdOrder: string[] = [];
  const remaining: PendingProjectionTransaction["operations"][number][] = [];
  const commands: EditorTransaction["commands"] = [];
  const flush = (): void => {
    commands.push(...createdOrder.flatMap((nodeId) => {
      const node = created.get(nodeId);
      return node ? toEditorCommands({ type: "create", node }, pageIds) : [];
    }));
    commands.push(...remaining.flatMap((operation) => toEditorCommands(operation, pageIds)));
    created.clear();
    createdBooleans.clear();
    createdTransformGroups.clear();
    createdOrder.length = 0;
    remaining.length = 0;
  };

  for (const operation of operations) {
    if (operation.type === "componentFromNode" || operation.type === "replaceContainer" || operation.type === "detachInstance" || operation.type === "componentSet") {
      flush();
      commands.push(...toEditorCommands(operation, pageIds));
      continue;
    }
    if (operation.type === "registerTextStyle" || operation.type === "registerPaintStyle" || operation.type === "registerEffectStyle" || operation.type === "registerGridStyle" || operation.type === "setTextStyle" || operation.type === "deleteTextStyle" || operation.type === "setPaintStyle" || operation.type === "deletePaintStyle" || operation.type === "setEffectStyle" || operation.type === "deleteEffectStyle" || operation.type === "setGridStyle" || operation.type === "deleteGridStyle" || operation.type === "registerVariableCollection" || operation.type === "registerVariable" || operation.type === "setVariable" || operation.type === "deleteVariable" || operation.type === "setVariableCollection" || operation.type === "deleteVariableCollection") {
      remaining.push(structuredClone(operation));
      continue;
    }
    if (operation.type === "boolean") {
      if (created.has(operation.node.id)) throw runtimeError("INVALID_ARGUMENT", { nodeId: operation.node.id });
      const cloned = structuredClone(operation);
      created.set(operation.node.id, cloned.node);
      createdBooleans.set(operation.node.id, cloned);
      remaining.push(cloned);
      continue;
    }
    if (operation.type === "transformGroup") {
      if (created.has(operation.node.id)) throw runtimeError("INVALID_ARGUMENT", { nodeId: operation.node.id });
      const cloned = structuredClone(operation);
      created.set(operation.node.id, cloned.node);
      createdTransformGroups.set(operation.node.id, cloned);
      remaining.push(cloned);
      continue;
    }
    if (operation.type === "create") {
      if (created.has(operation.node.id)) throw runtimeError("INVALID_ARGUMENT", { nodeId: operation.node.id });
      created.set(operation.node.id, structuredClone(operation.node));
      createdOrder.push(operation.node.id);
      continue;
    }
    if (operation.type === "update") {
      const node = created.get(operation.nodeId);
      if (node) {
        Object.assign(node, structuredClone(operation.patch));
        const structural = createdBooleans.get(operation.nodeId);
        if (structural) Object.assign(structural.wrapperPatch, structuredClone(operation.patch));
        const transformGroup = createdTransformGroups.get(operation.nodeId);
        if (transformGroup) Object.assign(transformGroup.wrapperPatch, structuredClone(operation.patch));
        continue;
      }
    }
    if (operation.type === "remove" && created.delete(operation.nodeId)) continue;
    remaining.push(operation);
  }

  flush();
  return commands;
}

function toEditorCommands(
  operation: PendingProjectionTransaction["operations"][number],
  pageIds: ReadonlySet<string>,
): EditorTransaction["commands"] {
  if (operation.type === "registerTextStyle") {
    return [{ type: "register-text-style", style: structuredClone(operation.style) }];
  }
  if (operation.type === "registerPaintStyle") {
    return [{ type: "register-paint-style", style: structuredClone(operation.style) }];
  }
  if (operation.type === "setTextStyle") {
    return [{ type: "set-text-style", style: structuredClone(operation.style) }];
  }
  if (operation.type === "deleteTextStyle") {
    return [{ type: "delete-text-style", id: operation.id }];
  }
  if (operation.type === "setPaintStyle") {
    return [{ type: "set-paint-style", style: structuredClone(operation.style) }];
  }
  if (operation.type === "deletePaintStyle") {
    return [{ type: "delete-paint-style", id: operation.id }];
  }
  if (operation.type === "registerEffectStyle") {
    return [{ type: "register-effect-style", style: structuredClone(operation.style) }];
  }
  if (operation.type === "setEffectStyle") {
    return [{ type: "set-effect-style", style: structuredClone(operation.style) }];
  }
  if (operation.type === "deleteEffectStyle") {
    return [{ type: "delete-effect-style", id: operation.id }];
  }
  if (operation.type === "registerGridStyle") {
    return [{ type: "register-grid-style", style: structuredClone(operation.style) }];
  }
  if (operation.type === "setGridStyle") {
    return [{ type: "set-grid-style", style: structuredClone(operation.style) }];
  }
  if (operation.type === "deleteGridStyle") {
    return [{ type: "delete-grid-style", id: operation.id }];
  }
  if (operation.type === "registerVariableCollection") {
    return [{ type: "register-variable-collection", collection: structuredClone(operation.collection) }];
  }
  if (operation.type === "registerVariable") {
    return [{ type: "register-variable", variable: structuredClone(operation.variable) }];
  }
  if (operation.type === "setVariable") {
    return [{ type: "set-variable", variable: structuredClone(operation.variable) }];
  }
  if (operation.type === "deleteVariable") {
    return [{ type: "delete-variable", id: operation.id }];
  }
  if (operation.type === "setVariableCollection") {
    return [{ type: "set-variable-collection", collection: structuredClone(operation.collection), variables: structuredClone([...operation.variables]) }];
  }
  if (operation.type === "deleteVariableCollection") {
    return [{ type: "delete-variable-collection", id: operation.id }];
  }
  if (operation.type === "componentFromNode") {
    const temporary = { ...structuredClone(operation.replacement), positionId: operation.temporaryPositionId };
    return [
      ...toEditorCommands({ type: "create", node: temporary }, pageIds),
      ...(operation.childIds.length ? [{ type: "reparent" as const, ids: [...operation.childIds], parentId: operation.replacement.id }] : []),
      { type: "delete", ids: [operation.sourceId] },
      { type: "reposition", positionIds: [{ id: operation.replacement.id, positionId: operation.finalPositionId }] },
    ];
  }
  if (operation.type === "replaceContainer") {
    const temporary = { ...structuredClone(operation.replacement), positionId: operation.temporaryPositionId };
    return [
      ...toEditorCommands({ type: "create", node: temporary }, pageIds),
      ...(operation.childIds.length ? [{ type: "reparent" as const, ids: [...operation.childIds], parentId: operation.replacement.id }] : []),
      { type: "delete", ids: [operation.sourceId] },
      { type: "reposition", positionIds: [{ id: operation.replacement.id, positionId: operation.finalPositionId }] },
    ];
  }
  if (operation.type === "detachInstance") {
    const [root, ...descendants] = operation.replacements;
    if (!root) throw runtimeError("INVALID_ARGUMENT", { nodeId: operation.sourceId });
    const temporaryRoot = { ...structuredClone(root), positionId: operation.temporaryPositionId };
    return [
      ...toEditorCommands({ type: "create", node: temporaryRoot }, pageIds),
      ...descendants.flatMap((node) => toEditorCommands({ type: "create", node }, pageIds)),
      { type: "delete", ids: [operation.sourceId] },
      { type: "reposition", positionIds: [{ id: root.id, positionId: operation.finalPositionId }] },
    ];
  }
  if (operation.type === "componentSet") {
    const runtimeParentId = typeof operation.node.parentId === "string" ? operation.node.parentId : undefined;
    const index = typeof operation.node.siblingIndex === "number" && Number.isSafeInteger(operation.node.siblingIndex)
      ? operation.node.siblingIndex
      : undefined;
    const metadata = operation.node.componentSetMetadata;
    if (!metadata || typeof metadata !== "object") throw runtimeError("INVALID_ARGUMENT", { nodeId: operation.node.id });
    return [{
      type: "componentSet",
      ids: [...operation.childIds],
      id: operation.node.id,
      metadata: structuredClone(metadata) as Extract<EditorCommand, { type: "componentSet" }>["metadata"],
      patch: {
        ...(typeof operation.node.name === "string" ? { name: operation.node.name } : {}),
        ...(typeof operation.node.opacity === "number" ? { opacity: operation.node.opacity } : {}),
        ...(typeof operation.node.visible === "boolean" ? { visible: operation.node.visible } : {}),
      },
      ...(runtimeParentId && pageIds.has(runtimeParentId) ? { pageId: runtimeParentId } : runtimeParentId ? { parentId: runtimeParentId } : {}),
      ...(index === undefined ? {} : { index }),
    }];
  }
  if (operation.type === "boolean") {
    const runtimeParentId = typeof operation.node.parentId === "string" ? operation.node.parentId : undefined;
    const index = typeof operation.node.siblingIndex === "number" && Number.isSafeInteger(operation.node.siblingIndex)
      ? operation.node.siblingIndex
      : undefined;
    return [{
      type: "boolean",
      ids: [...operation.operandIds],
      operation: canonicalBooleanOperation(operation.wrapperPatch.booleanOperation) ?? operation.operation,
      id: operation.node.id,
      ...(runtimeParentId && pageIds.has(runtimeParentId) ? { pageId: runtimeParentId } : runtimeParentId ? { parentId: runtimeParentId } : {}),
      ...(index === undefined ? {} : { index }),
      ...(Object.keys(operation.wrapperPatch).length ? { patch: structuredClone(operation.wrapperPatch) } : {}),
    }];
  }
  if (operation.type === "transformGroup") {
    const runtimeParentId = typeof operation.node.parentId === "string" ? operation.node.parentId : undefined;
    const index = typeof operation.node.siblingIndex === "number" && Number.isSafeInteger(operation.node.siblingIndex)
      ? operation.node.siblingIndex
      : undefined;
    const wrapperPatch = structuredClone(operation.wrapperPatch) as Record<string, unknown>;
    const patchedModifiers = wrapperPatch.transformModifiers;
    delete wrapperPatch.transformModifiers;
    const modifiers = Array.isArray(patchedModifiers)
      ? patchedModifiers as DocumentTransformModifier[]
      : operation.modifiers.map((modifier) => structuredClone(modifier));
    return [{
      type: "transformGroup",
      ids: [...operation.childIds],
      id: operation.node.id,
      modifiers,
      ...(runtimeParentId && pageIds.has(runtimeParentId) ? { pageId: runtimeParentId } : runtimeParentId ? { parentId: runtimeParentId } : {}),
      ...(index === undefined ? {} : { index }),
      ...(Object.keys(wrapperPatch).length ? { patch: wrapperPatch } : {}),
    }];
  }
  if (operation.type === "flattenBoolean") {
    const runtimeParentId = typeof operation.replacement.parentId === "string" ? operation.replacement.parentId : undefined;
    const index = typeof operation.replacement.siblingIndex === "number" && Number.isSafeInteger(operation.replacement.siblingIndex)
      ? operation.replacement.siblingIndex
      : undefined;
    return [{
      type: "flattenBoolean",
      id: operation.booleanId,
      replacementId: operation.replacement.id,
      ...(runtimeParentId && pageIds.has(runtimeParentId) ? { pageId: runtimeParentId } : runtimeParentId ? { parentId: runtimeParentId } : {}),
      ...(index === undefined ? {} : { index }),
    }];
  }
  if (operation.type === "flattenNode") {
    const runtimeParentId = typeof operation.replacement.parentId === "string" ? operation.replacement.parentId : undefined;
    const index = typeof operation.replacement.siblingIndex === "number" && Number.isSafeInteger(operation.replacement.siblingIndex)
      ? operation.replacement.siblingIndex
      : undefined;
    const vectorPath = operation.replacement.vectorPath;
    if (!vectorPath || typeof vectorPath !== "object") throw runtimeError("INVALID_ARGUMENT", { nodeId: operation.sourceId });
    return [{
      type: "flattenNode",
      id: operation.sourceId,
      replacementId: operation.replacement.id,
      vectorPath: structuredClone(vectorPath) as DocumentVectorPath,
      ...(runtimeParentId && pageIds.has(runtimeParentId) ? { pageId: runtimeParentId } : runtimeParentId ? { parentId: runtimeParentId } : {}),
      ...(index === undefined ? {} : { index }),
    }];
  }
  if (operation.type === "flattenNodes") {
    const runtimeParentId = typeof operation.replacement.parentId === "string" ? operation.replacement.parentId : undefined;
    const index = typeof operation.replacement.siblingIndex === "number" && Number.isSafeInteger(operation.replacement.siblingIndex)
      ? operation.replacement.siblingIndex
      : undefined;
    const vectorPath = operation.replacement.vectorPath;
    if (!vectorPath || typeof vectorPath !== "object") throw runtimeError("INVALID_ARGUMENT", { nodeId: operation.sourceIds[0] });
    const patch: Partial<CanvasNode> = {};
    const replacement = operation.replacement as Record<string, unknown>;
    for (const property of ["fill", "fillColor", "fillGradient", "fills", "fillStack", "fillStyleId", "extensions"] as const) {
      if (Object.hasOwn(replacement, property)) (patch as Record<string, unknown>)[property] = structuredClone(replacement[property]);
    }
    return [{
      type: "flattenNodes",
      ids: [...operation.sourceIds],
      replacementId: operation.replacement.id,
      vectorPath: structuredClone(vectorPath) as DocumentVectorPath,
      ...(Object.keys(patch).length ? { patch } : {}),
      ...(runtimeParentId && pageIds.has(runtimeParentId) ? { pageId: runtimeParentId } : runtimeParentId ? { parentId: runtimeParentId } : {}),
      ...(index === undefined ? {} : { index }),
    }];
  }
  if (operation.type === "remove") return [{ type: "delete", ids: [operation.nodeId] }];
  if (operation.type === "update") {
    const patch = structuredClone(operation.patch) as Record<string, unknown>;
    if (operation.convertToTextPath) {
      const vectorPath = patch.vectorPath;
      const metadata = patch.textPathMetadata;
      if (patch.type !== "TEXT_PATH" || !vectorPath || typeof vectorPath !== "object" || !metadata || typeof metadata !== "object") {
        throw runtimeError("INVALID_ARGUMENT", { nodeId: operation.nodeId });
      }
      return [{
        type: "convertToTextPath",
        id: operation.nodeId,
        vectorPath: vectorPath as DocumentVectorPath,
        metadata: metadata as DocumentTextPathMetadata,
      }];
    }
    const parentId = patch.parentId;
    const positionId = patch.positionId;
    const characters = patch.characters;
    const isMask = patch.isMask;
    delete patch.parentId;
    delete patch.positionId;
    delete patch.siblingIndex;
    delete patch.characters;
    delete patch.isMask;
    if (typeof characters === "string") patch.text = characters;
    const commands: EditorTransaction["commands"] = [];
    if (typeof parentId === "string") commands.push({ type: "reparent", ids: [operation.nodeId], parentId: pageIds.has(parentId) ? undefined : parentId });
    if (typeof positionId === "string") commands.push({ type: "reposition", positionIds: [{ id: operation.nodeId, positionId }] });
    if (Object.keys(patch).length) commands.push(operation.ignoreConstraints
      ? { type: "resizeWithoutConstraints", id: operation.nodeId, patch: patch as Extract<EditorCommand, { type: "resizeWithoutConstraints" }>["patch"] }
      : { type: "update", id: operation.nodeId, patch });
    if (typeof isMask === "boolean") commands.push({ type: "setMask", id: operation.nodeId, enabled: isMask });
    return commands;
  }
  const kind = editorKind(operation.node.type);
  if (!kind) throw runtimeError("UNSUPPORTED_NODE_TYPE", { nodeId: operation.node.id });
  const node = structuredClone(operation.node) as Record<string, unknown>;
  const characters = node.characters;
  const autoLayout = node.autoLayout;
  const assetId = node.assetId;
  const reactions = node.reactions;
  const prototypeMetadata = node.prototypeMetadata;
  delete node.type;
  delete node.removed;
  delete node.siblingIndex;
  delete node.characters;
  delete node.reactions;
  delete node.prototypeMetadata;
  const runtimeParentId = typeof node.parentId === "string" ? node.parentId : undefined;
  const pageId = typeof node.pageId === "string"
    ? node.pageId
    : runtimeParentId && pageIds.has(runtimeParentId)
      ? runtimeParentId
      : undefined;
  delete node.parentId;
  delete node.pageId;
  return [{
    type: "create",
    node: {
      ...node,
      id: operation.node.id,
      kind,
      x: numberOr(node.x, 0),
      y: numberOr(node.y, 0),
      width: numberOr(node.width, kind === "line" ? 160 : 100),
      height: numberOr(node.height, kind === "line" ? 0 : 100),
      rotation: numberOr(node.rotation, 0),
      name: typeof node.name === "string" ? node.name : kind,
      fill: typeof node.fill === "string" ? node.fill : "transparent",
      stroke: typeof node.stroke === "string" ? node.stroke : "transparent",
      radius: numberOr(node.radius, 0),
      strokeWidth: numberOr(node.strokeWidth, 0),
      opacity: numberOr(node.opacity, 1),
      visible: node.visible !== false,
      // Preserve the Runtime's sibling order for a batch of new nodes. The
      // position key is stable by sibling index; the UUID actor keeps concurrent
      // allocations at the same key distinct without randomising local order.
      positionId: positionIdFor(operation.node),
      ...(runtimeParentId && !pageIds.has(runtimeParentId) ? { parentId: runtimeParentId } : {}),
      ...(pageId ? { pageId } : {}),
      ...(typeof characters === "string" ? { text: characters } : {}),
      ...(autoLayout && typeof autoLayout === "object" ? { autoLayout: autoLayout as DocumentAutoLayout } : {}),
      ...(typeof assetId === "string" ? { assetId } : {}),
      ...(Array.isArray(reactions) ? { reactions } : {}),
      ...(prototypeMetadata && typeof prototypeMetadata === "object" ? { prototypeMetadata } : {}),
    },
  }];
}

function editorKind(type: string): Extract<EditorTransaction["commands"][number], { type: "create" }> ["node"]["kind"] | undefined {
  const kinds = {
    FRAME: "frame",
    GROUP: "group",
    SECTION: "section",
    COMPONENT: "component",
    INSTANCE: "instance",
    SLOT: "slot",
    SLICE: "slice",
    RECTANGLE: "rectangle",
    ELLIPSE: "ellipse",
    POLYGON: "polygon",
    STAR: "star",
    VECTOR: "vector",
    BOOLEAN_OPERATION: "booleanOperation",
    LINE: "line",
    TEXT: "text",
    IMAGE: "image",
    CODE_BLOCK: "codeBlock",
    COMPONENT_SET: "componentSet",
    CONNECTOR: "connector",
    EMBED: "embed",
    HIGHLIGHT: "highlight",
    INTERACTIVE_SLIDE_ELEMENT: "interactiveSlideElement",
    LINK_UNFURL: "linkUnfurl",
    MEDIA: "media",
    SHAPE_WITH_TEXT: "shapeWithText",
    SLIDE: "slide",
    STAMP: "stamp",
    STICKY: "sticky",
    TABLE: "table",
    TABLE_CELL: "tableCell",
    TEXT_PATH: "textPath",
    TRANSFORM_GROUP: "transformGroup",
    WASHI_TAPE: "washiTape",
    WIDGET: "widget",
  } as const;
  return kinds[type as keyof typeof kinds];
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function canonicalBooleanOperation(value: unknown): "union" | "subtract" | "intersect" | "exclude" | undefined {
  return value === "union" || value === "subtract" || value === "intersect" || value === "exclude" ? value : undefined;
}

function positionIdFor(node: RuntimeProjectionNode): string {
  if (typeof node.positionId === "string" && node.positionId.length > 0) return node.positionId;
  const siblingIndex = typeof node.siblingIndex === "number" && Number.isSafeInteger(node.siblingIndex) && node.siblingIndex >= 0
    ? node.siblingIndex
    : 0;
  // Keep ordinary Runtime-created layers in the midpoint range while making
  // the caller-visible sibling index the primary sort key.
  const key = (0x80000000000000000000000000000000n + BigInt(siblingIndex)).toString(16).padStart(32, "0");
  return `${key}:${node.id.replaceAll("-", "")}`;
}
