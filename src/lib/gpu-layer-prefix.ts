import type { CanvasNode } from "./editor-protocol";

/**
 * The transitional GPU renderer owns one bitmap, whose fixed passes are solid
 * shapes → images → GPU text. Once canonical z-order would require going back
 * to an earlier pass, the remaining nodes stay in Canvas so compositing keeps
 * the exact Figma-style layer order instead of drawing a newer shape beneath
 * an older image.
 */
export function gpuLayerPrefix(nodes: readonly CanvasNode[], decodedImageAssetIds: ReadonlySet<string>, gpuTextNodeIds: ReadonlySet<string> = new Set()) {
  const prefix: CanvasNode[] = [];
  let previousPass = -1;
  for (const node of nodes) {
    if (node.visible === false) continue;
    const pass = gpuPass(node, decodedImageAssetIds, gpuTextNodeIds);
    if (pass === undefined || pass < previousPass) break;
    prefix.push(node);
    previousPass = pass;
  }
  return prefix;
}

function gpuPass(node: CanvasNode, decodedImageAssetIds: ReadonlySet<string>, gpuTextNodeIds: ReadonlySet<string>) {
  if ((node.kind === "frame" || node.kind === "rectangle" || node.kind === "ellipse") && !node.assetId && !node.fillGradient && !node.strokeGradient) return 0;
  if (node.kind === "image" && node.assetId && decodedImageAssetIds.has(node.assetId)) return 1;
  if (node.kind === "text" && gpuTextNodeIds.has(node.id)) return 2;
  return undefined;
}
