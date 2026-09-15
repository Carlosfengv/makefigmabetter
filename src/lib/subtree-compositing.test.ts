import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { extensionsForNodeBlendMode } from "./node-blend-semantics";
import { activeMaskAlphaEffects, activeNodeEffects, nodePresentationRequiresBackdrop, requiresSubtreeComposition, subtreeSourceNode } from "./subtree-compositing";

describe("subtree compositing", () => {
  it("isolates descendant layers for owner opacity, blend and visible effects", () => {
    const group = { ...createNode("group", 0, 0), opacity: .5 };
    expect(requiresSubtreeComposition(group, true)).toBe(true);
    expect(requiresSubtreeComposition(group, false)).toBe(false);
    expect(requiresSubtreeComposition({ ...group, opacity: 1, blendMode: "multiply" }, true)).toBe(true);
    expect(requiresSubtreeComposition({ ...group, opacity: 1, blendMode: "pass-through" }, true)).toBe(false);
    expect(requiresSubtreeComposition({ ...group, opacity: 1, extensions: extensionsForNodeBlendMode(undefined, "normal") }, true)).toBe(true);
    expect(requiresSubtreeComposition({ ...group, opacity: 1, extensions: extensionsForNodeBlendMode(undefined, "normal") }, false)).toBe(false);
    expect(requiresSubtreeComposition({ ...group, blendMode: "pass-through" }, true)).toBe(true);
    expect(requiresSubtreeComposition({ ...group, opacity: 1, blendMode: "linear-dodge" }, false)).toBe(true);
    expect(requiresSubtreeComposition({ ...group, opacity: 1, blendMode: "linear-burn" }, true)).toBe(true);
    expect(requiresSubtreeComposition({ ...group, opacity: 1, dropShadow: { visible: true, offsetX: 1, offsetY: 2, blurRadius: 3, spread: 0, color: { space: "srgb", components: [0, 0, 0], alpha: .5 } } }, true)).toBe(true);
  });

  it("removes owner presentation fields from source paint without mutating canonical state", () => {
    const group = { ...createNode("group", 0, 0), opacity: .5, blendMode: "screen" as const, effectStack: [{ layerBlur: { visible: true, radius: 4 } }] };
    const source = subtreeSourceNode(group);
    expect(source).toMatchObject({ opacity: 1, blendMode: "normal" });
    expect(source.effectStack).toBeUndefined();
    expect(group).toMatchObject({ opacity: .5, blendMode: "screen" });
    expect(activeNodeEffects(group)).toHaveLength(1);
  });

  it("classifies node, paint-layer and Background Blur backdrop reads", () => {
    const node = createNode("rectangle", 0, 0);
    expect(nodePresentationRequiresBackdrop(node)).toBe(false);
    expect(nodePresentationRequiresBackdrop({ ...node, blendMode: "screen" })).toBe(true);
    expect(nodePresentationRequiresBackdrop({
      ...node,
      fillStack: { layers: [{ paint: { css: "#123456" }, visible: true, opacity: 1, blendMode: "linear-burn" }] },
    })).toBe(true);
    expect(nodePresentationRequiresBackdrop({
      ...node,
      effectStack: [{ backgroundBlur: { visible: true, radius: 4 } }],
    })).toBe(true);
    expect(nodePresentationRequiresBackdrop({
      ...node,
      effectStack: [{ backgroundBlur: { visible: false, radius: 4 } }],
    })).toBe(false);
    const mask = {
      ...node,
      isMask: true,
      blendMode: "multiply" as const,
      effectStack: [
        { backgroundBlur: { visible: true, radius: 4 } },
        { layerBlur: { visible: true, radius: 2 } },
      ],
    };
    expect(nodePresentationRequiresBackdrop(mask)).toBe(false);
    expect(activeMaskAlphaEffects(mask)).toEqual([
      { layerBlur: { visible: true, radius: 2 } },
    ]);
    const backgroundBlurGroup = {
      ...createNode("group", 0, 0),
      effectStack: [{ backgroundBlur: { visible: true, radius: 4 } }],
    };
    expect(requiresSubtreeComposition(backgroundBlurGroup, true)).toBe(true);
    expect(requiresSubtreeComposition(
      backgroundBlurGroup,
      true,
      activeMaskAlphaEffects(backgroundBlurGroup),
    )).toBe(false);
  });
});
