import type { NodeKind, ToolKind } from "./editor-protocol";

export function isCreationTool(tool: ToolKind): tool is Exclude<NodeKind, "image"> {
  return tool === "frame" || tool === "rectangle" || tool === "ellipse" || tool === "text";
}

/** A creation tool is deliberately one-shot, matching the editor's selection-first flow. */
export function toolAfterLayerCreated(tool: ToolKind): ToolKind {
  return isCreationTool(tool) ? "select" : tool;
}
