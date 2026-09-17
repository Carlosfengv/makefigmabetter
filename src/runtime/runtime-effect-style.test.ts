import { describe, expect, it } from "vitest";
import type { DocumentEffectStyleResource } from "../lib/editor-protocol";
import { FigmaCompatibleRuntime } from "./figma-compatible-runtime";
import { RuntimeEffectStyle, type RuntimeEffectStyleHost } from "./runtime-effect-style";
import { isRuntimeError } from "./runtime-errors";
import type { PendingProjectionTransaction, RuntimeProjection } from "./runtime-projection-store";
import { RuntimeSession } from "./runtime-session";
import type { RuntimeTransactionResult, RuntimeTransactionTransport } from "./runtime-transaction-client";

describe("RuntimeEffectStyle", () => {
  it("creates, persists, queries, updates and removes a canonical EffectStyle", async () => {
    const projection: RuntimeProjection = {
      revision: 2,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document" },
        { id: "page", type: "PAGE", name: "Page", parentId: "document", siblingIndex: 0 },
      ],
    };
    const transport = new EffectStyleTransport(projection);
    const session = new RuntimeSession({
      sessionId: "effect-style-lifecycle",
      projection,
      transport,
      createId: () => "00000000-0000-4000-8000-000000000103",
      scheduleMicrotask: () => {},
    });
    const figma = new FigmaCompatibleRuntime(session);

    const style = figma.createEffectStyle();
    style.name = "Elevation/Card";
    style.effects = [{
      type: "DROP_SHADOW",
      color: { r: 0, g: 0, b: 0, a: 0.2 },
      offset: { x: 0, y: 4 },
      radius: 8,
      spread: 0,
      visible: true,
      blendMode: "NORMAL",
    }];
    expect(figma.getLocalEffectStyles().map((candidate) => candidate.id)).toEqual([style.id]);
    expect((await figma.getStyleByIdAsync(style.id))?.type).toBe("EFFECT");
    await session.commitAsync();

    const reopened = new RuntimeSession({
      sessionId: "effect-style-reopened",
      projection: transport.currentProjection(),
      transport,
      scheduleMicrotask: () => {},
    });
    const persisted = await reopened.getStyleByIdAsync(style.id);
    expect(persisted).toMatchObject({ id: style.id, type: "EFFECT", name: "Elevation/Card" });
    if (!persisted || persisted.type !== "EFFECT") throw new Error("Missing EffectStyle fixture");
    expect(persisted.effects).toHaveLength(1);
    persisted.remove();
    await reopened.commitAsync();
    expect((await reopened.getLocalEffectStylesAsync()).map((candidate) => candidate.id)).toEqual([]);
  });

  it("projects supported effects and writes metadata through the live canonical host", () => {
    const resources = new Map<string, DocumentEffectStyleResource>();
    const initial: DocumentEffectStyleResource = {
      id: "S:soft-shadow",
      key: "",
      name: "Soft shadow",
      description: "",
      descriptionMarkdown: "",
      documentationLinks: [],
      remote: false,
      effects: [],
    };
    resources.set(initial.id, initial);
    const host: RuntimeEffectStyleHost = {
      effectStyleResource: (id) => resources.get(id),
      setEffectStyle: (style) => { resources.set(style.id, structuredClone(style)); },
      deleteEffectStyle: (id) => { resources.delete(id); },
      getPluginData: () => "",
      setPluginData: () => undefined,
      getPluginDataKeys: () => [],
      getSharedPluginData: () => "",
      setSharedPluginData: () => undefined,
      getSharedPluginDataKeys: () => [],
    };
    const style = new RuntimeEffectStyle(initial, host);
    style.effects = [
      { type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 8, spread: 0, visible: true, blendMode: "NORMAL" },
      { type: "LAYER_BLUR", radius: 6, visible: false, blurType: "NORMAL" },
    ];
    style.descriptionMarkdown = "**Elevation**";
    expect(style.effects).toEqual([
      { type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 8, spread: 0, visible: true, blendMode: "NORMAL" },
      { type: "LAYER_BLUR", radius: 6, visible: false, blurType: "NORMAL" },
    ]);
    expect(resources.get(initial.id)?.descriptionMarkdown).toBe("**Elevation**");
    expect(style.boundVariables).toBeUndefined();
    expect(style.consumers).toEqual([]);
  });

  it("fails closed for unsupported progressive effects and removed resources", () => {
    let resource: DocumentEffectStyleResource | undefined = {
      id: "S:effects",
      key: "",
      name: "Effects",
      description: "",
      descriptionMarkdown: "",
      documentationLinks: [],
      remote: false,
      effects: [],
    };
    const host = {
      effectStyleResource: () => resource,
      setEffectStyle: (next: DocumentEffectStyleResource) => { resource = next; },
      deleteEffectStyle: () => { resource = undefined; },
      getPluginData: () => "",
      setPluginData: () => undefined,
      getPluginDataKeys: () => [],
      getSharedPluginData: () => "",
      setSharedPluginData: () => undefined,
      getSharedPluginDataKeys: () => [],
    } satisfies RuntimeEffectStyleHost;
    const style = new RuntimeEffectStyle(resource, host);
    expect(isRuntimeError(capture(() => {
      style.effects = [{ type: "LAYER_BLUR", blurType: "PROGRESSIVE", radius: 8, startRadius: 0, startOffset: { x: 0, y: 0 }, endOffset: { x: 1, y: 1 }, visible: true } as never];
    }), "INVALID_ARGUMENT")).toBe(true);
    style.remove();
    expect(isRuntimeError(capture(() => style.effects), "RESOURCE_UNAVAILABLE")).toBe(true);
  });
});

class EffectStyleTransport implements RuntimeTransactionTransport {
  private projection: RuntimeProjection;

  constructor(projection: RuntimeProjection) {
    this.projection = structuredClone(projection);
  }

  currentProjection(): RuntimeProjection { return structuredClone(this.projection); }

  async submit(transaction: PendingProjectionTransaction): Promise<RuntimeTransactionResult> {
    const effectStyles = new Map((this.projection.effectStyles ?? []).map((style) => [style.id, structuredClone(style)]));
    for (const operation of transaction.operations) {
      if (operation.type === "registerEffectStyle" || operation.type === "setEffectStyle") {
        effectStyles.set(operation.style.id, structuredClone(operation.style));
      } else if (operation.type === "deleteEffectStyle") {
        effectStyles.delete(operation.id);
      }
    }
    this.projection = {
      ...this.projection,
      revision: this.projection.revision + 1,
      effectStyles: [...effectStyles.values()],
    };
    return { type: "accepted", acceptedRevision: this.projection.revision, projection: this.currentProjection() };
  }
}

function capture(callback: () => unknown): unknown {
  try { return callback(); } catch (error) { return error; }
}
