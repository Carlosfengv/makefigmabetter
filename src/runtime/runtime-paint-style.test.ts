import { describe, expect, it } from "vitest";
import { FigmaCompatibleRuntime } from "./figma-compatible-runtime";
import { RuntimeSession } from "./runtime-session";
import type { PendingProjectionTransaction, RuntimeProjection } from "./runtime-projection-store";
import type { RuntimeTransactionResult, RuntimeTransactionTransport } from "./runtime-transaction-client";
import { isRuntimeError } from "./runtime-errors";
import { RUNTIME_MIXED } from "./node-proxy";

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

  it("reads and writes PaintStyle plugin data through the style host", async () => {
    const session = new RuntimeSession({ sessionId: "paint-style-data", pluginId: "com.example.paint", projection, transport: new StyleTransport(projection), scheduleMicrotask: () => {} });
    const style = await session.getStyleByIdAsync("S:brand-fill");
    if (!style || style.type !== "PAINT") throw new Error("Missing PaintStyle fixture");

    style.setPluginData("owner", "design-system");
    style.setSharedPluginData("com.example.tokens", "token", "brand.primary");
    expect(style.getPluginData("owner")).toBe("design-system");
    expect(style.getPluginDataKeys()).toEqual(["owner"]);
    expect(style.getSharedPluginData("com.example.tokens", "token")).toBe("brand.primary");
    style.setPluginData("owner", "");
    expect(style.getPluginDataKeys()).toEqual([]);
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

  it("applies PaintStyle links to text ranges and clears only the changed range", async () => {
    const textProjection: RuntimeProjection = {
      ...projection,
      nodes: [
        ...projection.nodes,
        {
          id: "text",
          type: "TEXT",
          name: "Copy",
          parentId: "page",
          siblingIndex: 0,
          characters: "ABCD",
          textProperties: {
            runs: [
              { start: 0, end: 2, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 },
              { start: 2, end: 4, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 },
            ],
            paragraph: { alignment: "left", paragraphSpacing: 0 },
            autoSize: "fixed",
          },
        },
      ],
    };
    const transport = new StyleTransport(textProjection);
    const session = new RuntimeSession({ sessionId: "paint-style-text", projection: textProjection, transport, documentAccess: "dynamic-page", loadedPageIds: ["page"], scheduleMicrotask: () => {} });
    const text = (await session.getNodeByIdAsync("text"))!;

    expect(isRuntimeError(capture(() => text.setRangeFillStyleId(0, 2, "S:brand-fill")), "PAGE_NOT_LOADED")).toBe(true);
    await text.setRangeFillStyleIdAsync(0, 2, "S:brand-fill");
    expect(text.getRangeFillStyleId(0, 2)).toBe("S:brand-fill");
    expect(text.getRangeFillStyleId(2, 4)).toBe("");
    expect(text.fillStyleId).toBe(RUNTIME_MIXED);
    expect(text.getRangeFills(0, 2)).toEqual([{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: .75, visible: true, blendMode: "MULTIPLY", boundVariables: undefined }]);

    const style = await session.getStyleByIdAsync("S:brand-fill");
    expect((await style?.getStyleConsumersAsync())?.map((consumer) => ({ id: consumer.node.id, fields: consumer.fields }))).toEqual([
      { id: "text", fields: ["fillStyleId"] },
    ]);

    text.setRangeFills(0, 2, []);
    expect(text.getRangeFillStyleId(0, 2)).toBe("");
    expect(text.getRangeFills(0, 2)).toEqual([]);
    expect(isRuntimeError(capture(() => { text.fillStyleId = "S:missing"; }), "PAGE_NOT_LOADED")).toBe(true);
    await expect(text.setRangeFillStyleIdAsync(0, 2, "S:missing")).rejects.toSatisfy(
      (error: unknown) => isRuntimeError(error, "RESOURCE_UNAVAILABLE"),
    );
  });

  it("applies PaintStyle links to an empty ShapeWithText insertion style", async () => {
    const shapeProjection: RuntimeProjection = {
      ...projection,
      nodes: [
        ...projection.nodes,
        {
          id: "shape",
          type: "SHAPE_WITH_TEXT",
          name: "Label",
          parentId: "page",
          siblingIndex: 0,
          characters: "",
          textProperties: {
            runs: [],
            baseStyle: { fontSize: 14, fontWeight: 400, italic: false, letterSpacing: 0 },
            paragraph: { alignment: "center", paragraphSpacing: 0 },
            autoSize: "fixed",
          },
        },
      ],
    };
    const session = new RuntimeSession({ sessionId: "paint-style-shape-text", projection: shapeProjection, transport: new StyleTransport(shapeProjection), scheduleMicrotask: () => {} });
    const shape = (await session.getNodeByIdAsync("shape"))!;

    await shape.text.setFillStyleIdAsync("S:brand-fill");
    expect(shape.text.fillStyleId).toBe("S:brand-fill");
    expect(shape.text.getRangeFillStyleId(0, 0)).toBe("S:brand-fill");
    expect(shape.text.fills).toEqual([{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: .75, visible: true, blendMode: "MULTIPLY", boundVariables: undefined }]);

    shape.text.fills = [];
    expect(shape.text.fillStyleId).toBe("");
    expect(shape.text.fills).toEqual([]);
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
