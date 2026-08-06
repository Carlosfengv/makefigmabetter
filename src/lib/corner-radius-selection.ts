import type { CanvasNode } from "./editor-protocol";
import { mixedSelectionValue, type MixedSelectionValue } from "./mixed-selection";

export type CornerRadiusSelection = Readonly<{
  topLeft: MixedSelectionValue<number>;
  topRight: MixedSelectionValue<number>;
  bottomRight: MixedSelectionValue<number>;
  bottomLeft: MixedSelectionValue<number>;
  hasExplicitRadii: boolean;
}>;

export function resolvedCornerRadii(node: Pick<CanvasNode, "radius" | "cornerRadii">): [number, number, number, number] {
  return node.cornerRadii ?? [node.radius, node.radius, node.radius, node.radius];
}

/** Frame, Rectangle and Section share Figma's four-corner radius model. */
export function cornerRadiusSelection(nodes: readonly CanvasNode[]): CornerRadiusSelection | undefined {
  if (!nodes.length || !nodes.every((node) => node.kind === "frame" || node.kind === "rectangle" || node.kind === "section")) return undefined;
  const resolved = nodes.map(resolvedCornerRadii);
  return {
    topLeft: mixedSelectionValue(resolved.map((radii) => radii[0])),
    topRight: mixedSelectionValue(resolved.map((radii) => radii[1])),
    bottomRight: mixedSelectionValue(resolved.map((radii) => radii[2])),
    bottomLeft: mixedSelectionValue(resolved.map((radii) => radii[3])),
    hasExplicitRadii: nodes.some((node) => Boolean(node.cornerRadii)),
  };
}
