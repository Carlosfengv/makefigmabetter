import type { NodeKind, ToolKind } from "./editor-protocol";

export function isCreationTool(tool: ToolKind): tool is Exclude<NodeKind, "image" | "group"> | "arrow" {
  return tool === "frame" || tool === "section" || tool === "rectangle" || tool === "ellipse" || tool === "line" || tool === "arrow" || tool === "text";
}

/** A creation tool is deliberately one-shot, matching the editor's selection-first flow. */
export function toolAfterLayerCreated(tool: ToolKind): ToolKind {
  return isCreationTool(tool) ? "select" : tool;
}
