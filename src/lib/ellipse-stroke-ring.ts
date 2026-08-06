import type { CanvasNode } from "./editor-protocol";

export type EllipseStrokeRing = Readonly<{
  outerRx: number;
  outerRy: number;
  innerRx?: number;
  innerRy?: number;
}>;

/** Returns the filled-paint ring for full Ellipse Inside/Outside Stroke. */
export function ellipseStrokeRing(width: number, height: number, strokeWidth: number, align: CanvasNode["strokeAlign"] = "inside"): EllipseStrokeRing | undefined {
  if (align === "center") return undefined;
  const rx = Math.max(0, width / 2);
  const ry = Math.max(0, height / 2);
  const safeStroke = Math.max(0, Number.isFinite(strokeWidth) ? strokeWidth : 0);
  if (align === "outside") return { outerRx: rx + safeStroke, outerRy: ry + safeStroke, innerRx: rx, innerRy: ry };
  const inset = Math.min(safeStroke, rx, ry);
  const innerRx = rx - inset;
  const innerRy = ry - inset;
  return innerRx > 0 && innerRy > 0
    ? { outerRx: rx, outerRy: ry, innerRx, innerRy }
    : { outerRx: rx, outerRy: ry };
}
