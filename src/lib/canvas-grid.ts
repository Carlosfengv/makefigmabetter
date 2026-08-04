export const CANVAS_GRID_UNIT = 1;
export const MIN_VISIBLE_GRID_GAP = 4;
export const GRID_VISIBILITY_ZOOM = 4;
/** Matches Figma's 2% lower zoom limit. */
export const MIN_CANVAS_ZOOM = 0.02;
/** Matches Figma's 25,600% upper zoom limit. */
export const MAX_CANVAS_ZOOM = 256;

/** Snapping applies to direct canvas manipulation, not explicit Inspector values. */
export function snapToCanvasGrid(value: number, unit = CANVAS_GRID_UNIT): number {
  if (!Number.isFinite(value) || !Number.isFinite(unit) || unit <= 0) return value;
  const snapped = Math.round(Math.abs(value) / unit) * unit;
  return value < 0 ? -snapped : snapped;
}

export function snapCanvasPoint(point: { x: number; y: number }, unit = CANVAS_GRID_UNIT) {
  return { x: snapToCanvasGrid(point.x, unit), y: snapToCanvasGrid(point.y, unit) };
}

/**
 * The grid's coordinate unit is always one canvas pixel. At lower zoom levels
 * we only render a coarser 1/2/5 × 10ⁿ subset so adjacent visible lines never
 * collapse into sub-pixel noise. The canvas draws this overlay only above 400%
 * zoom, where every 1px line is visible again.
 */
export function resolveVisibleCanvasGridStep(zoom: number, minimumScreenGap = MIN_VISIBLE_GRID_GAP): number {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const minimumWorldGap = Math.max(CANVAS_GRID_UNIT, minimumScreenGap / safeZoom);
  const exponent = Math.floor(Math.log10(minimumWorldGap));
  for (let power = Math.max(0, exponent - 1); power <= exponent + 2; power += 1) {
    const scale = 10 ** power;
    for (const multiplier of [1, 2, 5]) {
      const step = multiplier * scale;
      if (step >= minimumWorldGap) return step;
    }
  }
  return 10 ** Math.max(0, exponent + 3);
}

/** The grid is a precision overlay, not a low-zoom canvas backdrop. */
export function shouldRenderCanvasGrid(zoom: number): boolean {
  return Number.isFinite(zoom) && zoom > GRID_VISIBILITY_ZOOM;
}

export function clampCanvasZoom(zoom: number): number {
  return Math.max(MIN_CANVAS_ZOOM, Math.min(MAX_CANVAS_ZOOM, zoom));
}
