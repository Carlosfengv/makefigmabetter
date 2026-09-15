import type { CanvasNode, ConstraintType, DocumentConstraints } from "./editor-protocol";
import { mixedSelectionValue, type MixedSelectionValue } from "./mixed-selection";

const UNSUPPORTED_CONSTRAINT_KINDS = new Set<CanvasNode["kind"]>(["group", "booleanOperation", "section", "slide"]);

export const DEFAULT_CONSTRAINTS: DocumentConstraints = Object.freeze({
  horizontal: "min",
  vertical: "min",
});

export function effectiveConstraints(node: Pick<CanvasNode, "constraints">): DocumentConstraints {
  return node.constraints ?? DEFAULT_CONSTRAINTS;
}

export type ConstraintSelectionValue = ConstraintType;
export type ConstraintSelection = Readonly<{
  horizontal: MixedSelectionValue<ConstraintSelectionValue>;
  vertical: MixedSelectionValue<ConstraintSelectionValue>;
}>;

/** Wire-level absence is a legacy encoding of Figma's MIN/MIN default. The
 * Inspector must never expose it as a second user-visible constraint state. */
export function constraintSelection(nodes: readonly CanvasNode[]): ConstraintSelection | undefined {
  if (!nodes.length || !nodes.every((node) => !UNSUPPORTED_CONSTRAINT_KINDS.has(node.kind))) return undefined;
  const axis = (node: CanvasNode, key: "horizontal" | "vertical"): ConstraintSelectionValue => effectiveConstraints(node)[key];
  return {
    horizontal: mixedSelectionValue(nodes.map((node) => axis(node, "horizontal"))),
    vertical: mixedSelectionValue(nodes.map((node) => axis(node, "vertical"))),
  };
}
