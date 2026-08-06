import type { CanvasNode } from "./editor-protocol";
import { mixedSelectionValue, type MixedSelectionValue } from "./mixed-selection";

export type StrokeWeightSelection = Readonly<{
  top: MixedSelectionValue<number>;
  right: MixedSelectionValue<number>;
  bottom: MixedSelectionValue<number>;
  left: MixedSelectionValue<number>;
  hasExplicitWeights: boolean;
}>;

export function resolvedStrokeWeights(node: Pick<CanvasNode, "strokeWidth" | "strokeWeights">): [number, number, number, number] {
  return node.strokeWeights ?? [node.strokeWidth, node.strokeWidth, node.strokeWidth, node.strokeWidth];
}

/** Only Frame/Rectangle expose independent sides. Resolve each node's legacy
 * uniform width before comparison so `1px` and `[1,1,1,1]` are treated alike. */
export function strokeWeightSelection(nodes: readonly CanvasNode[]): StrokeWeightSelection | undefined {
  if (!nodes.length || !nodes.every((node) => node.kind === "frame" || node.kind === "rectangle")) return undefined;
  const resolved = nodes.map(resolvedStrokeWeights);
  return {
    top: mixedSelectionValue(resolved.map((weights) => weights[0])),
    right: mixedSelectionValue(resolved.map((weights) => weights[1])),
    bottom: mixedSelectionValue(resolved.map((weights) => weights[2])),
    left: mixedSelectionValue(resolved.map((weights) => weights[3])),
    hasExplicitWeights: nodes.some((node) => Boolean(node.strokeWeights)),
  };
}
