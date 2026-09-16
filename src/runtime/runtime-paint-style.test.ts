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
      descriptionMarkdown: "**Primary surface**",
      documentationLinks: [],
      remote: false,
      paints: { layers: [{ visible: true, opacity: .75, blendMode: "multiply", paint: { css: "#ff0000ff", color: { space: "srgb", components: [1, 0, 0], alpha: 1 } } }] },
    },
    {
      id: "S:remote-fill",
      key: "library-key",
      name: "Library fill",
      description: "",
      descriptionMarkdown: "",
      documentationLinks: [],
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
  it("creates a local empty PaintStyle through the pending canonical catalog", async () => {
    const transport = new StyleTransport(projection);
    const session = new RuntimeSession({
      sessionId: "create-paint-style",
      projection,
      transport,
      createId: () => "00000000-0000-4000-8000-000000000102",
      scheduleMicrotask: () => {},
    });
    const figma = new FigmaCompatibleRuntime(session);

    const style = figma.createPaintStyle();
    expect(style).toMatchObject({
      id: "S:00000000-0000-4000-8000-000000000102",
      type: "PAINT",
      name: "Paint Style",
      remote: false,
      paints: [],
    });
    expect((await figma.getStyleByIdAsync(style.id))?.id).toBe(style.id);
    expect((await figma.getLocalPaintStylesAsync()).map((candidate) => candidate.id)).toEqual(["S:brand-fill", style.id]);
    expect(session.projectionStore.transaction(session.projectionStore.pendingTransactionIds()[0]!)?.operations).toEqual([
      { type: "registerPaintStyle", style: expect.objectContaining({ id: style.id, key: "", remote: false, paints: { layers: [] } }) },
    ]);

    await session.commitAsync();
    const reopenedProjection = transport.currentProjection();
    const reopened = new RuntimeSession({ sessionId: "created-paint-style", projection: reopenedProjection, transport: new ReadOnlyTransport(), scheduleMicrotask: () => {} });
    expect((await reopened.getStyleByIdAsync(style.id))?.id).toBe(style.id);
  });

  it("queries complete canonical paints and filters remote styles", async () => {
    const session = new RuntimeSession({ sessionId: "paint-styles", projection, transport: new ReadOnlyTransport(), scheduleMicrotask: () => {} });
    const figma = new FigmaCompatibleRuntime(session);
    const style = await figma.getStyleByIdAsync("S:brand-fill");

    expect(style).toMatchObject({ id: "S:brand-fill", type: "PAINT", name: "Brand fill", remote: false });
    expect(style?.type === "PAINT" ? style.paints : undefined).toEqual([{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: .75, visible: true, blendMode: "MULTIPLY", boundVariables: undefined }]);
    expect(await style?.getStyleConsumersAsync()).toEqual([]);
    expect((await figma.getLocalPaintStylesAsync()).map((entry) => entry.id)).toEqual(["S:brand-fill"]);
    expect(await figma.getStyleByIdAsync("missing")).toBeNull();
    const remote = await figma.getStyleByIdAsync("S:remote-fill");
    expect(isRuntimeError(capture(() => { if (remote) remote.name = "Changed"; }), "UNSUPPORTED_FEATURE")).toBe(true);
  });

  it("updates local style metadata and atomically unlinks node consumers before removal", async () => {
    const linkedProjection: RuntimeProjection = {
      ...projection,
      nodes: [...projection.nodes, {
        id: "rect",
        type: "RECTANGLE",
        name: "Card",
        parentId: "page",
        siblingIndex: 0,
        fillStyleId: "S:brand-fill",
        fillStack: structuredClone(projection.paintStyles![0]!.paints),
      }],
    };
    const transport = new StyleTransport(linkedProjection);
    const session = new RuntimeSession({ sessionId: "paint-style-lifecycle", projection: linkedProjection, transport, scheduleMicrotask: () => {} });
    const style = await session.getStyleByIdAsync("S:brand-fill");
    if (!style || style.type !== "PAINT") throw new Error("Missing PaintStyle fixture");

    style.name = "Color/Brand";
    style.description = "Primary brand surface";
    style.descriptionMarkdown = "**Primary brand surface**";
    style.documentationLinks = [{ uri: "https://design.example/color/brand" }];
    style.paints = [{ type: "SOLID", color: { r: 0.1, g: 0.2, b: 0.3 }, opacity: 0.8 }];
    expect(style.name).toBe("Color/Brand");
    expect(style.descriptionMarkdown).toBe("**Primary brand surface**");
    expect(style.documentationLinks).toEqual([{ uri: "https://design.example/color/brand" }]);
    expect(style.paints).toEqual([{
      type: "SOLID",
      color: { r: 0.1, g: 0.2, b: 0.3 },
      visible: true,
      opacity: 0.8,
      blendMode: "NORMAL",
    }]);
    expect(isRuntimeError(capture(() => { style.description = "bad\0value"; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(capture(() => { style.paints = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 2 }]; }), "INVALID_ARGUMENT")).toBe(true);

    await session.commitAsync();
    expect(transport.currentProjection().paintStyles?.find((candidate) => candidate.id === style.id)).toMatchObject({
      name: "Color/Brand",
      description: "Primary brand surface",
      descriptionMarkdown: "**Primary brand surface**",
      documentationLinks: [{ uri: "https://design.example/color/brand" }],
      paints: { layers: [{ opacity: 0.8, blendMode: "normal", paint: { color: { space: "srgb", components: [0.1, 0.2, 0.3], alpha: 1 } } }] },
    });

    style.remove();
    expect(await session.getStyleByIdAsync(style.id)).toBeNull();
    expect(session.projectionStore.getNode("rect")).toMatchObject({ fillStyleId: undefined });
    const operations = session.projectionStore.transaction(session.projectionStore.pendingTransactionIds()[0]!)!.operations;
    expect(operations.at(-2)).toMatchObject({ type: "update", nodeId: "rect", patch: { fillStyleId: undefined } });
    expect(operations.at(-1)).toEqual({ type: "deletePaintStyle", id: style.id });

    await session.commitAsync();
    const reopenedProjection = transport.currentProjection();
    expect(reopenedProjection.paintStyles?.some((candidate) => candidate.id === style.id)).toBe(false);
    expect(reopenedProjection.nodes.find((node) => node.id === "rect")?.fillStyleId).toBeUndefined();
  });

  it("persists solid and gradient-stop color bindings on PaintStyle resources", async () => {
    const variableProjection: RuntimeProjection = {
      ...projection,
      variableCollections: [{
        id: "VC:colors", key: "", name: "Colors", remote: false, hiddenFromPublishing: false,
        modes: [{ modeId: "default", name: "Default" }], defaultModeId: "default",
      }],
      variables: [
        {
          id: "V:brand", key: "", name: "Brand", description: "", remote: false, hiddenFromPublishing: false,
          collectionId: "VC:colors", resolvedType: "COLOR", valuesByMode: { default: { space: "srgb", components: [0.1, 0.2, 0.3], alpha: 1 } }, scopes: ["ALL_FILLS"],
        },
        {
          id: "V:accent", key: "", name: "Accent", description: "", remote: false, hiddenFromPublishing: false,
          collectionId: "VC:colors", resolvedType: "COLOR", valuesByMode: { default: { space: "srgb", components: [0.8, 0.7, 0.6], alpha: 0.5 } }, scopes: ["ALL_FILLS"],
        },
        {
          id: "V:number", key: "", name: "Number", description: "", remote: false, hiddenFromPublishing: false,
          collectionId: "VC:colors", resolvedType: "FLOAT", valuesByMode: { default: 8 }, scopes: ["ALL_SCOPES"],
        },
      ],
    };
    const transport = new StyleTransport(variableProjection);
    const session = new RuntimeSession({ sessionId: "paint-style-variables", projection: variableProjection, transport, scheduleMicrotask: () => {} });
    const style = await session.getStyleByIdAsync("S:brand-fill");
    const brand = await session.variables.getVariableByIdAsync("V:brand");
    const accent = await session.variables.getVariableByIdAsync("V:accent");
    if (!style || style.type !== "PAINT" || !brand || !accent) throw new Error("Missing PaintStyle variable fixtures");
    const brandAlias = session.variables.createVariableAlias(brand);
    const accentAlias = session.variables.createVariableAlias(accent);

    style.paints = [
      { type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: 0.8, boundVariables: { color: brandAlias } },
      {
        type: "GRADIENT_LINEAR",
        gradientTransform: [[1, 0, 0], [0, 1, 0]],
        gradientStops: [
          { position: 0, color: { r: 1, g: 1, b: 1, a: 1 }, boundVariables: { color: accentAlias } },
          { position: 1, color: { r: 0, g: 0, b: 0, a: 1 } },
        ],
      },
    ];
    expect(style.boundVariables).toEqual({
      paints: [
        { type: "VARIABLE_ALIAS", id: "V:brand" },
        { type: "VARIABLE_ALIAS", id: "V:accent" },
      ],
    });
    expect(style.paints[0]).toMatchObject({ type: "SOLID", color: { r: 0.1, g: 0.2, b: 0.3 }, opacity: 0.8, boundVariables: { color: { id: "V:brand" } } });
    expect(style.paints[1]).toMatchObject({
      type: "GRADIENT_LINEAR",
      gradientStops: [
        { color: { r: 0.8, g: 0.7, b: 0.6, a: 0.5 }, boundVariables: { color: { id: "V:accent" } } },
        { position: 1 },
      ],
    });
    expect(isRuntimeError(capture(() => brand.remove()), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(capture(() => { style.paints = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, boundVariables: { color: { type: "VARIABLE_ALIAS", id: "V:number" } } }]; }), "RESOURCE_UNAVAILABLE")).toBe(true);
    await session.commitAsync();
    expect(transport.currentProjection().paintStyles?.find((candidate) => candidate.id === style.id)?.variableBindings).toEqual([
      { paintIndex: 0, variableId: "V:brand" },
      { paintIndex: 1, stopIndex: 0, variableId: "V:accent" },
    ]);

    brand.setValueForMode("default", { r: 0.4, g: 0.5, b: 0.6, a: 1 });
    expect(style.paints[0]).toMatchObject({ color: { r: 0.4, g: 0.5, b: 0.6 }, boundVariables: { color: { id: "V:brand" } } });
    expect(session.projectionStore.transaction(session.projectionStore.pendingTransactionIds()[0]!)?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "setVariable", variable: expect.objectContaining({ id: "V:brand" }) }),
      expect.objectContaining({ type: "setPaintStyle", style: expect.objectContaining({ id: "S:brand-fill" }) }),
    ]));

    style.paints = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }];
    expect(style.boundVariables).toBeUndefined();
    expect(style.paints[0]).not.toHaveProperty("boundVariables");
    await session.commitAsync();
    expect(transport.currentProjection().paintStyles?.find((candidate) => candidate.id === style.id)?.variableBindings).toBeUndefined();
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

  currentProjection(): RuntimeProjection { return structuredClone(this.projection); }

  async submit(transaction: PendingProjectionTransaction): Promise<RuntimeTransactionResult> {
    this.submitted.push(transaction);
    const nodes = new Map(this.projection.nodes.map((node) => [node.id, structuredClone(node)]));
    const paintStyles = new Map((this.projection.paintStyles ?? []).map((style) => [style.id, structuredClone(style)]));
    const variables = new Map((this.projection.variables ?? []).map((variable) => [variable.id, structuredClone(variable)]));
    for (const operation of transaction.operations) {
      if (operation.type === "registerPaintStyle") {
        paintStyles.set(operation.style.id, structuredClone(operation.style));
        continue;
      }
      if (operation.type === "setPaintStyle") {
        paintStyles.set(operation.style.id, structuredClone(operation.style));
        continue;
      }
      if (operation.type === "deletePaintStyle") {
        paintStyles.delete(operation.id);
        continue;
      }
      if (operation.type === "setVariable" || operation.type === "registerVariable") {
        variables.set(operation.variable.id, structuredClone(operation.variable));
        continue;
      }
      if (operation.type === "deleteVariable") {
        variables.delete(operation.id);
        continue;
      }
      if (operation.type !== "update") continue;
      const node = nodes.get(operation.nodeId);
      if (node) nodes.set(operation.nodeId, { ...node, ...structuredClone(operation.patch) });
    }
    this.projection = { ...this.projection, revision: this.projection.revision + 1, nodes: [...nodes.values()], paintStyles: [...paintStyles.values()], variables: [...variables.values()] };
    return { type: "accepted", acceptedRevision: this.projection.revision, projection: this.projection };
  }
}

function capture(callback: () => unknown): unknown {
  try { return callback(); } catch (error) { return error; }
}
