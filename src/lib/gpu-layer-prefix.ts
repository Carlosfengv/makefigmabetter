import type { CanvasNode } from "./editor-protocol";
import { normalizedNodeEffects } from "./normalized-node-view";

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

export type GpuCanvasIslandReason =
  | "hidden"
  | "structural-root"
  | "mask"
  | "boolean"
  | "repeat"
  | "subtree-composition"
  | "frame-clip"
  | "unsupported-node"
  | "native-affine"
  | "gpu-policy";

export type GpuLayerIsland =
  | { backend: "gpu"; reason: "initial-pass" | "resume-after-canvas" | "pass-restart"; backdrop: "transparent"; nodes: CanvasNode[] }
  | { backend: "canvas"; reason: GpuCanvasIslandReason; backdrop: "transparent" | "previous-islands"; nodes: CanvasNode[] };

function topLevelRootResolver(nodes: readonly CanvasNode[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const rootById = new Map<string, string>();
  return (node: CanvasNode): string => {
    const cachedRoot = rootById.get(node.id);
    if (cachedRoot) return cachedRoot;
    const path: CanvasNode[] = [];
    const visited = new Set<string>();
    let current = node;
    let rootId = node.id;
    while (true) {
      const cachedAncestorRoot = rootById.get(current.id);
      if (cachedAncestorRoot) {
        rootId = cachedAncestorRoot;
        break;
      }
      path.push(current);
      visited.add(current.id);
      const parent = current.parentId ? byId.get(current.parentId) : undefined;
      if (!parent || visited.has(parent.id)) {
        rootId = current.id;
        break;
      }
      current = parent;
    }
    path.forEach((entry) => rootById.set(entry.id, rootId));
    return rootId;
  };
}

/**
 * Splits canonical paint order into executable backend islands. A structural
 * node keeps its complete top-level root in Canvas, because clipping, masks,
 * Boolean operands and isolated composition cannot be separated from their
 * descendants. Independent nodes may restart the GPU's fixed pass order in a
 * later transparent bitmap; the caller must composite every returned island
 * immediately, in this exact order.
 */
export function gpuLayerIslands(
  orderedNodes: readonly CanvasNode[],
  decodedImageAssetIds: ReadonlySet<string>,
  gpuTextNodeIds: ReadonlySet<string> = new Set(),
  isStructuralBarrier: (node: CanvasNode) => boolean | GpuCanvasIslandReason = () => false,
  canUseGpu: (node: CanvasNode) => boolean | GpuCanvasIslandReason = () => true,
): GpuLayerIsland[] {
  const rootFor = topLevelRootResolver(orderedNodes);
  const structuralRootReasons = new Map<string, GpuCanvasIslandReason>();
  const structuralRootsWithBackdrop = new Set<string>();
  for (const node of orderedNodes) {
    const rootId = rootFor(node);
    if (requiresCanvasBackdrop(node)) structuralRootsWithBackdrop.add(rootId);
    const barrier = isStructuralBarrier(node);
    if (!barrier) continue;
    if (!structuralRootReasons.has(rootId)) structuralRootReasons.set(rootId, barrier === true ? "structural-root" : barrier);
  }
  const islands: GpuLayerIsland[] = [];
  let currentGpuPass: number | undefined;
  const appendCanvas = (node: CanvasNode, reason: GpuCanvasIslandReason, backdrop: Extract<GpuLayerIsland, { backend: "canvas" }>["backdrop"]) => {
    const previous = islands.at(-1);
    if (previous?.backend === "canvas" && previous.reason === reason && previous.backdrop === backdrop) previous.nodes.push(node);
    else islands.push({ backend: "canvas", reason, backdrop, nodes: [node] });
    currentGpuPass = undefined;
  };
  const appendNewGpu = (node: CanvasNode, pass: number, reason: Extract<GpuLayerIsland, { backend: "gpu" }>["reason"]) => {
    islands.push({ backend: "gpu", reason, backdrop: "transparent", nodes: [node] });
    currentGpuPass = pass;
  };

  for (const node of orderedNodes) {
    if (node.visible === false) {
      appendCanvas(node, "hidden", "transparent");
      continue;
    }
    const rootId = rootFor(node);
    const structuralReason = structuralRootReasons.get(rootId);
    if (structuralReason) {
      appendCanvas(node, structuralReason, structuralRootsWithBackdrop.has(rootId) ? "previous-islands" : "transparent");
      continue;
    }
    const policy = canUseGpu(node);
    if (policy !== true) {
      appendCanvas(node, policy === false ? "gpu-policy" : policy, requiresCanvasBackdrop(node) ? "previous-islands" : "transparent");
      continue;
    }
    const pass = gpuPass(node, decodedImageAssetIds, gpuTextNodeIds);
    if (pass === undefined) {
      appendCanvas(node, "unsupported-node", requiresCanvasBackdrop(node) ? "previous-islands" : "transparent");
      continue;
    }
    const previous = islands.at(-1);
    if (previous?.backend === "gpu" && currentGpuPass !== undefined && currentGpuPass !== 3 && pass >= currentGpuPass) {
      previous.nodes.push(node);
      currentGpuPass = pass;
      continue;
    }
    appendNewGpu(node, pass, islands.length === 0 ? "initial-pass" : previous?.backend === "canvas" ? "resume-after-canvas" : "pass-restart");
  }
  return islands;
}

/** True when a Canvas island must sample pixels produced by earlier islands.
 * This fence prevents a later fallback-texture optimization from silently
 * changing blend or Background Blur semantics by painting onto transparency. */
export function requiresCanvasBackdrop(node: CanvasNode): boolean {
  if (node.blendMode !== undefined && node.blendMode !== "normal" && node.blendMode !== "pass-through") return true;
  return normalizedNodeEffects(node).some((effect) =>
    Boolean(effect.backgroundBlur?.visible && effect.backgroundBlur.radius > 0),
  );
}

/** Visible Canvas islands without a backdrop dependency can be materialized at
 * their existing display-list boundary. The executor initializes the local
 * surface from the already presented backing pixels, so antialiased edges are
 * blended only once. Blend and Background Blur islands remain direct Canvas:
 * Chromium does not preserve their full RGBA result across a second local
 * compositing surface, even when that surface starts with identical pixels. */
export function canMaterializeCanvasIsland(
  island: GpuLayerIsland,
): island is Extract<GpuLayerIsland, { backend: "canvas" }> {
  return island.backend === "canvas"
    && island.reason !== "hidden"
    && island.reason !== "gpu-policy"
    && island.backdrop === "transparent";
}

/** A single WebGPU renderer retains one uploaded scene. On large documents,
 * alternating between several GPU islands would replace that cache and upload
 * every island again for each camera frame. Preserve the requested number of
 * GPU islands, then execute the remaining canonical suffix as one Canvas
 * island. Small documents keep the full multi-island path. */
export function limitGpuLayerIslands(
  islands: readonly GpuLayerIsland[],
  maxGpuIslands: number,
): GpuLayerIsland[] {
  const limit = Math.max(0, Math.floor(maxGpuIslands));
  let gpuIslands = 0;
  let cutoff = -1;
  for (let index = 0; index < islands.length; index += 1) {
    if (islands[index]?.backend !== "gpu") continue;
    gpuIslands += 1;
    if (gpuIslands > limit) {
      cutoff = index > 0 && islands[index - 1]?.backend === "canvas" ? index - 1 : index;
      break;
    }
  }
  if (cutoff < 0) return islands.map((island) => ({ ...island, nodes: [...island.nodes] }));
  const suffix = islands.slice(cutoff);
  return [
    ...islands.slice(0, cutoff).map((island) => ({ ...island, nodes: [...island.nodes] })),
    {
      backend: "canvas",
      reason: "gpu-policy",
      backdrop: suffix.some((island) => island.backdrop === "previous-islands") ? "previous-islands" : "transparent",
      nodes: suffix.flatMap((island) => island.nodes),
    },
  ];
}

/**
 * Returns the ordered top-level prefix that is independent of the first
 * structural Canvas subtree. A mask, clip, Boolean or isolated group remains
 * an ordering barrier, while earlier sibling roots can still be rendered into
 * the transparent GPU bitmap and composited before the Canvas suffix.
 */
export function gpuPrefixBeforeStructuralRoot(
  orderedNodes: readonly CanvasNode[],
  isStructuralBarrier: (node: CanvasNode) => boolean,
): CanvasNode[] {
  const rootFor = topLevelRootResolver(orderedNodes);
  const structuralRoots = new Set(orderedNodes.filter(isStructuralBarrier).map(rootFor));
  const firstBarrierIndex = orderedNodes.findIndex((node) => structuralRoots.has(rootFor(node)));
  return firstBarrierIndex < 0 ? [...orderedNodes] : orderedNodes.slice(0, firstBarrierIndex);
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
  const hasEffect = normalizedNodeEffects(node).some((effect) =>
    effect.dropShadow?.visible || effect.layerBlur?.visible || effect.innerShadow?.visible || effect.backgroundBlur?.visible,
  );
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
  const stack = normalizedNodeEffects(node);
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
  const stack = normalizedNodeEffects(node);
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
  const stack = normalizedNodeEffects(node);
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
  if (node.fillGradient || node.strokeGradient || node.fills?.length || node.strokes?.length || node.fillStack || node.strokeStack || node.assetId) return false;
  if (node.kind === "ellipse" && node.arcData) return false;
  return !((node.kind === "frame" || node.kind === "rectangle") && (node.strokeWeights?.length || node.cornerRadii?.length || node.cornerSmoothing));
}

function gpuPass(node: CanvasNode, decodedImageAssetIds: ReadonlySet<string>, gpuTextNodeIds: ReadonlySet<string>) {
  // Ordered Paint stacks need Canvas's per-layer compositing until the GPU
  // pipeline has an equivalent multi-pass representation.
  if (node.fills?.length || node.strokes?.length || node.fillStack || node.strokeStack) return undefined;
  if (requiresCanvasEffectOrBlend(node)) return undefined;
  if (isGpuSimpleEffectNode(node)) return 3;
  if (gpuSolidShape(node)) return 0;
  if (node.kind === "image" && node.assetId && decodedImageAssetIds.has(node.assetId)) return 1;
  // The GPU text pass currently owns solid fills only. A gradient remains a
  // Canvas node so the Inspector can safely expose Text Fill without showing
  // a stale solid glyph atlas after the user changes it.
  if ((node.kind === "text" || node.kind === "textPath") && !node.fillGradient && gpuTextNodeIds.has(node.id)) return 2;
  return undefined;
}

function gpuSolidShape(node: CanvasNode) {
  if (node.assetId || node.fillGradient || node.strokeGradient || node.fills?.length || node.strokes?.length || node.fillStack || node.strokeStack) return false;
  if (node.kind === "ellipse") return !node.arcData;
  // Four independently weighted sides and non-circular corners need Canvas's
  // detailed outline path until the GPU instance format carries that geometry.
  return (node.kind === "frame" || node.kind === "rectangle")
    && !node.strokeWeights?.length
    && !node.cornerRadii?.length
    && !node.cornerSmoothing;
}
