import { describe, expect, it } from "vitest";
import { FigmaCompatibleRuntime } from "./figma-compatible-runtime";
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
    expect((await figma.variables.getLocalVariablesAsync("FLOAT")).map((value) => value.id)).toEqual(["V:spacing", "V:spacing-alias", "V:opacity"]);
    const collection = await figma.variables.getVariableCollectionByIdAsync("VC:theme");
    expect(collection).toMatchObject({ name: "Theme", defaultModeId: "light", variableIds: ["V:spacing", "V:spacing-alias", "V:surface", "V:opacity", "V:visible"] });

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
    expect((await session.variables.getLocalVariablesAsync()).map((value) => value.id)).toEqual(["V:spacing", "V:spacing-alias", "V:surface", "V:opacity", "V:visible"]);
  });

  it("binds scalar variables to node values and unlinks on direct writes", async () => {
    const writable: RuntimeProjection = { ...projection, nodes: [...projection.nodes, { id: "rect", type: "RECTANGLE", name: "Card", parentId: "page", siblingIndex: 0, opacity: 1, visible: true, strokeWidth: 1 }] };
    const transport = new UpdatingTransport(writable);
    const session = new RuntimeSession({ sessionId: "variable-bindings", projection: writable, transport, scheduleMicrotask: () => {} });
    const rectangle = (await session.getNodeByIdAsync("rect"))!;
    const opacity = (await session.variables.getVariableByIdAsync("V:opacity"))!;
    const visible = (await session.variables.getVariableByIdAsync("V:visible"))!;
    const spacing = (await session.variables.getVariableByIdAsync("V:spacing"))!;

    rectangle.setBoundVariable("opacity", opacity);
    rectangle.setBoundVariable("visible", visible);
    rectangle.setBoundVariable("strokeWeight", spacing);
    expect(rectangle.opacity).toBe(.5);
    expect(rectangle.visible).toBe(false);
    expect(rectangle.strokeWeight).toBe(8);
    expect(rectangle.boundVariables).toEqual({ opacity: { type: "VARIABLE_ALIAS", id: "V:opacity" }, strokeWeight: { type: "VARIABLE_ALIAS", id: "V:spacing" }, visible: { type: "VARIABLE_ALIAS", id: "V:visible" } });
    expect(isRuntimeError(capture(() => rectangle.setBoundVariable("opacity", visible)), "INVALID_ARGUMENT")).toBe(true);

    rectangle.opacity = .7;
    expect(rectangle.opacity).toBe(.7);
    expect(rectangle.boundVariables).toEqual({ strokeWeight: { type: "VARIABLE_ALIAS", id: "V:spacing" }, visible: { type: "VARIABLE_ALIAS", id: "V:visible" } });
    await session.commitAsync();
    expect(transport.submitted).toHaveLength(1);
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
      if (operation.type !== "update") continue;
      const node = nodes.get(operation.nodeId);
      if (node) nodes.set(operation.nodeId, { ...node, ...structuredClone(operation.patch) });
    }
    this.projection = { ...this.projection, revision: this.projection.revision + 1, nodes: [...nodes.values()] };
    return { type: "accepted", acceptedRevision: this.projection.revision, projection: this.projection };
  }
}

function capture(callback: () => unknown): unknown {
  try { callback(); return undefined; } catch (error) { return error; }
}
