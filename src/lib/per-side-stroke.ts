import type { CanvasNode } from "./editor-protocol";

export type PerSideStrokeCenters = Readonly<{
  topY: number;
  rightX: number;
  bottomY: number;
  leftX: number;
}>;

/**
 * The center line of an independent edge stroke. An Inside stroke must place
 * its full width inside the node—not put its center on the boundary and rely
 * on clipping, which would silently halve the visible weight.
 */
export function perSideStrokeCenters(
  width: number,
  height: number,
  weights: readonly [number, number, number, number],
  align: NonNullable<CanvasNode["strokeAlign"]> = "inside",
): PerSideStrokeCenters {
  const [top, right, bottom, left] = weights.map((value) => Math.max(0, value)) as [number, number, number, number];
  if (align === "outside") {
    return { topY: -top / 2, rightX: width + right / 2, bottomY: height + bottom / 2, leftX: -left / 2 };
  }
  if (align === "inside") {
    return { topY: top / 2, rightX: width - right / 2, bottomY: height - bottom / 2, leftX: left / 2 };
  }
  return { topY: 0, rightX: width, bottomY: height, leftX: 0 };
}
