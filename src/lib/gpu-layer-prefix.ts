import type { CanvasNode } from "./editor-protocol";

/**
 * The transitional GPU renderer owns one bitmap, whose fixed passes are solid
 * shapes → images → GPU text. Once canonical z-order would require going back
 * to an earlier pass, the remaining nodes stay in Canvas so compositing keeps
 * the exact Figma-style layer order instead of drawing a newer shape beneath
 * an older image.
 */
export function gpuLayerPrefix(nodes: readonly CanvasNode[], decodedImageAssetIds: ReadonlySet<string>, gpuTextNodeIds: ReadonlySet<string> = new Set(), canUseGpu: (node: CanvasNode) => boolean = () => true) {
  const prefix: CanvasNode[] = [];
  let previousPass = -1;
  for (const node of nodes) {
    if (node.visible === false) continue;
    if (!canUseGpu(node)) break;
    const pass = gpuPass(node, decodedImageAssetIds, gpuTextNodeIds);
    if (pass === undefined || pass < previousPass) break;
    prefix.push(node);
    // The E1 offscreen effect owns the terminal pass. Stopping here prevents
    // a second effect or a newer ordinary shape from being composited ahead of
    // Canvas's exact suffix while the GPU path is intentionally narrow.
    if (pass === 3) break;
    previousPass = pass;
  }
  return prefix;
}

/**
 * E1's first delivery keeps blending and isolated effects in Canvas 2D until
 * the WebGPU graph has equivalent source/backdrop passes. This boundary is
 * deliberately explicit: allowing such a node into the GPU's ordinary alpha
 * pass would produce a plausible but incorrect image, and its following
 * siblings must remain in the Canvas suffix to retain paint order.
 */
export function requiresCanvasEffectOrBlend(node: CanvasNode): boolean {
  if (node.blendMode !== undefined && node.blendMode !== "normal") return true;
  const hasEffect = Boolean(node.effectStack?.some((effect) =>
    effect.dropShadow?.visible || effect.layerBlur?.visible || effect.innerShadow?.visible || effect.backgroundBlur?.visible,
  ));
  return hasEffect && !isGpuSimpleEffectNode(node);
}

/**
 * E1's GPU effect remains deliberately narrow: up to eight ordered ordinary
 * Drop Shadows, one Layer Blur, or one zero-spread Inner Shadow on an otherwise GPU-solid shape. Each visible effect owns two
 * budgeted offscreen surfaces for source/blur/composite, while every richer
 * stack stays in Canvas so layer ordering and source-alpha semantics remain
 * exact.
 */
export function isGpuDropShadowEffectNode(node: CanvasNode) {
  if (!isGpuSimpleEffectShape(node)) return false;
  const stack = node.effectStack?.length ? node.effectStack : (node.dropShadow ? [{ dropShadow: node.dropShadow }] : []);
  if (stack.length < 1 || stack.length > 8 || stack.some((effect) => !effect.dropShadow)) return false;
  const shadows = stack.map((effect) => effect.dropShadow!);
  return shadows.some((shadow) => shadow.visible && shadow.color.alpha > 0)
    && shadows.every((shadow) => shadow.spread === 0 && Number.isFinite(shadow.blurRadius) && shadow.blurRadius >= 0);
}

/** A single source blur has the same bounded source → blur → composite graph
 * as a shadow, but replaces its source instead of painting beneath it. Keep
 * richer stacks in Canvas until their ordering and alpha semantics have a
 * complete GPU representation. */
export function isGpuLayerBlurEffectNode(node: CanvasNode) {
  if (!isGpuSimpleEffectShape(node)) return false;
  const stack = node.effectStack ?? [];
  return stack.length === 1
    && Boolean(stack[0]?.layerBlur?.visible)
    && Number.isFinite(stack[0]?.layerBlur?.radius)
    && (stack[0]?.layerBlur?.radius ?? -1) >= 0;
}

/** A single zero-spread Inner Shadow can reuse the source/blur pair: the GPU
 * composites the blurred alpha through the original source alpha in its final
 * pass. Spread and ordered stacks remain Canvas-owned until their intermediate
 * morphology/compositing graph is fully represented. */
export function isGpuInnerShadowEffectNode(node: CanvasNode) {
  if (!isGpuSimpleEffectShape(node)) return false;
  const stack = node.effectStack ?? [];
  const shadow = stack.length === 1 ? stack[0]?.innerShadow : undefined;
  return Boolean(shadow?.visible)
    && (shadow?.color.alpha ?? 0) > 0
    && shadow?.spread === 0
    && Number.isFinite(shadow?.blurRadius)
    && (shadow?.blurRadius ?? -1) >= 0;
}

export function isGpuSimpleEffectNode(node: CanvasNode) {
  return isGpuDropShadowEffectNode(node) || isGpuLayerBlurEffectNode(node) || isGpuInnerShadowEffectNode(node);
}

function isGpuSimpleEffectShape(node: CanvasNode) {
  if (node.blendMode !== undefined && node.blendMode !== "normal") return false;
  if (node.kind !== "frame" && node.kind !== "rectangle" && node.kind !== "ellipse") return false;
  if (node.fillGradient || node.strokeGradient || node.fills?.length || node.strokes?.length || node.assetId) return false;
  if (node.kind === "ellipse" && node.arcData) return false;
  return !((node.kind === "frame" || node.kind === "rectangle") && (node.strokeWeights?.length || node.cornerRadii?.length || node.cornerSmoothing));
}

function gpuPass(node: CanvasNode, decodedImageAssetIds: ReadonlySet<string>, gpuTextNodeIds: ReadonlySet<string>) {
  // Ordered Paint stacks need Canvas's per-layer compositing until the GPU
  // pipeline has an equivalent multi-pass representation.
  if (node.fills?.length || node.strokes?.length) return undefined;
  if (isGpuSimpleEffectNode(node)) return 3;
  if (gpuSolidShape(node)) return 0;
  if (node.kind === "image" && node.assetId && decodedImageAssetIds.has(node.assetId)) return 1;
  // The GPU text pass currently owns solid fills only. A gradient remains a
  // Canvas node so the Inspector can safely expose Text Fill without showing
  // a stale solid glyph atlas after the user changes it.
  if (node.kind === "text" && !node.fillGradient && gpuTextNodeIds.has(node.id)) return 2;
  return undefined;
}

function gpuSolidShape(node: CanvasNode) {
  if (node.assetId || node.fillGradient || node.strokeGradient || node.fills?.length || node.strokes?.length) return false;
  if (node.kind === "ellipse") return !node.arcData;
  // Four independently weighted sides and non-circular corners need Canvas's
  // detailed outline path until the GPU instance format carries that geometry.
  return (node.kind === "frame" || node.kind === "rectangle")
    && !node.strokeWeights?.length
    && !node.cornerRadii?.length
    && !node.cornerSmoothing;
}
