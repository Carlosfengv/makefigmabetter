import type { CanvasNode } from "./editor-protocol";

type EllipseArc = NonNullable<CanvasNode["arcData"]>;

/**
 * Arc/Donut Stroke alignment is intentionally limited to Inside. When a full
 * Ellipse becomes an Arc, include the compatibility reset in the same
 * appearance update so the Core never observes an invalid intermediate state.
 */
export function ellipseArcUpdatePatch(
  node: Pick<CanvasNode, "arcData" | "strokeAlign">,
  patch: Partial<EllipseArc>,
): Pick<CanvasNode, "arcData" | "strokeAlign"> {
  const arc: EllipseArc = { startingAngle: 0, endingAngle: 360, innerRadius: 0, ...node.arcData, ...patch };
  return node.strokeAlign === "center" || node.strokeAlign === "outside"
    ? { arcData: arc, strokeAlign: "inside" }
    : { arcData: arc };
}
