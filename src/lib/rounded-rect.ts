export interface RoundedRectGeometry {
  outerRadius: number;
  insideStrokeWidth: number;
  innerX: number;
  innerY: number;
  innerWidth: number;
  innerHeight: number;
  innerRadius: number;
}

/**
 * Resolves the Phase 0 rounded-rectangle contract in screen pixels. The node
 * bounds remain the outer edge; an enabled stroke is fully inside those bounds
 * so resizing cannot make the visible shape grow or let Canvas/WebGPU diverge.
 */
export function resolveInsideRoundedRect(width: number, height: number, radius: number, strokeWidth: number): RoundedRectGeometry {
  const safeWidth = positiveFinite(width);
  const safeHeight = positiveFinite(height);
  const shortestSide = Math.min(safeWidth, safeHeight);
  const outerRadius = clamp(radius, 0, shortestSide / 2);
  const insideStrokeWidth = clamp(strokeWidth, 0, shortestSide / 2);
  const innerWidth = Math.max(0, safeWidth - insideStrokeWidth * 2);
  const innerHeight = Math.max(0, safeHeight - insideStrokeWidth * 2);
  return {
    outerRadius,
    insideStrokeWidth,
    innerX: insideStrokeWidth,
    innerY: insideStrokeWidth,
    innerWidth,
    innerHeight,
    innerRadius: clamp(outerRadius - insideStrokeWidth, 0, Math.min(innerWidth, innerHeight) / 2),
  };
}

function positiveFinite(value: number): number { return Number.isFinite(value) && value > 0 ? value : 0; }
function clamp(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, minimum), maximum) : minimum;
}
