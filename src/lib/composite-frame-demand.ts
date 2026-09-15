import type { CanvasNode } from "./editor-protocol";
import { admitAlphaMaskSurface, MAX_ALPHA_MASK_NESTING } from "./alpha-mask-budget";
import { admitCompositeSurfaceBytes } from "./composite-surface-budget";
import { admitSubtreeCompositeSurfacePool, MAX_SUBTREE_COMPOSITE_NESTING } from "./subtree-composite-budget";
import { isLinearBlendMode } from "./linear-blend-composite";
import { normalizedFillLayers, normalizedStrokeLayers } from "./normalized-node-view";
import { activeMaskAlphaEffects, activeNodeEffects, requiresSubtreeComposition } from "./subtree-compositing";

export type CompositeFrameDemand = {
  effectPool: boolean;
  linearPaintPool: boolean;
  alphaMaskPools: number;
  subtreePools: number;
  surfaces: number;
};

export type CompositeFrameAdmission =
  | { accepted: true; demand: CompositeFrameDemand }
  | {
      accepted: false;
      demand: CompositeFrameDemand;
      reason: "alphaMaskNesting" | "alphaMaskSurface" | "subtreeNesting" | "subtreeSurface" | "frameLimit" | "invalidDimensions";
    };

export type CompositePoolDimensions = Readonly<{ pixelWidth: number; pixelHeight: number }>;
export type CompositeFrameSurfacePlan = Readonly<{
  effectPool?: CompositePoolDimensions;
  linearPaintPool?: CompositePoolDimensions;
  alphaMaskPools?: readonly CompositePoolDimensions[];
  subtreePools?: readonly CompositePoolDimensions[];
}>;

/**
 * Computes the maximum simultaneous Canvas composition pools needed by one
 * structural paint. The traversal mirrors the Worker tree renderer: masks
 * consume the following sibling run, while isolated subtrees add one pool for
 * every active composition depth.
 */
export function compositeFrameDemand(orderedNodes: readonly CanvasNode[]): CompositeFrameDemand {
  const ids = new Set(orderedNodes.map((node) => node.id));
  const children = new Map<string, CanvasNode[]>();
  const roots: CanvasNode[] = [];
  orderedNodes.forEach((node) => {
    if (!node.parentId || !ids.has(node.parentId)) roots.push(node);
    else {
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node);
      children.set(node.parentId, siblings);
    }
  });

  let effectPool = false;
  let linearPaintPool = false;
  let alphaMaskPools = 0;
  let subtreePools = 0;

  const visitSiblings = (
    siblings: readonly CanvasNode[],
    maskDepth: number,
    compositionDepth: number,
    maskAlphaOnly = false,
  ) => {
    for (let index = 0; index < siblings.length; index += 1) {
      const node = siblings[index]!;
      const alphaOnly = maskAlphaOnly || Boolean(node.isMask);
      // Figma masks consume the rendered source alpha. Artistic paint-layer
      // blend equations only change colour; their source-over alpha is the
      // same as Normal, so an alpha-only branch must not reserve the bounded
      // three-buffer colour readback pool.
      if (!alphaOnly && [...normalizedFillLayers(node), ...normalizedStrokeLayers(node)]
        .some((layer) => isLinearBlendMode(layer.blendMode))) linearPaintPool = true;
      const nodeEffects = alphaOnly ? activeMaskAlphaEffects(node) : activeNodeEffects(node);
      if (node.isMask) {
        const maskDescendants = children.get(node.id) ?? [];
        const maskIsolated = requiresSubtreeComposition(node, maskDescendants.length > 0, nodeEffects);
        if (maskIsolated) {
          subtreePools = Math.max(subtreePools, compositionDepth + 1);
          visitSiblings(maskDescendants, maskDepth + 1, compositionDepth + 1, true);
        } else {
          if (node.kind !== "group" && node.kind !== "slice" && nodeEffects.length > 0)
            effectPool = true;
          visitSiblings(maskDescendants, maskDepth + 1, compositionDepth, true);
        }
        let end = index + 1;
        while (end < siblings.length && !siblings[end]!.isMask) end += 1;
        const targets = siblings.slice(index + 1, end);
        if (targets.length) {
          alphaMaskPools = Math.max(alphaMaskPools, maskDepth + 1);
          visitSiblings(targets, maskDepth + 1, compositionDepth, false);
        }
        index = end - 1;
        continue;
      }

      const descendants = children.get(node.id) ?? [];
      const isolated = requiresSubtreeComposition(node, descendants.length > 0, nodeEffects);
      if (isolated) {
        subtreePools = Math.max(subtreePools, compositionDepth + 1);
        visitSiblings(descendants, maskDepth, compositionDepth + 1, maskAlphaOnly);
      } else {
        if (node.kind !== "group" && node.kind !== "slice" && nodeEffects.length > 0)
          effectPool = true;
        visitSiblings(descendants, maskDepth, compositionDepth, maskAlphaOnly);
      }
    }
  };

  visitSiblings(roots, 0, 0);
  return {
    effectPool,
    linearPaintPool,
    alphaMaskPools,
    subtreePools,
    surfaces: (effectPool ? 3 : 0) + (linearPaintPool ? 3 : 0) + alphaMaskPools * 2 + subtreePools * 3,
  };
}

/** Rejects the whole paint before the transferred canvas is touched. */
export function admitCompositeFrame(
  pixelWidth: number,
  pixelHeight: number,
  orderedNodes: readonly CanvasNode[],
  surfacePlan?: CompositeFrameSurfacePlan,
): CompositeFrameAdmission {
  const demand = compositeFrameDemand(orderedNodes);
  if (demand.alphaMaskPools > MAX_ALPHA_MASK_NESTING)
    return { accepted: false, demand, reason: "alphaMaskNesting" };
  if (demand.subtreePools > MAX_SUBTREE_COMPOSITE_NESTING)
    return { accepted: false, demand, reason: "subtreeNesting" };
  const fullCanvas = { pixelWidth, pixelHeight };
  const alphaMaskPools = Array.from({ length: demand.alphaMaskPools }, (_, depth) => surfacePlan?.alphaMaskPools?.[depth] ?? fullCanvas);
  const subtreePools = Array.from({ length: demand.subtreePools }, (_, depth) => surfacePlan?.subtreePools?.[depth] ?? fullCanvas);
  for (let depth = 0; depth < alphaMaskPools.length; depth += 1) {
    const dimensions = alphaMaskPools[depth]!;
    const admission = admitAlphaMaskSurface(dimensions.pixelWidth, dimensions.pixelHeight, depth);
    if (!admission.accepted)
      return { accepted: false, demand, reason: admission.reason === "nesting" ? "alphaMaskNesting" : "alphaMaskSurface" };
  }
  for (let depth = 0; depth < subtreePools.length; depth += 1) {
    const dimensions = subtreePools[depth]!;
    const admission = admitSubtreeCompositeSurfacePool(dimensions.pixelWidth, dimensions.pixelHeight, 0);
    if (!admission.accepted)
      return {
        accepted: false,
        demand,
        reason: admission.reason === "invalidDimensions" ? "invalidDimensions" : "subtreeSurface",
      };
  }
  let allocatedBytes = 0;
  for (const dimensions of alphaMaskPools) {
    const admission = admitCompositeSurfaceBytes(allocatedBytes, dimensions.pixelWidth, dimensions.pixelHeight, 2);
    if (!admission.accepted)
      return { accepted: false, demand, reason: admission.reason === "invalidDimensions" ? "invalidDimensions" : "frameLimit" };
    allocatedBytes = admission.totalBytes;
  }
  for (const dimensions of subtreePools) {
    const admission = admitCompositeSurfaceBytes(allocatedBytes, dimensions.pixelWidth, dimensions.pixelHeight, 3);
    if (!admission.accepted)
      return { accepted: false, demand, reason: admission.reason === "invalidDimensions" ? "invalidDimensions" : "frameLimit" };
    allocatedBytes = admission.totalBytes;
  }
  if (demand.linearPaintPool) {
    const dimensions = surfacePlan?.linearPaintPool ?? fullCanvas;
    const admission = admitCompositeSurfaceBytes(allocatedBytes, dimensions.pixelWidth, dimensions.pixelHeight, 3);
    if (!admission.accepted)
      return { accepted: false, demand, reason: admission.reason === "invalidDimensions" ? "invalidDimensions" : "frameLimit" };
    allocatedBytes = admission.totalBytes;
  }
  if (demand.effectPool) {
    const dimensions = surfacePlan?.effectPool ?? fullCanvas;
    const admission = admitCompositeSurfaceBytes(
      allocatedBytes,
      dimensions.pixelWidth,
      dimensions.pixelHeight,
      3,
    );
    if (!admission.accepted)
      return { accepted: false, demand, reason: admission.reason === "invalidDimensions" ? "invalidDimensions" : "frameLimit" };
  }
  return { accepted: true, demand };
}
