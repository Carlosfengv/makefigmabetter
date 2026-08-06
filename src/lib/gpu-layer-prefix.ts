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
    previousPass = pass;
  }
  return prefix;
}

function gpuPass(node: CanvasNode, decodedImageAssetIds: ReadonlySet<string>, gpuTextNodeIds: ReadonlySet<string>) {
  // Ordered Paint stacks need Canvas's per-layer compositing until the GPU
  // pipeline has an equivalent multi-pass representation.
  if (node.fills?.length || node.strokes?.length) return undefined;
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
