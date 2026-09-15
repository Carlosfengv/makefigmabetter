import type { ConstraintType } from "./editor-protocol";

export type ConstraintAxis = "horizontal" | "vertical";
export type ConstraintEdge = "min" | "center" | "max";

const LABELS: Record<ConstraintAxis, Record<ConstraintType, string>> = {
  horizontal: {
    min: "Left",
    center: "Center",
    max: "Right",
    stretch: "Left & right",
    scale: "Scale",
  },
  vertical: {
    min: "Top",
    center: "Center",
    max: "Bottom",
    stretch: "Top & bottom",
    scale: "Scale",
  },
};

export function constraintAxisLabel(axis: ConstraintAxis, value: ConstraintType): string {
  return LABELS[axis][value];
}

export function constraintSummary(horizontal: ConstraintType, vertical: ConstraintType): string {
  return `${constraintAxisLabel("horizontal", horizontal)} · ${constraintAxisLabel("vertical", vertical)}`;
}

/** Figma's diagram treats Shift as multi-select for the opposing edges. With
 * two selected edges the canonical representation is Stretch; Shift-clicking
 * either selected edge removes only that edge and keeps the other one. */
export function constraintFromDiagramEdge(
  current: ConstraintType,
  edge: ConstraintEdge,
  shiftKey: boolean,
): ConstraintType {
  if (edge === "center") return "center";
  if (!shiftKey) return edge;
  if (current === "stretch") return edge === "min" ? "max" : "min";
  if (current === (edge === "min" ? "max" : "min")) return "stretch";
  return edge;
}

export function constraintEdgeSelected(value: ConstraintType, edge: ConstraintEdge): boolean {
  if (edge === "center") return value === "center";
  return value === edge || value === "stretch";
}
