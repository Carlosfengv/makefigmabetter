import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { coreProjectionNode } from "./transaction-batch";
import { canvasNodeFromWasmProjection } from "./wasm-projection-node";

describe("canvasNodeFromWasmProjection", () => {
  it("keeps Canonical Blend Mode and alpha Mask state after the post-commit projection refresh", () => {
    const fillStack = { layers: [{
      paint: { css: "#ff0000", color: { space: "srgb" as const, components: [1, 0, 0] as [number, number, number], alpha: 1 } },
      visible: true,
      opacity: 0.75,
      blendMode: "screen" as const,
    }] };
    const strokeStack = { layers: [{
      paint: { css: "#0000ff", color: { space: "srgb" as const, components: [0, 0, 1] as [number, number, number], alpha: 1 } },
      visible: true,
      opacity: 0.5,
      blendMode: "multiply" as const,
    }] };
    const coreNode = coreProjectionNode({ ...createNode("rectangle", 10, 20), blendMode: "multiply", isMask: true, fillStack, strokeStack });

    expect(canvasNodeFromWasmProjection(coreNode)).toMatchObject({ blendMode: "multiply", isMask: true, fillStack, strokeStack });
    expect(canvasNodeFromWasmProjection({ ...coreNode, fillStack: null, strokeStack: null } as unknown as typeof coreNode)).toMatchObject({
      fillStack: undefined,
      strokeStack: undefined,
    });
    expect(canvasNodeFromWasmProjection({ ...coreNode, parentId: null } as unknown as typeof coreNode).parentId).toBeUndefined();
  });

  it("normalizes nullable Core text-run paint stacks and TextCase before Canvas consumes them", () => {
    const coreNode = coreProjectionNode({
      ...createNode("text", 0, 0),
      text: "Design",
      textProperties: {
        runs: [{
          start: 0,
          end: 6,
          fontSize: 48,
          fontWeight: 400,
          italic: false,
          letterSpacing: 0,
        }],
        paragraph: { alignment: "center", lineHeight: 60, paragraphSpacing: 0 },
        autoSize: "fixed",
        fallbackFonts: [],
        baseStyle: { fontSize: 48, fontWeight: 400, italic: false, letterSpacing: 0 },
      },
    });
    const nullable = {
      ...coreNode,
      textProperties: {
        ...coreNode.textProperties!,
        runs: coreNode.textProperties!.runs.map((run) => ({ ...run, fillStack: null, textCase: null })),
        baseStyle: { ...coreNode.textProperties!.baseStyle!, fillStack: null, textCase: null },
      },
    } as unknown as typeof coreNode;
    const normalized = canvasNodeFromWasmProjection(nullable).textProperties;
    expect(normalized?.runs[0]?.fillStack).toBeUndefined();
    expect(normalized?.runs[0]?.textCase).toBeUndefined();
    expect(normalized?.baseStyle?.fillStack).toBeUndefined();
    expect(normalized?.baseStyle?.textCase).toBeUndefined();
  });

  it("hydrates ComponentSet property definitions and defaults old metadata to an empty definition map", () => {
    const current = coreProjectionNode({
      ...createNode("componentSet", 0, 0),
      componentSetMetadata: {
        key: "button-set",
        remote: false,
        description: "Buttons",
        descriptionMarkdown: "",
        documentationLinks: [],
        componentPropertyDefinitions: { State: { type: "VARIANT", defaultValue: "Default", variantOptions: ["Default", "Hover"] } },
        variantGroupProperties: { State: { values: ["Default", "Hover"] } },
      },
    });
    expect(canvasNodeFromWasmProjection(current).componentSetMetadata?.componentPropertyDefinitions).toEqual({
      State: { type: "VARIANT", defaultValue: "Default", variantOptions: ["Default", "Hover"] },
    });

    const legacyMetadata = {
      key: "legacy-set",
      remote: false,
      description: "Legacy",
      descriptionMarkdown: "",
      documentationLinks: [],
      variantGroupProperties: { State: { values: ["Default"] } },
    };
    const legacy = {
      ...current,
      extensions: {
        ...current.extensions,
        "figma.component-set.metadata.v1": [...new TextEncoder().encode(JSON.stringify(legacyMetadata))],
      },
    };
    expect(canvasNodeFromWasmProjection(legacy).componentSetMetadata).toMatchObject({
      key: "legacy-set",
      componentPropertyDefinitions: {},
      variantGroupProperties: { State: { values: ["Default"] } },
    });
  });

  it("defaults legacy Embed metadata description to null", () => {
    const current = coreProjectionNode(createNode("embed", 0, 0));
    const legacy = {
      ...current,
      extensions: {
        ...current.extensions,
        "figma.embed.metadata.v1": [...new TextEncoder().encode(JSON.stringify({
          srcUrl: "https://player.example/embed/1",
          canonicalUrl: "https://example.com/watch/1",
          title: "Demo",
          provider: "Example",
        }))],
      },
    };
    expect(canvasNodeFromWasmProjection(legacy).embedMetadata).toEqual({
      srcUrl: "https://player.example/embed/1",
      canonicalUrl: "https://example.com/watch/1",
      title: "Demo",
      description: null,
      provider: "Example",
    });
  });

  it("round-trips component property references through the extension-backed Core projection", () => {
    const source = { ...createNode("text", 0, 0), componentPropertyReferences: { visible: "Enabled", characters: "Label" } };
    const core = coreProjectionNode(source);
    expect(canvasNodeFromWasmProjection(core).componentPropertyReferences).toEqual({ visible: "Enabled", characters: "Label" });

    const cleared = coreProjectionNode({ ...source, componentPropertyReferences: undefined, extensions: core.extensions });
    expect(cleared.extensions?.["figma.component-property-references.v1"]).toBeUndefined();
    expect(canvasNodeFromWasmProjection(cleared).componentPropertyReferences).toBeUndefined();

    const slot = { ...createNode("slot", 0, 0), componentPropertyReferences: { slotContentId: "Content" }, slotMetadata: { propertyName: "Content" } };
    expect(canvasNodeFromWasmProjection(coreProjectionNode(slot)).componentPropertyReferences).toEqual({ slotContentId: "Content" });
  });
});
