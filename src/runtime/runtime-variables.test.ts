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
    expect((await figma.variables.getLocalVariablesAsync("FLOAT")).map((value) => value.id)).toEqual(["V:spacing", "V:spacing-alias"]);
    const collection = await figma.variables.getVariableCollectionByIdAsync("VC:theme");
    expect(collection).toMatchObject({ name: "Theme", defaultModeId: "light", variableIds: ["V:spacing", "V:spacing-alias", "V:surface"] });

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
    expect((await session.variables.getLocalVariablesAsync()).map((value) => value.id)).toEqual(["V:spacing", "V:spacing-alias", "V:surface"]);
  });
});

class ReadOnlyTransport implements RuntimeTransactionTransport {
  submit(_transaction: PendingProjectionTransaction): Promise<RuntimeTransactionResult> {
    void _transaction;
    return Promise.reject(new Error("read-only"));
  }
}

function capture(callback: () => unknown): unknown {
  try { callback(); return undefined; } catch (error) { return error; }
}
