import { createNode, type CanvasNode, type ToolKind, type Viewport } from "./editor-protocol";

export type KeyboardNodeCreateInput = Readonly<{
  tool: ToolKind;
  viewport: Viewport;
  surface: Readonly<{ width: number; height: number }>;
}>;

/**
 * Creates the default node for the active drawing tool at the visible canvas
 * centre.  This deliberately keeps tool selection as a UI concern while the
 * resulting node remains the same canonical node that a pointer gesture uses.
 */
export function createKeyboardToolNode(input: KeyboardNodeCreateInput): CanvasNode | undefined {
  if (input.tool === "select" || input.tool === "hand") return undefined;

  const worldCenter = {
    x: (input.surface.width / 2 - input.surface.width / 2) / input.viewport.zoom - input.viewport.x,
    y: (input.surface.height / 2 - input.surface.height / 2) / input.viewport.zoom - input.viewport.y,
  };
  const node = createNode(input.tool === "arrow" ? "line" : input.tool, worldCenter.x, worldCenter.y);
  node.x -= node.width / 2;
  node.y -= node.height / 2;
  if (input.tool === "arrow") {
    node.name = "Arrow";
    node.strokeCapEnd = "arrowLines";
  }
  return node;
}
