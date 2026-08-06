import type { StrokeCap } from "./editor-protocol";

export type LineStrokeOutlinePiece =
  | Readonly<{ kind: "rect"; x: number; y: number; width: number; height: number }>
  | Readonly<{ kind: "circle"; x: number; y: number; radius: number }>;

/**
 * Builds the non-dashed Line stroke as a union of simple filled primitives.
 * Canvas `lineCap` can apply only one value to both ends, while Figma Line
 * stores two independent caps. Markers are rendered separately because they
 * have their own geometry and paint treatment.
 */
export function solidLineStrokeOutline(
  width: number,
  strokeWidth: number,
  startCap: StrokeCap | undefined,
  endCap: StrokeCap | undefined,
): readonly LineStrokeOutlinePiece[] {
  const lineWidth = Math.max(0, Number.isFinite(strokeWidth) ? strokeWidth : 0);
  const lineLength = Math.max(0, Number.isFinite(width) ? width : 0);
  if (lineWidth <= 0) return [];
  const half = lineWidth / 2;
  const pieces: LineStrokeOutlinePiece[] = [{ kind: "rect", x: 0, y: -half, width: lineLength, height: lineWidth }];
  const appendCap = (cap: StrokeCap | undefined, endpoint: number, direction: -1 | 1) => {
    if (cap === "round") pieces.push({ kind: "circle", x: endpoint, y: 0, radius: half });
    if (cap === "square") pieces.push({ kind: "rect", x: direction < 0 ? endpoint - half : endpoint, y: -half, width: half, height: lineWidth });
  };
  appendCap(startCap, 0, -1);
  appendCap(endCap, lineLength, 1);
  return pieces;
}

/**
 * Serializes the same filled-union model that Canvas consumes for SVG export.
 * Keeping this here prevents the two renderers from independently deciding
 * how asymmetric round and square caps extend a Line.
 */
export function solidLineStrokeOutlinePath(
  width: number,
  strokeWidth: number,
  startCap: StrokeCap | undefined,
  endCap: StrokeCap | undefined,
  format: (value: number) => string = svgNumber,
) {
  return solidLineStrokeOutline(width, strokeWidth, startCap, endCap).map((piece) => {
    if (piece.kind === "rect") {
      const right = piece.x + piece.width;
      const bottom = piece.y + piece.height;
      return `M ${format(piece.x)} ${format(piece.y)} H ${format(right)} V ${format(bottom)} H ${format(piece.x)} Z`;
    }
    const left = piece.x - piece.radius;
    const right = piece.x + piece.radius;
    const radius = format(piece.radius);
    return `M ${format(left)} 0 A ${radius} ${radius} 0 1 0 ${format(right)} 0 A ${radius} ${radius} 0 1 0 ${format(left)} 0 Z`;
  }).join(" ");
}

function svgNumber(value: number) {
  if (!Number.isFinite(value)) return "0";
  const nearestInteger = Math.round(value);
  const normalized = Math.abs(value - nearestInteger) <= 1e-12 ? nearestInteger : value;
  return String(Object.is(normalized, -0) ? 0 : normalized);
}
