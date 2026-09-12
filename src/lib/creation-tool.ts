import type { NodeKind, ToolKind } from "./editor-protocol";

/** Only values that are both a Canvas node and a UI tool may reach the
 * pointer/keyboard creation path. New non-tool NodeKinds therefore cannot
 * accidentally widen this predicate when the document schema grows. */
export type CreationToolNodeKind = Extract<NodeKind, ToolKind>;

export function isCreationTool(tool: ToolKind): tool is CreationToolNodeKind | "arrow" {
  return tool === "frame" || tool === "section" || tool === "rectangle" || tool === "ellipse" || tool === "polygon" || tool === "star" || tool === "vector" || tool === "line" || tool === "arrow" || tool === "text" || tool === "slice";
}

/** A creation tool is deliberately one-shot, matching the editor's selection-first flow. */
export function toolAfterLayerCreated(tool: ToolKind): ToolKind {
  return isCreationTool(tool) ? "select" : tool;
}
