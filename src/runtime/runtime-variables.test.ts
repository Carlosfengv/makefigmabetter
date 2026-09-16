import { describe, expect, it } from "vitest";
import { FigmaCompatibleRuntime } from "./figma-compatible-runtime";
import { RUNTIME_MIXED } from "./node-proxy";
import { isRuntimeError } from "./runtime-errors";
import type { PendingProjectionTransaction, RuntimeProjection } from "./runtime-projection-store";
import { RuntimeSession } from "./runtime-session";
import type { RuntimeTransactionResult, RuntimeTransactionTransport } from "./runtime-transaction-client";

const projection: RuntimeProjection = {
  revision: 3,
  variableCollections: [
    { id: "VC:theme", key: "", name: "Theme", remote: false, hiddenFromPublishing: false, modes: [{ modeId: "light", name: "Light" }, { modeId: "dark", name: "Dark" }], defaultModeId: "light" },
    { id: "VC:library", key: "collection-key", name: "Library", remote: true, hiddenFromPublishing: false, modes: [{ modeId: "base", name: "Base" }], defaultModeId: "base" },
  ],
  variables: [
    { id: "V:spacing", key: "", name: "Spacing", description: "Base gap", remote: false, hiddenFromPublishing: false, collectionId: "VC:theme", resolvedType: "FLOAT", valuesByMode: { light: 8, dark: 12 }, scopes: ["GAP"] },
    { id: "V:spacing-alias", key: "", name: "Spacing alias", description: "", remote: false, hiddenFromPublishing: false, collectionId: "VC:theme", resolvedType: "FLOAT", valuesByMode: { light: { type: "VARIABLE_ALIAS", id: "V:spacing" }, dark: 16 }, scopes: [] },
    { id: "V:surface", key: "", name: "Surface", description: "", remote: false, hiddenFromPublishing: false, collectionId: "VC:theme", resolvedType: "COLOR", valuesByMode: { light: { space: "display-p3", components: [1, .5, 0], alpha: .75 }, dark: { space: "srgb", components: [0, 0, 0], alpha: 1 } }, scopes: ["ALL_FILLS"] },
    { id: "V:opacity", key: "", name: "Opacity", description: "", remote: false, hiddenFromPublishing: false, collectionId: "VC:theme", resolvedType: "FLOAT", valuesByMode: { light: .5, dark: .8 }, scopes: ["OPACITY"] },
    { id: "V:visible", key: "", name: "Visible", description: "", remote: false, hiddenFromPublishing: false, collectionId: "VC:theme", resolvedType: "BOOLEAN", valuesByMode: { light: false, dark: true }, scopes: ["ALL_SCOPES"] },
    { id: "V:width", key: "", name: "Width", description: "", remote: false, hiddenFromPublishing: false, collectionId: "VC:theme", resolvedType: "FLOAT", valuesByMode: { light: 120, dark: 180 }, scopes: ["WIDTH_HEIGHT"] },
    { id: "V:height", key: "", name: "Height", description: "", remote: false, hiddenFromPublishing: false, collectionId: "VC:theme", resolvedType: "FLOAT", valuesByMode: { light: 60, dark: 90 }, scopes: ["WIDTH_HEIGHT"] },
    { id: "V:label", key: "", name: "Label", description: "", remote: false, hiddenFromPublishing: false, collectionId: "VC:theme", resolvedType: "STRING", valuesByMode: { light: "Light", dark: "Dark" }, scopes: ["TEXT_CONTENT"] },
    { id: "V:remote", key: "variable-key", name: "Remote", description: "", remote: true, hiddenFromPublishing: false, collectionId: "VC:library", resolvedType: "STRING", valuesByMode: { base: "Library value" }, scopes: [] },
  ],
  nodes: [
    { id: "document", type: "DOCUMENT", name: "Document" },
    { id: "page", type: "PAGE", name: "Page", parentId: "document", siblingIndex: 0 },
  ],
};

describe("Variables resource runtime", () => {
  it("queries local catalogs and resolves default-mode values and aliases", async () => {
    const session = new RuntimeSession({ sessionId: "variables", projection, transport: new ReadOnlyTransport(), scheduleMicrotask: () => {} });
    const figma = new FigmaCompatibleRuntime(session);

    expect((await figma.variables.getLocalVariableCollectionsAsync()).map((value) => value.id)).toEqual(["VC:theme"]);
    expect((await figma.variables.getLocalVariablesAsync("FLOAT")).map((value) => value.id)).toEqual(["V:spacing", "V:spacing-alias", "V:opacity", "V:width", "V:height"]);
    const collection = await figma.variables.getVariableCollectionByIdAsync("VC:theme");
    expect(collection).toMatchObject({ name: "Theme", defaultModeId: "light", variableIds: ["V:spacing", "V:spacing-alias", "V:surface", "V:opacity", "V:visible", "V:width", "V:height", "V:label"] });

    const alias = await figma.variables.getVariableByIdAsync("V:spacing-alias");
    expect(alias?.valuesByMode.light).toEqual({ type: "VARIABLE_ALIAS", id: "V:spacing" });
    expect(alias?.resolveForConsumer(figma.currentPage)).toEqual({ value: 8, resolvedType: "FLOAT" });
    expect(figma.variables.createVariableAlias(alias!)).toEqual({ type: "VARIABLE_ALIAS", id: "V:spacing-alias" });

    const color = await figma.variables.getVariableByIdAsync("V:surface");
    expect(color?.resolveForConsumer(figma.currentPage)).toEqual({ value: { r: 1, g: .5, b: 0, a: .75 }, resolvedType: "COLOR" });
    expect(await figma.variables.getVariableByIdAsync("missing")).toBeNull();
  });

  it("keeps deprecated synchronous catalog reads behind full-document access", async () => {
    const session = new RuntimeSession({ sessionId: "variables-dynamic", projection, transport: new ReadOnlyTransport(), documentAccess: "dynamic-page", scheduleMicrotask: () => {} });
    expect(isRuntimeError(capture(() => session.variables.getLocalVariables()), "PAGE_NOT_LOADED")).toBe(true);
    expect((await session.variables.getLocalVariablesAsync()).map((value) => value.id)).toEqual(["V:spacing", "V:spacing-alias", "V:surface", "V:opacity", "V:visible", "V:width", "V:height", "V:label"]);
  });

  it("creates local collections and typed variables through one canonical transaction", async () => {
    const transport = new UpdatingTransport(projection);
    const session = new RuntimeSession({ sessionId: "variable-create", projection, transport, scheduleMicrotask: () => {} });
    const collection = session.variables.createVariableCollection("Tokens");
    const spacing = session.variables.createVariable("Spacing", collection, "FLOAT");
    const surface = session.variables.createVariable("Surface", collection.id, "COLOR");

    expect(collection).toMatchObject({ name: "Tokens", remote: false, modes: [{ name: "Mode 1" }] });
    expect(spacing).toMatchObject({ name: "Spacing", resolvedType: "FLOAT", variableCollectionId: collection.id });
    expect(spacing.valuesByMode[collection.defaultModeId]).toBe(0);
    expect(surface.valuesByMode[collection.defaultModeId]).toEqual({ r: 0, g: 0, b: 0 });
    expect(session.variables.getLocalVariableCollections().at(-1)?.id).toBe(collection.id);
    expect(session.variables.getLocalVariables().slice(-2).map((value) => value.id)).toEqual([spacing.id, surface.id]);

    await session.commitAsync();
    expect(transport.submitted).toHaveLength(1);
    expect(transport.submitted[0]?.operations.map((operation) => operation.type)).toEqual([
      "registerVariableCollection",
      "registerVariable",
      "registerVariable",
    ]);
    expect((await session.variables.getVariableByIdAsync(spacing.id))?.name).toBe("Spacing");
  });

  it("binds scalar variables to node values and unlinks on direct writes", async () => {
    const writable: RuntimeProjection = { ...projection, nodes: [...projection.nodes, { id: "frame", type: "FRAME", name: "Container", parentId: "page", siblingIndex: 0, autoLayout: { mode: "horizontal", padding: [0, 0, 0, 0], itemSpacing: 0, wrap: true, primaryAlignment: "start", counterAlignment: "start", primarySizing: "fixed", counterSizing: "fixed", absolute: false } }, { id: "rect", type: "RECTANGLE", name: "Card", parentId: "frame", siblingIndex: 0, width: 100, height: 100, opacity: 1, visible: true, strokeWidth: 1 }, { id: "text", type: "TEXT", name: "Label", parentId: "frame", siblingIndex: 1, characters: "Initial", width: 100, height: 20 }] };
    const transport = new UpdatingTransport(writable);
    const session = new RuntimeSession({ sessionId: "variable-bindings", projection: writable, transport, scheduleMicrotask: () => {} });
    const rectangle = (await session.getNodeByIdAsync("rect"))!;
    const frame = (await session.getNodeByIdAsync("frame"))!;
    const text = (await session.getNodeByIdAsync("text"))!;
    const collection = (await session.variables.getVariableCollectionByIdAsync("VC:theme"))!;
    const opacity = (await session.variables.getVariableByIdAsync("V:opacity"))!;
    const visible = (await session.variables.getVariableByIdAsync("V:visible"))!;
    const surface = (await session.variables.getVariableByIdAsync("V:surface"))!;
    const spacing = (await session.variables.getVariableByIdAsync("V:spacing"))!;
    const width = (await session.variables.getVariableByIdAsync("V:width"))!;
    const height = (await session.variables.getVariableByIdAsync("V:height"))!;
    const label = (await session.variables.getVariableByIdAsync("V:label"))!;
    const boundPaint = session.variables.setBoundVariableForPaint({ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: .5 }, "color", surface);
    const surfaceAlias = session.variables.createVariableAlias(surface);
    const boundGradient = {
      type: "GRADIENT_LINEAR" as const,
      gradientTransform: [[1, 0, 0], [0, 1, 0]] as const,
      gradientStops: [
        { position: 0, color: { r: 1, g: 1, b: 1, a: 1 }, boundVariables: { color: surfaceAlias } },
        { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
      ],
    };
    expect(boundPaint.boundVariables).toEqual({ color: { type: "VARIABLE_ALIAS", id: "V:surface" } });
    expect(session.variables.setBoundVariableForPaint(boundPaint, "color", null).boundVariables).toBeUndefined();
    expect(isRuntimeError(capture(() => session.variables.setBoundVariableForPaint(boundPaint, "color", spacing)), "INVALID_ARGUMENT")).toBe(true);
    let boundShadow = session.variables.setBoundVariableForEffect({ type: "DROP_SHADOW", color: { r: 1, g: 1, b: 1, a: 1 }, offset: { x: 0, y: 0 }, radius: 1, spread: 0, visible: true, blendMode: "NORMAL" }, "color", surface);
    boundShadow = session.variables.setBoundVariableForEffect(boundShadow, "radius", spacing);
    boundShadow = session.variables.setBoundVariableForEffect(boundShadow, "spread", spacing);
    boundShadow = session.variables.setBoundVariableForEffect(boundShadow, "offsetX", spacing);
    boundShadow = session.variables.setBoundVariableForEffect(boundShadow, "offsetY", spacing);
    const boundBlur = session.variables.setBoundVariableForEffect({ type: "LAYER_BLUR", radius: 1, visible: true, blurType: "NORMAL" }, "radius", spacing);
    expect(isRuntimeError(capture(() => session.variables.setBoundVariableForEffect(boundBlur, "color", surface)), "INVALID_ARGUMENT")).toBe(true);

    rectangle.setBoundVariable("opacity", opacity);
    rectangle.setBoundVariable("visible", visible);
    rectangle.setBoundVariable("strokeWeight", spacing);
    rectangle.setBoundVariable("width", width);
    rectangle.setBoundVariable("height", height);
    rectangle.setBoundVariable("cornerRadius", spacing);
    rectangle.fills = [boundPaint, boundGradient];
    rectangle.strokes = [boundPaint];
    rectangle.effects = [boundShadow, boundBlur];
    text.setBoundVariable("characters", label);
    frame.setBoundVariable("itemSpacing", spacing);
    frame.setBoundVariable("paddingTop", spacing);
    frame.setBoundVariable("paddingRight", spacing);
    frame.setBoundVariable("paddingBottom", spacing);
    frame.setBoundVariable("paddingLeft", spacing);
    frame.setBoundVariable("counterAxisSpacing", spacing);
    frame.setBoundVariable("strokeTopWeight", spacing);
    frame.setBoundVariable("strokeRightWeight", spacing);
    frame.setBoundVariable("strokeBottomWeight", spacing);
    frame.setBoundVariable("strokeLeftWeight", spacing);
    rectangle.setBoundVariable("minWidth", width);
    rectangle.setBoundVariable("maxWidth", width);
    rectangle.setBoundVariable("minHeight", spacing);
    rectangle.setBoundVariable("maxHeight", height);
    expect(rectangle.opacity).toBe(.5);
    expect(rectangle.visible).toBe(false);
    expect(rectangle.strokeWeight).toBe(8);
    expect(rectangle.width).toBe(120);
    expect(rectangle.height).toBe(60);
    expect(rectangle.cornerRadius).toBe(8);
    expect(rectangle.boundVariables).not.toHaveProperty("cornerRadius");
    expect(rectangle.boundVariables).toMatchObject({ fills: [{ type: "VARIABLE_ALIAS", id: "V:surface" }, { type: "VARIABLE_ALIAS", id: "V:surface" }], strokes: [{ type: "VARIABLE_ALIAS", id: "V:surface" }] });
    expect(rectangle.fills).toMatchObject([
      { type: "SOLID", opacity: .5, boundVariables: { color: { type: "VARIABLE_ALIAS", id: "V:surface" } } },
      { type: "GRADIENT_LINEAR", gradientStops: [{ boundVariables: { color: { type: "VARIABLE_ALIAS", id: "V:surface" } } }, { position: 1 }] },
    ]);
    expect(rectangle.strokes).toMatchObject([{ type: "SOLID", opacity: .5, boundVariables: { color: { type: "VARIABLE_ALIAS", id: "V:surface" } } }]);
    expect(rectangle.effects).toMatchObject([
      { type: "DROP_SHADOW", radius: 8, spread: 8, offset: { x: 8, y: 8 }, boundVariables: { color: { id: "V:surface" }, radius: { id: "V:spacing" }, spread: { id: "V:spacing" }, offsetX: { id: "V:spacing" }, offsetY: { id: "V:spacing" } } },
      { type: "LAYER_BLUR", radius: 8, boundVariables: { radius: { id: "V:spacing" } } },
    ]);
    expect(rectangle.boundVariables).toMatchObject({ effects: expect.arrayContaining([{ type: "VARIABLE_ALIAS", id: "V:surface" }, { type: "VARIABLE_ALIAS", id: "V:spacing" }]) });
    expect(rectangle.boundVariables).toMatchObject({ topLeftRadius: { type: "VARIABLE_ALIAS", id: "V:spacing" }, topRightRadius: { type: "VARIABLE_ALIAS", id: "V:spacing" }, bottomRightRadius: { type: "VARIABLE_ALIAS", id: "V:spacing" }, bottomLeftRadius: { type: "VARIABLE_ALIAS", id: "V:spacing" } });
    expect(text.characters).toBe("Light");
    expect(frame).toMatchObject({ itemSpacing: 8, paddingTop: 8, paddingRight: 8, paddingBottom: 8, paddingLeft: 8, counterAxisSpacing: 8 });
    expect(frame).toMatchObject({ strokeTopWeight: 8, strokeRightWeight: 8, strokeBottomWeight: 8, strokeLeftWeight: 8 });
    expect(rectangle).toMatchObject({ minWidth: 120, maxWidth: 120, minHeight: 8, maxHeight: 60 });
    expect(rectangle.boundVariables).toMatchObject({ height: { type: "VARIABLE_ALIAS", id: "V:height" }, minWidth: { type: "VARIABLE_ALIAS", id: "V:width" }, maxWidth: { type: "VARIABLE_ALIAS", id: "V:width" }, opacity: { type: "VARIABLE_ALIAS", id: "V:opacity" }, strokeWeight: { type: "VARIABLE_ALIAS", id: "V:spacing" }, visible: { type: "VARIABLE_ALIAS", id: "V:visible" }, width: { type: "VARIABLE_ALIAS", id: "V:width" } });
    rectangle.setBoundVariable("strokeTopWeight", spacing);
    expect(rectangle.boundVariables).not.toHaveProperty("strokeWeight");
    rectangle.setBoundVariable("strokeWeight", spacing);
    expect(rectangle.boundVariables).not.toHaveProperty("strokeTopWeight");
    expect(isRuntimeError(capture(() => rectangle.setBoundVariable("opacity", visible)), "INVALID_ARGUMENT")).toBe(true);

    frame.setExplicitVariableModeForCollection(collection, "dark");
    expect(frame.explicitVariableModes).toEqual({ "VC:theme": "dark" });
    expect(rectangle.resolvedVariableModes).toEqual({ "VC:theme": "dark" });
    expect(rectangle.opacity).toBe(.8);
    expect(rectangle.visible).toBe(true);
    expect(rectangle.strokeWeight).toBe(12);
    expect(rectangle.width).toBe(180);
    expect(rectangle.height).toBe(90);
    expect(rectangle.cornerRadius).toBe(12);
    expect(rectangle.fills).toMatchObject([
      { type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: .5, boundVariables: { color: { type: "VARIABLE_ALIAS", id: "V:surface" } } },
      { type: "GRADIENT_LINEAR", gradientStops: [{ color: { r: 0, g: 0, b: 0, a: 1 }, boundVariables: { color: { id: "V:surface" } } }, { position: 1 }] },
    ]);
    expect(rectangle.strokes).toMatchObject([{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: .5, boundVariables: { color: { type: "VARIABLE_ALIAS", id: "V:surface" } } }]);
    expect(rectangle.effects).toMatchObject([
      { type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 1 }, radius: 12, spread: 12, offset: { x: 12, y: 12 } },
      { type: "LAYER_BLUR", radius: 12 },
    ]);
    expect(text.characters).toBe("Dark");
    expect(frame).toMatchObject({ itemSpacing: 12, paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12, counterAxisSpacing: 12 });
    expect(frame).toMatchObject({ strokeTopWeight: 12, strokeRightWeight: 12, strokeBottomWeight: 12, strokeLeftWeight: 12 });
    expect(rectangle).toMatchObject({ minWidth: 180, maxWidth: 180, minHeight: 12, maxHeight: 90 });
    expect(opacity.resolveForConsumer(rectangle)).toEqual({ value: .8, resolvedType: "FLOAT" });
    await session.commitAsync();
    expect(rectangle.boundVariables).toMatchObject({ fills: [{ type: "VARIABLE_ALIAS", id: "V:surface" }, { type: "VARIABLE_ALIAS", id: "V:surface" }], strokes: [{ type: "VARIABLE_ALIAS", id: "V:surface" }] });
    expect(rectangle.effects[0]).toMatchObject({ boundVariables: { color: { id: "V:surface" }, radius: { id: "V:spacing" } } });

    rectangle.setExplicitVariableModeForCollection(collection, "light");
    expect(rectangle.opacity).toBe(.5);
    expect(rectangle.visible).toBe(false);
    rectangle.clearExplicitVariableModeForCollection(collection);
    expect(rectangle.opacity).toBe(.8);
    expect(rectangle.resolvedVariableModes).toEqual({ "VC:theme": "dark" });

    rectangle.resize(300, 200);
    text.characters = "Manual";
    expect(rectangle.boundVariables).not.toHaveProperty("width");
    expect(rectangle.boundVariables).not.toHaveProperty("height");
    expect(text.boundVariables).toBeUndefined();

    rectangle.topLeftRadius = 5;
    expect(rectangle.cornerRadius).toBe(RUNTIME_MIXED);
    expect(rectangle.boundVariables).not.toHaveProperty("topLeftRadius");
    expect(rectangle.boundVariables).toHaveProperty("topRightRadius");
    rectangle.cornerRadius = 6;
    expect(rectangle.cornerRadius).toBe(6);
    expect(rectangle.boundVariables).not.toHaveProperty("topRightRadius");
    expect(rectangle.boundVariables).not.toHaveProperty("bottomRightRadius");
    expect(rectangle.boundVariables).not.toHaveProperty("bottomLeftRadius");

    rectangle.fills = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }];
    rectangle.strokes = [{ type: "SOLID", color: { r: 0, g: 0, b: 1 } }];
    expect(rectangle.boundVariables).not.toHaveProperty("fills");
    expect(rectangle.boundVariables).not.toHaveProperty("strokes");
    rectangle.effects = [{ type: "LAYER_BLUR", radius: 4, visible: true, blurType: "NORMAL" }];
    expect(rectangle.boundVariables).not.toHaveProperty("effects");

    frame.itemSpacing = 4;
    frame.paddingTop = 1;
    frame.paddingRight = 2;
    frame.paddingBottom = 3;
    frame.paddingLeft = 4;
    frame.counterAxisSpacing = 6;
    frame.strokeTopWeight = 1;
    frame.strokeRightWeight = 2;
    frame.strokeBottomWeight = 3;
    frame.strokeLeftWeight = 4;
    rectangle.minWidth = 50;
    rectangle.maxWidth = 200;
    rectangle.minHeight = 10;
    rectangle.maxHeight = 100;
    expect(frame.boundVariables).toBeUndefined();
    expect(rectangle.boundVariables).not.toHaveProperty("minWidth");
    expect(rectangle.boundVariables).not.toHaveProperty("maxWidth");
    expect(rectangle.boundVariables).not.toHaveProperty("minHeight");
    expect(rectangle.boundVariables).not.toHaveProperty("maxHeight");

    rectangle.opacity = .7;
    expect(rectangle.opacity).toBe(.7);
    expect(rectangle.boundVariables).toEqual({ strokeWeight: { type: "VARIABLE_ALIAS", id: "V:spacing" }, visible: { type: "VARIABLE_ALIAS", id: "V:visible" } });
    await session.commitAsync();
    expect(transport.submitted).toHaveLength(2);
  });
});

class ReadOnlyTransport implements RuntimeTransactionTransport {
  submit(_transaction: PendingProjectionTransaction): Promise<RuntimeTransactionResult> {
    void _transaction;
    return Promise.reject(new Error("read-only"));
  }
}

class UpdatingTransport implements RuntimeTransactionTransport {
  submitted: PendingProjectionTransaction[] = [];
  constructor(private projection: RuntimeProjection) {}
  async submit(transaction: PendingProjectionTransaction): Promise<RuntimeTransactionResult> {
    this.submitted.push(transaction);
    const nodes = new Map(this.projection.nodes.map((node) => [node.id, structuredClone(node)]));
    for (const operation of transaction.operations) {
      if (operation.type === "update") {
        const node = nodes.get(operation.nodeId);
        if (node) nodes.set(operation.nodeId, { ...node, ...structuredClone(operation.patch) });
      }
    }
    const variableCollections = [...(this.projection.variableCollections ?? [])];
    const variables = [...(this.projection.variables ?? [])];
    for (const operation of transaction.operations) {
      if (operation.type === "registerVariableCollection") variableCollections.push(structuredClone(operation.collection));
      if (operation.type === "registerVariable") variables.push(structuredClone(operation.variable));
    }
    this.projection = { ...this.projection, revision: this.projection.revision + 1, nodes: [...nodes.values()], variableCollections, variables };
    return { type: "accepted", acceptedRevision: this.projection.revision, projection: this.projection };
  }
}

function capture(callback: () => unknown): unknown {
  try { callback(); return undefined; } catch (error) { return error; }
}
