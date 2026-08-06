import type { CanvasNode, ConstraintType } from "./editor-protocol";
import { mixedSelectionValue, type MixedSelectionValue } from "./mixed-selection";

export type ConstraintSelectionValue = "none" | ConstraintType;
export type ConstraintSelection = Readonly<{
  horizontal: MixedSelectionValue<ConstraintSelectionValue>;
  vertical: MixedSelectionValue<ConstraintSelectionValue>;
  hasExplicitConstraints: boolean;
}>;

/** Constraints are durable on every drawable node except Group and Section.
 * `none` remains distinct from explicit Min because it preserves legacy
 * no-constraint behavior until the user chooses a concrete constraint. */
export function constraintSelection(nodes: readonly CanvasNode[]): ConstraintSelection | undefined {
  if (!nodes.length || !nodes.every((node) => node.kind !== "group" && node.kind !== "section")) return undefined;
  const axis = (node: CanvasNode, key: "horizontal" | "vertical"): ConstraintSelectionValue => node.constraints?.[key] ?? "none";
  return {
    horizontal: mixedSelectionValue(nodes.map((node) => axis(node, "horizontal"))),
    vertical: mixedSelectionValue(nodes.map((node) => axis(node, "vertical"))),
    hasExplicitConstraints: nodes.some((node) => Boolean(node.constraints)),
  };
}
