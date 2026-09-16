import { RuntimeContainerNodeProxy } from "./container-node-proxy";
import { RUNTIME_MIXED, RuntimeNodeProxy } from "./node-proxy";
import { RuntimeSession, type RuntimeAvailableFont, type RuntimeImage, type RuntimeTaskOptions } from "./runtime-session";
import type { DocumentFontReference, DocumentTransformModifier } from "../lib/editor-protocol";
import type { RuntimeFontName } from "./runtime-font-name";
import { RuntimeTask } from "./runtime-task";
import { PrototypePlayer, type PrototypePlayerOptions } from "./prototype-player";
import type { RuntimePngExportSettings, RuntimeSvgExportSettings } from "./runtime-svg-export";
import type { RuntimeTextStyle } from "./runtime-text-style";
import type { RuntimePaintStyle } from "./runtime-paint-style";
import type { RuntimeVariablesAPI } from "./runtime-variables";

/** Public M1 facade. Figma-compatible members stay here; project-specific
 * lifecycle/transaction details remain explicitly named `runtime.*` APIs. */
export class FigmaCompatibleRuntime {
  constructor(readonly session: RuntimeSession) {}

  /** Figma-compatible identity sentinel for mixed projected property values. */
  get mixed(): typeof RUNTIME_MIXED { return RUNTIME_MIXED; }

  get root(): RuntimeContainerNodeProxy { return this.session.root; }
  get currentPage(): RuntimeContainerNodeProxy { return this.session.currentPage; }
  get variables(): RuntimeVariablesAPI { return this.session.variables; }

  getNodeByIdAsync(nodeId: string): Promise<RuntimeNodeProxy | null> {
    return this.session.getNodeByIdAsync(nodeId);
  }

  getStyleById(styleId: string): RuntimeTextStyle | RuntimePaintStyle | null { return this.session.getStyleById(styleId); }
  getStyleByIdAsync(styleId: string): Promise<RuntimeTextStyle | RuntimePaintStyle | null> { return this.session.getStyleByIdAsync(styleId); }
  getLocalTextStyles(): readonly RuntimeTextStyle[] { return this.session.getLocalTextStyles(); }
  getLocalTextStylesAsync(): Promise<readonly RuntimeTextStyle[]> { return this.session.getLocalTextStylesAsync(); }
  getLocalPaintStyles(): readonly RuntimePaintStyle[] { return this.session.getLocalPaintStyles(); }
  getLocalPaintStylesAsync(): Promise<readonly RuntimePaintStyle[]> { return this.session.getLocalPaintStylesAsync(); }

  createFrame(): RuntimeContainerNodeProxy { return this.session.createFrame(); }
  createGroup(): RuntimeContainerNodeProxy { return this.session.createGroup(); }
  createSection(): RuntimeContainerNodeProxy { return this.session.createSection(); }
  createComponent(): RuntimeContainerNodeProxy { return this.session.createComponent(); }
  createComponentFromNode(node: RuntimeNodeProxy): RuntimeContainerNodeProxy { return this.session.createComponentFromNode(node); }
  createSlice(): RuntimeNodeProxy { return this.session.createSlice(); }
  createRectangle(): RuntimeNodeProxy { return this.session.createRectangle(); }
  createEllipse(): RuntimeNodeProxy { return this.session.createEllipse(); }
  createPolygon(): RuntimeNodeProxy { return this.session.createPolygon(); }
  createStar(): RuntimeNodeProxy { return this.session.createStar(); }
  createVector(): RuntimeNodeProxy { return this.session.createVector(); }
  createLine(): RuntimeNodeProxy { return this.session.createLine(); }
  createText(): RuntimeNodeProxy { return this.session.createText(); }
  createConnector(): RuntimeNodeProxy { return this.session.createConnector(); }
  createShapeWithText(): RuntimeNodeProxy { return this.session.createShapeWithText(); }
  createTextPath(vector: RuntimeNodeProxy, startSegment: number, startPosition: number): RuntimeNodeProxy {
    return this.session.createTextPath(vector, startSegment, startPosition);
  }
  transformGroup(
    nodes: readonly RuntimeNodeProxy[],
    parent: RuntimeContainerNodeProxy,
    index: number,
    modifiers: readonly DocumentTransformModifier[],
  ): RuntimeContainerNodeProxy {
    return this.session.transformGroup(nodes, parent, index, modifiers);
  }
  createImageNode(image: RuntimeImage): RuntimeNodeProxy { return this.session.createImageNode(image); }
  createGif(hash: string): RuntimeNodeProxy { return this.session.createGif(hash); }
  createLinkPreviewAsync(url: string): Promise<RuntimeNodeProxy> { return this.session.createLinkPreviewAsync(url); }
  union(nodes: readonly RuntimeNodeProxy[], parent: RuntimeContainerNodeProxy, index?: number): RuntimeContainerNodeProxy {
    return this.session.union(nodes, parent, index);
  }
  subtract(nodes: readonly RuntimeNodeProxy[], parent: RuntimeContainerNodeProxy, index?: number): RuntimeContainerNodeProxy {
    return this.session.subtract(nodes, parent, index);
  }
  intersect(nodes: readonly RuntimeNodeProxy[], parent: RuntimeContainerNodeProxy, index?: number): RuntimeContainerNodeProxy {
    return this.session.intersect(nodes, parent, index);
  }
  exclude(nodes: readonly RuntimeNodeProxy[], parent: RuntimeContainerNodeProxy, index?: number): RuntimeContainerNodeProxy {
    return this.session.exclude(nodes, parent, index);
  }
  flatten(nodes: readonly RuntimeNodeProxy[], parent?: RuntimeContainerNodeProxy, index?: number): RuntimeNodeProxy {
    return this.session.flatten(nodes, parent, index);
  }

  loadAllPagesAsync(): Promise<void> { return this.session.loadAllPagesAsync(); }

  setCurrentPageAsync(page: RuntimeContainerNodeProxy): Promise<void> {
    return this.session.setCurrentPageAsync(page);
  }

  onViewStateChange(listener: (state: Readonly<{ sequence: number; currentPageId: string; selectedIds: readonly string[] }>) => void): () => void {
    return this.session.onViewStateChange(listener);
  }

  /** Loads an Asset-Service-admitted font before a text mutation can use it. */
  loadFontAsync(font: RuntimeFontName | DocumentFontReference, timeoutMs?: number): Promise<void> {
    return this.session.loadFontAsync(font, timeoutMs);
  }

  listAvailableFontsAsync(): Promise<readonly RuntimeAvailableFont[]> { return this.session.listAvailableFontsAsync(); }

  createImageTask(bytes: Uint8Array, declaredMime: string, options?: RuntimeTaskOptions): RuntimeTask<RuntimeImage> {
    return this.session.createImageTask(bytes, declaredMime, options);
  }

  createImageAsync(bytes: Uint8Array, declaredMime: string, options?: RuntimeTaskOptions): Promise<RuntimeImage> {
    return this.session.createImageAsync(bytes, declaredMime, options);
  }

  getImageByHash(hash: string): RuntimeImage | null { return this.session.getImageByHash(hash); }

  findAllNodesPagedAsync(pageSize?: number, predicate?: (node: RuntimeNodeProxy) => boolean): AsyncIterable<readonly RuntimeNodeProxy[]> {
    return this.session.findAllNodesPagedAsync(pageSize, predicate);
  }

  createPrototypePlayer(startFrameId?: string, options?: Omit<PrototypePlayerOptions, "leasePool">): PrototypePlayer {
    return this.session.createPrototypePlayer(startFrameId, options);
  }

  /** M4D project helper for callers that export a known scene-node ID. */
  exportNodeSvgString(nodeId: string, settings: RuntimeSvgExportSettings = { format: "SVG_STRING" }): Promise<string> {
    if (settings.format !== "SVG_STRING") return Promise.reject(new Error("Unsupported Runtime export format."));
    return this.session.exportNodeSvgString(nodeId);
  }

  /** Project helper for the Figma-compatible PNG export subset. */
  exportNodePng(nodeId: string, settings: RuntimePngExportSettings = { format: "PNG" }): Promise<Uint8Array> {
    return this.session.exportNodePng(nodeId, settings);
  }

  /** Project extension: wait for the explicit Ack + Projection commit fence. */
  commitAsync(): Promise<number> { return this.session.commitAsync(); }

  /** Project extension: flush the session's queued transaction before closing. */
  closeAsync(): Promise<void> { return this.session.closeAsync(); }
}
