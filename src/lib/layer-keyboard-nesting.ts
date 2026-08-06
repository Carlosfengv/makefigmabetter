import type { CanvasNode } from "./editor-protocol";
import { sortNodesByLayerOrder } from "./layer-order";

export type LayerNestingIntent = "indent" | "outdent";
export type LayerNestingTarget = Readonly<{ id: string; parentId?: string }>;

/**
 * Tab follows the visible Layers-panel convention: the immediately preceding
 * row is the front-most sibling, so it becomes the parent when it is a Frame,
 * Group or Section. Shift+Tab moves a child to its parent’s parent. The caller
 * delegates the actual move to the canonical Reparent transaction.
 */
export function layerKeyboardNestingTarget(nodes: readonly CanvasNode[], id: string, intent: LayerNestingIntent): LayerNestingTarget | undefined {
  const node = nodes.find((candidate) => candidate.id === id);
  if (!node) return undefined;
  if (intent === "outdent") {
    if (!node.parentId) return undefined;
    const parent = nodes.find((candidate) => candidate.id === node.parentId);
    return parent ? { id, parentId: parent.parentId } : undefined;
  }
  const siblings = sortNodesByLayerOrder(nodes.filter((candidate) => candidate.parentId === node.parentId));
  const index = siblings.findIndex((candidate) => candidate.id === id);
  const precedingVisibleSibling = index >= 0 ? siblings[index + 1] : undefined;
  if (!precedingVisibleSibling || !["frame", "group", "section"].includes(precedingVisibleSibling.kind)) return undefined;
  return { id, parentId: precedingVisibleSibling.id };
}
