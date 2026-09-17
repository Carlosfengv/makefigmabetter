import { describe, expect, it } from "vitest";
import { canMaterializeCanvasIsland, gpuLayerIslands, gpuLayerPrefix, gpuPrefixBeforeStructuralRoot, isGpuInnerShadowEffectNode, isGpuLayerBlurEffectNode, limitGpuLayerIslands, requiresCanvasBackdrop, requiresCanvasEffectOrBlend } from "./gpu-layer-prefix";
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

  it("routes a shaped TextPath through the glyph pass instead of the solid-shape pass", () => {
    const textPath = node("text-path", "textPath");
    expect(gpuLayerPrefix([textPath], new Set(), new Set([textPath.id])).map((entry) => entry.id)).toEqual([textPath.id]);
    expect(gpuLayerPrefix([textPath], new Set(), new Set())).toEqual([]);
  });

  it("keeps gradient text in Canvas because the GPU glyph atlas is solid-only", () => {
    const text = { ...node("text", "text"), fillGradient: { start: [0, 0] as [number, number], end: [1, 0] as [number, number], stops: [] } };
    expect(gpuLayerPrefix([text], new Set(), new Set(["text"]))).toEqual([]);
  });

  it("keeps layered TextPath paint in its ordered Canvas island", () => {
    const textPath = {
      ...node("text-path", "textPath"),
      fillStack: { layers: [{ visible: true, opacity: 1, blendMode: "normal" as const, image: { assetId: "paint-image", scaleMode: "fill" as const, transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } } }] },
    };
    expect(gpuLayerPrefix([textPath], new Set(["paint-image"]), new Set([textPath.id]))).toEqual([]);
    expect(gpuLayerIslands([textPath], new Set(["paint-image"]), new Set([textPath.id]))).toEqual([
      { backend: "canvas", reason: "unsupported-node", backdrop: "transparent", nodes: [textPath] },
    ]);
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

  it("keeps independent roots before a structural subtree eligible for GPU", () => {
    const nodes = [
      node("background", "rectangle"),
      node("before", "ellipse"),
      { ...node("frame", "frame"), clipsContent: true },
      { ...node("child", "rectangle"), parentId: "frame" },
      node("after", "rectangle"),
    ];
    expect(gpuPrefixBeforeStructuralRoot(nodes, (entry) => entry.id === "child").map((entry) => entry.id)).toEqual(["background", "before"]);
  });

  it("does not admit a descendant prefix when its own root contains a later barrier", () => {
    const nodes = [
      node("group", "group"),
      { ...node("safe-child", "rectangle"), parentId: "group" },
      { ...node("mask", "ellipse"), parentId: "group", isMask: true },
      { ...node("target", "rectangle"), parentId: "group" },
      node("later-root", "rectangle"),
    ];
    expect(gpuPrefixBeforeStructuralRoot(nodes, (entry) => Boolean(entry.isMask))).toEqual([]);
  });

  it("restarts the fixed GPU pass order in later ordered islands", () => {
    const nodes = [
      node("shape-before", "rectangle"),
      node("image", "image", "asset"),
      node("shape-after", "ellipse"),
      { ...node("gradient", "rectangle"), fillGradient: { start: [0, 0] as [number, number], end: [1, 0] as [number, number], stops: [] } },
      node("text", "text"),
    ];
    expect(gpuLayerIslands(nodes, new Set(["asset"]), new Set(["text"])).map((island) => ({
      backend: island.backend,
      reason: island.reason,
      backdrop: island.backdrop,
      ids: island.nodes.map((entry) => entry.id),
    }))).toEqual([
      { backend: "gpu", reason: "initial-pass", backdrop: "transparent", ids: ["shape-before", "image"] },
      { backend: "gpu", reason: "pass-restart", backdrop: "transparent", ids: ["shape-after"] },
      { backend: "canvas", reason: "unsupported-node", backdrop: "transparent", ids: ["gradient"] },
      { backend: "gpu", reason: "resume-after-canvas", backdrop: "transparent", ids: ["text"] },
    ]);
  });

  it("keeps every node in a structural top-level root in one Canvas island", () => {
    const nodes = [
      node("before", "rectangle"),
      node("group", "group"),
      { ...node("safe-child", "rectangle"), parentId: "group" },
      { ...node("mask", "ellipse"), parentId: "group", isMask: true },
      { ...node("target", "rectangle"), parentId: "group" },
      node("after", "rectangle"),
    ];
    expect(gpuLayerIslands(nodes, new Set(), new Set(), (entry) => entry.isMask ? "mask" : false).map((island) => ({
      backend: island.backend,
      reason: island.reason,
      backdrop: island.backdrop,
      ids: island.nodes.map((entry) => entry.id),
    }))).toEqual([
      { backend: "gpu", reason: "initial-pass", backdrop: "transparent", ids: ["before"] },
      { backend: "canvas", reason: "mask", backdrop: "transparent", ids: ["group", "safe-child", "mask", "target"] },
      { backend: "gpu", reason: "resume-after-canvas", backdrop: "transparent", ids: ["after"] },
    ]);
  });

  it("keeps unsupported blend and effect nodes at their ordered Canvas boundary", () => {
    const multiply = { ...node("multiply", "rectangle"), blendMode: "multiply" as const };
    const backgroundBlur = { ...node("background-blur", "rectangle"), effectStack: [{ backgroundBlur: { radius: 8, visible: true } }] };
    const nodes = [node("before", "rectangle"), multiply, node("middle", "rectangle"), backgroundBlur, node("after", "rectangle")];
    expect(gpuLayerIslands(nodes, new Set()).map((island) => ({
      backend: island.backend,
      reason: island.reason,
      backdrop: island.backdrop,
      ids: island.nodes.map((entry) => entry.id),
    }))).toEqual([
      { backend: "gpu", reason: "initial-pass", backdrop: "transparent", ids: ["before"] },
      { backend: "canvas", reason: "unsupported-node", backdrop: "previous-islands", ids: ["multiply"] },
      { backend: "gpu", reason: "resume-after-canvas", backdrop: "transparent", ids: ["middle"] },
      { backend: "canvas", reason: "unsupported-node", backdrop: "previous-islands", ids: ["background-blur"] },
      { backend: "gpu", reason: "resume-after-canvas", backdrop: "transparent", ids: ["after"] },
    ]);
    expect(requiresCanvasBackdrop(multiply)).toBe(true);
    expect(requiresCanvasBackdrop(backgroundBlur)).toBe(true);
  });

  it("keeps policy rejections distinct from unsupported node types", () => {
    const affine = node("affine", "rectangle");
    expect(gpuLayerIslands([affine, node("polygon", "polygon")], new Set(), new Set(), () => false, (entry) => entry.id === affine.id ? "native-affine" : true)).toEqual([
      { backend: "canvas", reason: "native-affine", backdrop: "transparent", nodes: [affine] },
      { backend: "canvas", reason: "unsupported-node", backdrop: "transparent", nodes: [expect.objectContaining({ id: "polygon" })] },
    ]);
  });

  it("lifts a descendant backdrop dependency to its complete structural root", () => {
    const nodes = [
      node("group", "group"),
      { ...node("mask", "ellipse"), parentId: "group", isMask: true },
      { ...node("target", "rectangle"), parentId: "group", blendMode: "multiply" as const },
    ];
    expect(gpuLayerIslands(nodes, new Set(), new Set(), (entry) => entry.isMask ? "mask" : false)).toEqual([
      { backend: "canvas", reason: "mask", backdrop: "previous-islands", nodes },
    ]);
  });

  it("materializes only visible Canvas islands without a backdrop dependency", () => {
    const polygon = node("polygon", "polygon");
    const multiply = { ...node("multiply", "rectangle"), blendMode: "multiply" as const };
    const [transparent] = gpuLayerIslands([polygon], new Set());
    const [backdrop] = gpuLayerIslands([multiply], new Set());
    const [hidden] = gpuLayerIslands([{ ...polygon, visible: false }], new Set());
    expect(canMaterializeCanvasIsland(transparent!)).toBe(true);
    expect(canMaterializeCanvasIsland(backdrop!)).toBe(false);
    expect(backdrop).toMatchObject({ backdrop: "previous-islands" });
    expect(canMaterializeCanvasIsland(hidden!)).toBe(false);
  });

  it("keeps one cached GPU scene and folds a large-page remainder into a canonical Canvas suffix", () => {
    const before = node("before", "rectangle");
    const canvas = node("canvas", "polygon");
    const resumed = node("resumed", "ellipse");
    const backdrop = { ...node("backdrop", "rectangle"), blendMode: "multiply" as const };
    const later = node("later", "rectangle");
    const limited = limitGpuLayerIslands(
      gpuLayerIslands([before, canvas, resumed, backdrop, later], new Set()),
      1,
    );
    expect(limited).toEqual([
      { backend: "gpu", reason: "initial-pass", backdrop: "transparent", nodes: [before] },
      { backend: "canvas", reason: "gpu-policy", backdrop: "previous-islands", nodes: [canvas, resumed, backdrop, later] },
    ]);
    expect(canMaterializeCanvasIsland(limited[1]!)).toBe(false);
  });

  it("keeps a transparent large-page policy suffix on direct Canvas", () => {
    const before = node("before", "rectangle");
    const canvas = node("canvas", "polygon");
    const resumed = node("resumed", "ellipse");
    const limited = limitGpuLayerIslands(gpuLayerIslands([before, canvas, resumed], new Set()), 1);
    expect(limited[1]).toMatchObject({ backend: "canvas", reason: "gpu-policy", backdrop: "transparent" });
    expect(canMaterializeCanvasIsland(limited[1]!)).toBe(false);
  });

  it("classifies each node once when building a long GPU island", () => {
    const nodes = Array.from({ length: 2_048 }, (_, index) => node(`shape-${index}`, "rectangle"));
    let classifications = 0;
    const islands = gpuLayerIslands(nodes, new Set(), new Set(), () => false, () => {
      classifications += 1;
      return true;
    });
    expect(classifications).toBe(nodes.length);
    expect(islands).toHaveLength(1);
    expect(islands[0]?.nodes).toHaveLength(nodes.length);
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
