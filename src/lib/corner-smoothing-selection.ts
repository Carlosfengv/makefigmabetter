import type { CanvasNode } from "./editor-protocol";
import { mixedSelectionValue, type MixedSelectionValue } from "./mixed-selection";

/** Corner smoothing is meaningful only for the shared rounded-rectangle set. */
export function cornerSmoothingSelection(nodes: readonly CanvasNode[]): MixedSelectionValue<number> | undefined {
  if (!nodes.length || !nodes.every((node) => node.kind === "frame" || node.kind === "rectangle" || node.kind === "section")) return undefined;
  return mixedSelectionValue(nodes.map((node) => node.cornerSmoothing ?? 0));
}
