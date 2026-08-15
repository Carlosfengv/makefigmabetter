import { describe, expect, it } from "vitest";
import { gpuLayerPrefix, isGpuInnerShadowEffectNode, isGpuLayerBlurEffectNode, requiresCanvasEffectOrBlend } from "./gpu-layer-prefix";
import type { CanvasNode } from "./editor-protocol";

const node = (id: string, kind: CanvasNode["kind"], assetId?: string): CanvasNode => ({ id, kind, assetId, name: id, x: 0, y: 0, width: 10, height: 10, rotation: 0, fill: "#ffffff", stroke: "transparent", strokeWidth: 0, radius: 0, opacity: 1 });

describe("GPU layer prefix", () => {
  it("leaves a newer shape in Canvas when it follows an image", () => {
    const nodes = [node("frame", "frame"), node("image", "image", "asset"), node("newer-rectangle", "rectangle")];
    expect(gpuLayerPrefix(nodes, new Set(["asset"])).map((entry) => entry.id)).toEqual(["frame", "image"]);
  });

  it("stops before an undecoded image placeholder", () => {
    const nodes = [node("frame", "frame"), node("image", "image", "asset")];
    expect(gpuLayerPrefix(nodes, new Set()).map((entry) => entry.id)).toEqual(["frame"]);
  });

  it("keeps shape image fills in Canvas until the image pass can preserve their mask", () => {
    const nodes = [node("frame", "frame"), node("filled-rectangle", "rectangle", "asset")];
    expect(gpuLayerPrefix(nodes, new Set(["asset"])).map((entry) => entry.id)).toEqual(["frame"]);
  });

  it("allows a GPU-eligible text node after images", () => {
    const nodes = [node("frame", "frame"), node("image", "image", "asset"), node("text", "text")];
    expect(gpuLayerPrefix(nodes, new Set(["asset"]), new Set(["text"])).map((entry) => entry.id)).toEqual(["frame", "image", "text"]);
  });

  it("keeps gradient text in Canvas because the GPU glyph atlas is solid-only", () => {
    const text = { ...node("text", "text"), fillGradient: { start: [0, 0] as [number, number], end: [1, 0] as [number, number], stops: [] } };
    expect(gpuLayerPrefix([text], new Set(), new Set(["text"]))).toEqual([]);
  });

  it("admits aligned full Ellipse rings once the GPU has the equivalent two-ring pass", () => {
    const ellipse = { ...node("ellipse", "ellipse"), strokeWidth: 8, strokeAlign: "outside" as const };
    expect(gpuLayerPrefix([ellipse], new Set()).map((entry) => entry.id)).toEqual(["ellipse"]);
  });

  it("keeps Arc and Donut Ellipses in Canvas", () => {
    const ellipse = { ...node("ellipse", "ellipse"), arcData: { startingAngle: 0, endingAngle: 180, innerRadius: 0 } };
    expect(gpuLayerPrefix([ellipse], new Set())).toEqual([]);
  });

  it("keeps detailed Frame and Rectangle outlines in Canvas", () => {
    const weighted = { ...node("rectangle", "weighted"), strokeWeights: [1, 2, 3, 4] as [number, number, number, number] };
    const rounded = { ...node("frame", "rounded"), cornerRadii: [3, 4, 5, 6] as [number, number, number, number] };
    expect(gpuLayerPrefix([weighted], new Set())).toEqual([]);
    expect(gpuLayerPrefix([rounded], new Set())).toEqual([]);
  });

  it("keeps the whole suffix in Canvas when an affine-native layer is encountered", () => {
    const nodes = [node("frame", "frame"), node("skewed", "rectangle"), node("later", "rectangle")];
    expect(gpuLayerPrefix(nodes, new Set(), new Set(), (entry) => entry.id !== "skewed").map((entry) => entry.id)).toEqual(["frame"]);
  });

  it("admits bounded Drop Shadows, one Layer Blur and one zero-spread Inner Shadow while keeping richer E1 effects in Canvas", () => {
    expect(requiresCanvasEffectOrBlend({ ...node("multiply", "rectangle"), blendMode: "multiply" })).toBe(true);
    const shadow = { ...node("shadow", "rectangle"), effectStack: [{ dropShadow: { offsetX: 0, offsetY: 2, blurRadius: 6, spread: 0, color: { space: "srgb", components: [0, 0, 0], alpha: .2 }, visible: true } }] };
    const stackedShadow = { ...shadow, effectStack: [...shadow.effectStack, { dropShadow: { offsetX: -2, offsetY: 1, blurRadius: 3, spread: 0, color: { space: "srgb", components: [0, 0, 0], alpha: .1 }, visible: true } }] };
    expect(requiresCanvasEffectOrBlend(stackedShadow)).toBe(false);
    expect(gpuLayerPrefix([node("first", "rectangle"), stackedShadow, node("later", "rectangle")], new Set()).map((entry) => entry.id)).toEqual(["first", "shadow"]);
    const eightShadows = { ...shadow, effectStack: Array.from({ length: 8 }, (_, index) => ({ dropShadow: { offsetX: index, offsetY: 2, blurRadius: 6, spread: 0, color: { space: "srgb", components: [0, 0, 0], alpha: .2 }, visible: true } })) };
    expect(requiresCanvasEffectOrBlend(eightShadows)).toBe(false);
    expect(requiresCanvasEffectOrBlend({ ...eightShadows, effectStack: [...eightShadows.effectStack, eightShadows.effectStack[0]!] })).toBe(true);
    expect(requiresCanvasEffectOrBlend({ ...shadow, effectStack: [{ dropShadow: { offsetX: 0, offsetY: 2, blurRadius: 6, spread: 1, color: { space: "srgb", components: [0, 0, 0], alpha: .2 }, visible: true } }] })).toBe(true);
    const layerBlur = { ...node("layer-blur", "rectangle"), effectStack: [{ layerBlur: { radius: 12, visible: true } }] };
    expect(isGpuLayerBlurEffectNode(layerBlur)).toBe(true);
    expect(requiresCanvasEffectOrBlend(layerBlur)).toBe(false);
    expect(gpuLayerPrefix([node("first", "rectangle"), layerBlur, node("later", "rectangle")], new Set()).map((entry) => entry.id)).toEqual(["first", "layer-blur"]);
    expect(requiresCanvasEffectOrBlend({ ...layerBlur, effectStack: [...layerBlur.effectStack, { dropShadow: { offsetX: 0, offsetY: 2, blurRadius: 6, spread: 0, color: { space: "srgb", components: [0, 0, 0], alpha: .2 }, visible: true } }] })).toBe(true);
    expect(requiresCanvasEffectOrBlend({ ...node("hidden-blur", "rectangle"), effectStack: [{ layerBlur: { radius: 12, visible: false } }] })).toBe(false);
    const innerShadow = { ...node("inner-shadow", "rectangle"), effectStack: [{ innerShadow: { offsetX: -2, offsetY: 3, blurRadius: 8, spread: 0, color: { space: "srgb", components: [0, 0, 0], alpha: .25 }, visible: true } }] };
    expect(isGpuInnerShadowEffectNode(innerShadow)).toBe(true);
    expect(requiresCanvasEffectOrBlend(innerShadow)).toBe(false);
    expect(gpuLayerPrefix([node("first", "rectangle"), innerShadow, node("later", "rectangle")], new Set()).map((entry) => entry.id)).toEqual(["first", "inner-shadow"]);
    expect(requiresCanvasEffectOrBlend({ ...innerShadow, effectStack: [{ innerShadow: { ...innerShadow.effectStack[0]!.innerShadow!, spread: 1 } }] })).toBe(true);
    expect(requiresCanvasEffectOrBlend({ ...innerShadow, effectStack: [...innerShadow.effectStack, layerBlur.effectStack[0]!] })).toBe(true);
  });
});
