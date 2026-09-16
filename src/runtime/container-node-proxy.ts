import { runtimeError } from "./runtime-errors";
import { RuntimeNodeProxy, type M1NodeType, type RuntimeNodeHost } from "./node-proxy";
import type { RuntimeNodeHandle } from "./node-registry";

export interface RuntimeContainerHost extends RuntimeNodeHost {
  reparent(nodeId: string, parentId: string, index: number, gridPosition?: Readonly<{ row: number; column: number }>): void;
  findDescendants(parentId: string): readonly RuntimeNodeProxy[];
  assertCanQueryDescendants(parentId: string): void;
  loadPageAsync(pageId: string): Promise<void>;
  selectionForPage(pageId: string): readonly RuntimeNodeProxy[];
  setSelectionAsync(pageId: string, nodes: readonly RuntimeNodeProxy[]): Promise<void>;
}

export class RuntimeContainerNodeProxy extends RuntimeNodeProxy {
  declare protected readonly host: RuntimeContainerHost;

  constructor(handle: RuntimeNodeHandle, host: RuntimeContainerHost, nodeType: M1NodeType) {
    super(handle, host, nodeType);
  }

  get children(): readonly RuntimeNodeProxy[] {
    this.assertLive();
    return this.host.childrenOf(this.handle.nodeId);
  }

  appendChild(node: RuntimeNodeProxy): RuntimeNodeProxy {
    return this.insertChild(this.children.length, node);
  }

  appendChildAt(node: RuntimeNodeProxy, rowIndex: number, columnIndex: number): RuntimeNodeProxy {
    this.assertLive();
    this.assertMutable();
    if (!Number.isInteger(rowIndex) || rowIndex < 0 || !Number.isInteger(columnIndex) || columnIndex < 0
      || node.handle.sessionId !== this.handle.sessionId || node.removed || node.id === this.id
      || this.host.findDescendants(node.id).some((child) => child.id === this.id)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: node.handle.nodeId });
    }
    this.host.reparent(node.id, this.id, this.children.length, { row: rowIndex, column: columnIndex });
    return node;
  }

  insertChild(index: number, node: RuntimeNodeProxy): RuntimeNodeProxy {
    this.assertLive();
    this.assertMutable();
    if (!Number.isInteger(index) || index < 0 || index > this.children.length) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    if (node.handle.sessionId !== this.handle.sessionId || node.removed || node.id === this.id) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: node.handle.nodeId });
    }
    if (this.host.findDescendants(node.id).some((child) => child.id === this.id)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: node.id });
    }
    this.host.reparent(node.id, this.id, index);
    return node;
  }

  findChildren(predicate: (node: RuntimeNodeProxy) => boolean): readonly RuntimeNodeProxy[] {
    return this.children.filter(predicate);
  }

  findOne(predicate: (node: RuntimeNodeProxy) => boolean): RuntimeNodeProxy | null {
    return this.findAll(predicate)[0] ?? null;
  }

  findAll(predicate: (node: RuntimeNodeProxy) => boolean): readonly RuntimeNodeProxy[] {
    this.host.assertCanQueryDescendants(this.id);
    return this.host.findDescendants(this.id).filter(predicate);
  }

  /** Figma-shaped Page API. In full-document access this resolves immediately;
   * dynamic-page sessions expose a page only after this explicit boundary. */
  loadAsync(): Promise<void> {
    if (this.type !== "PAGE") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    return this.host.loadPageAsync(this.id);
  }

  get selection(): readonly RuntimeNodeProxy[] {
    if (this.type !== "PAGE") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    return this.host.selectionForPage(this.id);
  }

  setSelectionAsync(nodes: readonly RuntimeNodeProxy[]): Promise<void> {
    if (this.type !== "PAGE") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    return this.host.setSelectionAsync(this.id, nodes);
  }
}
