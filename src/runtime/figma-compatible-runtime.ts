import { RuntimeContainerNodeProxy } from "./container-node-proxy";
import { RuntimeNodeProxy } from "./node-proxy";
import { RuntimeSession, type RuntimeAvailableFont, type RuntimeImage, type RuntimeTaskOptions } from "./runtime-session";
import type { DocumentFontReference } from "../lib/editor-protocol";
import { RuntimeTask } from "./runtime-task";
import { PrototypePlayer, type PrototypePlayerOptions } from "./prototype-player";
import type { RuntimePngExportSettings, RuntimeSvgExportSettings } from "./runtime-svg-export";

/** Public M1 facade. Figma-compatible members stay here; project-specific
 * lifecycle/transaction details remain explicitly named `runtime.*` APIs. */
export class FigmaCompatibleRuntime {
  constructor(readonly session: RuntimeSession) {}

  get root(): RuntimeContainerNodeProxy { return this.session.root; }
  get currentPage(): RuntimeContainerNodeProxy { return this.session.currentPage; }

  getNodeByIdAsync(nodeId: string): Promise<RuntimeNodeProxy | null> {
    return this.session.getNodeByIdAsync(nodeId);
  }

  createFrame(): RuntimeContainerNodeProxy { return this.session.createFrame(); }
  createGroup(): RuntimeContainerNodeProxy { return this.session.createGroup(); }
  createSection(): RuntimeContainerNodeProxy { return this.session.createSection(); }
  createRectangle(): RuntimeNodeProxy { return this.session.createRectangle(); }
  createEllipse(): RuntimeNodeProxy { return this.session.createEllipse(); }
  createLine(): RuntimeNodeProxy { return this.session.createLine(); }
  createText(): RuntimeNodeProxy { return this.session.createText(); }
  createImageNode(image: RuntimeImage): RuntimeNodeProxy { return this.session.createImageNode(image); }

  loadAllPagesAsync(): Promise<void> { return this.session.loadAllPagesAsync(); }

  setCurrentPageAsync(page: RuntimeContainerNodeProxy): Promise<void> {
    return this.session.setCurrentPageAsync(page);
  }

  onViewStateChange(listener: (state: Readonly<{ sequence: number; currentPageId: string; selectedIds: readonly string[] }>) => void): () => void {
    return this.session.onViewStateChange(listener);
  }

  /** Loads an Asset-Service-admitted font before a text mutation can use it. */
  loadFontAsync(font: DocumentFontReference, timeoutMs?: number): Promise<void> {
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
