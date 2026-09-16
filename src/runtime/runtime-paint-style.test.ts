import { describe, expect, it } from "vitest";
import { FigmaCompatibleRuntime } from "./figma-compatible-runtime";
import { RuntimeSession } from "./runtime-session";
import type { PendingProjectionTransaction, RuntimeProjection } from "./runtime-projection-store";
import type { RuntimeTransactionResult, RuntimeTransactionTransport } from "./runtime-transaction-client";
import { isRuntimeError } from "./runtime-errors";

const projection: RuntimeProjection = {
  revision: 7,
  paintStyles: [
    {
      id: "S:brand-fill",
      key: "",
      name: "Brand fill",
      description: "Primary surface",
      remote: false,
      paints: { layers: [{ visible: true, opacity: .75, blendMode: "multiply", paint: { css: "#ff0000ff", color: { space: "srgb", components: [1, 0, 0], alpha: 1 } } }] },
    },
    {
      id: "S:remote-fill",
      key: "library-key",
      name: "Library fill",
      description: "",
      remote: true,
      paints: { layers: [] },
    },
  ],
  nodes: [
    { id: "document", type: "DOCUMENT", name: "Document" },
    { id: "page", type: "PAGE", name: "Page", parentId: "document", siblingIndex: 0 },
  ],
};

describe("PaintStyle resource runtime", () => {
  it("queries complete canonical paints and filters remote styles", async () => {
    const session = new RuntimeSession({ sessionId: "paint-styles", projection, transport: new ReadOnlyTransport(), scheduleMicrotask: () => {} });
    const figma = new FigmaCompatibleRuntime(session);
    const style = await figma.getStyleByIdAsync("S:brand-fill");

    expect(style).toMatchObject({ id: "S:brand-fill", type: "PAINT", name: "Brand fill", remote: false });
    expect(style?.type === "PAINT" ? style.paints : undefined).toEqual([{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: .75, visible: true, blendMode: "MULTIPLY", boundVariables: undefined }]);
    expect(await style?.getStyleConsumersAsync()).toEqual([]);
    expect((await figma.getLocalPaintStylesAsync()).map((entry) => entry.id)).toEqual(["S:brand-fill"]);
    expect(await figma.getStyleByIdAsync("missing")).toBeNull();
    expect(isRuntimeError(capture(() => { if (style) style.name = "Changed"; }), "UNSUPPORTED_FEATURE")).toBe(true);
  });

  it("keeps deprecated synchronous reads behind full-document access", () => {
    const session = new RuntimeSession({ sessionId: "paint-styles-dynamic", projection, transport: new ReadOnlyTransport(), documentAccess: "dynamic-page", scheduleMicrotask: () => {} });
    expect(isRuntimeError(capture(() => session.getLocalPaintStyles()), "PAGE_NOT_LOADED")).toBe(true);
  });

  it("applies, reports, and unlinks complete PaintStyle values", async () => {
    const styledProjection: RuntimeProjection = {
      ...projection,
      nodes: [
        ...projection.nodes,
        {
          id: "rect",
          type: "RECTANGLE",
          name: "Card",
          parentId: "page",
          siblingIndex: 0,
          fillStack: { layers: [] },
          strokeStack: { layers: [] },
        },
      ],
    };
    const transport = new StyleTransport(styledProjection);
    const session = new RuntimeSession({ sessionId: "paint-style-apply", projection: styledProjection, transport, scheduleMicrotask: () => {} });
    const rectangle = (await session.getNodeByIdAsync("rect"))!;

    rectangle.fillStyleId = "S:brand-fill";
    expect(rectangle.fillStyleId).toBe("S:brand-fill");
    expect(rectangle.fills).toEqual([{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: .75, visible: true, blendMode: "MULTIPLY", boundVariables: undefined }]);
    const style = await session.getStyleByIdAsync("S:brand-fill");
    expect((await style?.getStyleConsumersAsync())?.map((consumer) => ({ id: consumer.node.id, fields: consumer.fields }))).toEqual([
      { id: "rect", fields: ["fillStyleId"] },
    ]);

    rectangle.fillStyleId = "";
    expect(rectangle.fillStyleId).toBe("");
    expect(rectangle.fills).toHaveLength(1);
    expect(isRuntimeError(capture(() => { rectangle.strokeStyleId = "S:missing"; }), "RESOURCE_UNAVAILABLE")).toBe(true);

    await rectangle.setStrokeStyleIdAsync("S:brand-fill");
    expect(transport.submitted).toHaveLength(1);
    expect(rectangle.strokeStyleId).toBe("S:brand-fill");
  });

  it("requires the async setter when only the current page is loaded", async () => {
    const dynamicProjection: RuntimeProjection = {
      ...projection,
      nodes: [...projection.nodes, { id: "rect", type: "RECTANGLE", name: "Card", parentId: "page", siblingIndex: 0 }],
    };
    const session = new RuntimeSession({ sessionId: "paint-style-dynamic", projection: dynamicProjection, transport: new StyleTransport(dynamicProjection), documentAccess: "dynamic-page", loadedPageIds: ["page"], scheduleMicrotask: () => {} });
    const rectangle = (await session.getNodeByIdAsync("rect"))!;
    expect(isRuntimeError(capture(() => { rectangle.fillStyleId = "S:brand-fill"; }), "PAGE_NOT_LOADED")).toBe(true);
    await rectangle.setFillStyleIdAsync("S:brand-fill");
    expect(rectangle.fillStyleId).toBe("S:brand-fill");
  });
});

class ReadOnlyTransport implements RuntimeTransactionTransport {
  submit(_transaction: PendingProjectionTransaction): Promise<RuntimeTransactionResult> {
    void _transaction;
    throw new Error("No writes expected");
  }
}

class StyleTransport implements RuntimeTransactionTransport {
  submitted: PendingProjectionTransaction[] = [];
  private projection: RuntimeProjection;

  constructor(projection: RuntimeProjection) {
    this.projection = structuredClone(projection);
  }

  async submit(transaction: PendingProjectionTransaction): Promise<RuntimeTransactionResult> {
    this.submitted.push(transaction);
    const nodes = new Map(this.projection.nodes.map((node) => [node.id, structuredClone(node)]));
    for (const operation of transaction.operations) {
      if (operation.type !== "update") continue;
      const node = nodes.get(operation.nodeId);
      if (node) nodes.set(operation.nodeId, { ...node, ...structuredClone(operation.patch) });
    }
    this.projection = { ...this.projection, revision: this.projection.revision + 1, nodes: [...nodes.values()] };
    return { type: "accepted", acceptedRevision: this.projection.revision, projection: this.projection };
  }
}

function capture(callback: () => unknown): unknown {
  try { return callback(); } catch (error) { return error; }
}
