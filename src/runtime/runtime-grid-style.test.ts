import { describe, expect, it } from "vitest";
import type { DocumentGridStyleResource } from "../lib/editor-protocol";
import { FigmaCompatibleRuntime } from "./figma-compatible-runtime";
import { RuntimeGridStyle, type RuntimeGridStyleHost } from "./runtime-grid-style";
import { isRuntimeError } from "./runtime-errors";
import type { PendingProjectionTransaction, RuntimeProjection } from "./runtime-projection-store";
import { RuntimeSession } from "./runtime-session";
import type { RuntimeTransactionResult, RuntimeTransactionTransport } from "./runtime-transaction-client";

describe("RuntimeGridStyle", () => {
  it("creates, persists, queries, updates and removes a canonical GridStyle", async () => {
    const projection: RuntimeProjection = {
      revision: 2,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document" },
        { id: "page", type: "PAGE", name: "Page", parentId: "document", siblingIndex: 0 },
      ],
    };
    const transport = new GridStyleTransport(projection);
    const session = new RuntimeSession({
      sessionId: "grid-style-lifecycle",
      projection,
      transport,
      createId: () => "00000000-0000-4000-8000-000000000103",
      scheduleMicrotask: () => {},
    });
    const figma = new FigmaCompatibleRuntime(session);

    const style = figma.createGridStyle();
    style.name = "Desktop/12 columns";
    style.layoutGrids = [{
      pattern: "COLUMNS",
      alignment: "STRETCH",
      sectionSize: 10,
      count: 12,
      gutterSize: 24,
      offset: 80,
      visible: true,
      color: { r: 1, g: 0, b: 0, a: 0.1 },
    }];
    expect(figma.getLocalGridStyles().map((candidate) => candidate.id)).toEqual([style.id]);
    expect((await figma.getStyleByIdAsync(style.id))?.type).toBe("GRID");
    await session.commitAsync();

    const reopened = new RuntimeSession({
      sessionId: "grid-style-reopened",
      projection: transport.currentProjection(),
      transport,
      scheduleMicrotask: () => {},
    });
    const persisted = await reopened.getStyleByIdAsync(style.id);
    expect(persisted).toMatchObject({ id: style.id, type: "GRID", name: "Desktop/12 columns" });
    if (!persisted || persisted.type !== "GRID") throw new Error("Missing GridStyle fixture");
    expect(persisted.layoutGrids).toHaveLength(1);
    persisted.remove();
    await reopened.commitAsync();
    expect((await reopened.getLocalGridStylesAsync()).map((candidate) => candidate.id)).toEqual([]);
  });

  it("projects supported layout grids and writes metadata through the live canonical host", () => {
    const resources = new Map<string, DocumentGridStyleResource>();
    const initial: DocumentGridStyleResource = {
      id: "S:columns",
      key: "",
      name: "Columns",
      description: "",
      descriptionMarkdown: "",
      documentationLinks: [],
      remote: false,
      layoutGrids: [],
    };
    resources.set(initial.id, initial);
    const host: RuntimeGridStyleHost = {
      gridStyleResource: (id) => resources.get(id),
      setGridStyle: (style) => { resources.set(style.id, structuredClone(style)); },
      deleteGridStyle: (id) => { resources.delete(id); },
      getPluginData: () => "",
      setPluginData: () => undefined,
      getPluginDataKeys: () => [],
      getSharedPluginData: () => "",
      setSharedPluginData: () => undefined,
      getSharedPluginDataKeys: () => [],
    };
    const style = new RuntimeGridStyle(initial, host);
    style.layoutGrids = [
      { pattern: "ROWS", alignment: "MIN", sectionSize: 8, count: Infinity, gutterSize: 16, offset: 0, visible: true, color: { r: 1, g: 0, b: 0, a: 0.1 } },
      { pattern: "GRID", sectionSize: 8, visible: false, color: { r: 0, g: 0, b: 1, a: 0.1 } },
    ];
    style.descriptionMarkdown = "**Elevation**";
    expect(style.layoutGrids).toEqual([
      { pattern: "ROWS", alignment: "MIN", sectionSize: 8, count: Infinity, gutterSize: 16, offset: 0, visible: true, color: { r: 1, g: 0, b: 0, a: 0.1 } },
      { pattern: "GRID", sectionSize: 8, visible: false, color: { r: 0, g: 0, b: 1, a: 0.1 } },
    ]);
    expect(resources.get(initial.id)?.descriptionMarkdown).toBe("**Elevation**");
    expect(style.boundVariables).toBeUndefined();
    expect(style.consumers).toEqual([]);
  });

  it("fails closed for invalid layout grids and removed resources", () => {
    let resource: DocumentGridStyleResource | undefined = {
      id: "S:grid",
      key: "",
      name: "Grid",
      description: "",
      descriptionMarkdown: "",
      documentationLinks: [],
      remote: false,
      layoutGrids: [],
    };
    const host = {
      gridStyleResource: () => resource,
      setGridStyle: (next: DocumentGridStyleResource) => { resource = next; },
      deleteGridStyle: () => { resource = undefined; },
      getPluginData: () => "",
      setPluginData: () => undefined,
      getPluginDataKeys: () => [],
      getSharedPluginData: () => "",
      setSharedPluginData: () => undefined,
      getSharedPluginDataKeys: () => [],
    } satisfies RuntimeGridStyleHost;
    const style = new RuntimeGridStyle(resource, host);
    expect(isRuntimeError(capture(() => {
      style.layoutGrids = [{ pattern: "GRID", sectionSize: 0, visible: true, color: { r: 1, g: 0, b: 0, a: 0.1 } }];
    }), "INVALID_ARGUMENT")).toBe(true);
    style.remove();
    expect(isRuntimeError(capture(() => style.layoutGrids), "RESOURCE_UNAVAILABLE")).toBe(true);
  });
});

class GridStyleTransport implements RuntimeTransactionTransport {
  private projection: RuntimeProjection;

  constructor(projection: RuntimeProjection) {
    this.projection = structuredClone(projection);
  }

  currentProjection(): RuntimeProjection { return structuredClone(this.projection); }

  async submit(transaction: PendingProjectionTransaction): Promise<RuntimeTransactionResult> {
    const gridStyles = new Map((this.projection.gridStyles ?? []).map((style) => [style.id, structuredClone(style)]));
    for (const operation of transaction.operations) {
      if (operation.type === "registerGridStyle" || operation.type === "setGridStyle") {
        gridStyles.set(operation.style.id, structuredClone(operation.style));
      } else if (operation.type === "deleteGridStyle") {
        gridStyles.delete(operation.id);
      }
    }
    this.projection = {
      ...this.projection,
      revision: this.projection.revision + 1,
      gridStyles: [...gridStyles.values()],
    };
    return { type: "accepted", acceptedRevision: this.projection.revision, projection: this.currentProjection() };
  }
}

function capture(callback: () => unknown): unknown {
  try { return callback(); } catch (error) { return error; }
}
