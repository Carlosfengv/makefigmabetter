import type { CanvasNode } from "./editor-protocol";

/** Figma keeps persistent canvas labels on page-level containers only.
 * Nested Frames/Sections are named in Layers and while selected, otherwise
 * their labels would cover the artwork they structure. */
export function showsPersistentCanvasLayerName(
  node: Pick<CanvasNode, "kind" | "parentId" | "visible">,
) {
  return !node.parentId
    && node.visible !== false
    && (node.kind === "frame"
      || node.kind === "component"
      || node.kind === "instance"
      || node.kind === "slot"
      || node.kind === "componentSet"
      || node.kind === "section");
}
