import type { Viewport } from "./editor-protocol";
import { transformPoint, type AffineMatrix, type TransformBounds } from "./scene-transform";

export type CompositeSurfaceWindow = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
  pixelX: number;
  pixelY: number;
  pixelWidth: number;
  pixelHeight: number;
  dpr: number;
}>;

/**
 * Projects a conservative world-space paint envelope into a device-pixel
 * window. Pixel rounding happens before the logical values are derived, so a
 * fractional DPR cannot leave a one-pixel seam at either edge.
 */
export function compositeSurfaceWindowForWorldBounds(
  bounds: TransformBounds,
  viewport: Viewport,
  canvasWidth: number,
  canvasHeight: number,
  dpr: number,
  screenPadding = 0,
  clipToCanvas = true,
): CompositeSurfaceWindow | undefined {
  if (![bounds.left, bounds.top, bounds.right, bounds.bottom, viewport.x, viewport.y, viewport.zoom, canvasWidth, canvasHeight, dpr, screenPadding]
    .every(Number.isFinite)
    || bounds.right < bounds.left
    || bounds.bottom < bounds.top
    || viewport.zoom <= 0
    || canvasWidth <= 0
    || canvasHeight <= 0
    || dpr <= 0
    || screenPadding < 0) return undefined;

  const screenLeft = (bounds.left + viewport.x) * viewport.zoom + canvasWidth / 2 - screenPadding;
  const screenTop = (bounds.top + viewport.y) * viewport.zoom + canvasHeight / 2 - screenPadding;
  const screenRight = (bounds.right + viewport.x) * viewport.zoom + canvasWidth / 2 + screenPadding;
  const screenBottom = (bounds.bottom + viewport.y) * viewport.zoom + canvasHeight / 2 + screenPadding;
  const pixelX = clipToCanvas ? Math.max(0, Math.floor(screenLeft * dpr)) : Math.floor(screenLeft * dpr);
  const pixelY = clipToCanvas ? Math.max(0, Math.floor(screenTop * dpr)) : Math.floor(screenTop * dpr);
  const pixelRight = clipToCanvas
    ? Math.min(Math.ceil(canvasWidth * dpr), Math.ceil(screenRight * dpr))
    : Math.ceil(screenRight * dpr);
  const pixelBottom = clipToCanvas
    ? Math.min(Math.ceil(canvasHeight * dpr), Math.ceil(screenBottom * dpr))
    : Math.ceil(screenBottom * dpr);
  const pixelWidth = pixelRight - pixelX;
  const pixelHeight = pixelBottom - pixelY;
  if (pixelWidth < 1 || pixelHeight < 1) return undefined;
  return {
    x: pixelX / dpr,
    y: pixelY / dpr,
    width: pixelWidth / dpr,
    height: pixelHeight / dpr,
    pixelX,
    pixelY,
    pixelWidth,
    pixelHeight,
    dpr,
  };
}

/** Restores global screen coordinates while targeting a cropped bitmap. */
export function setCompositeSurfaceTransform(
  context: Pick<OffscreenCanvasRenderingContext2D, "setTransform">,
  window: CompositeSurfaceWindow,
) {
  context.setTransform(window.dpr, 0, 0, window.dpr, -window.pixelX, -window.pixelY);
}

/** Projects an existing logical screen window through an occurrence affine.
 * The result is rounded and clipped in device pixels so readback and putback
 * address the exact raster touched by a transformed Canvas draw. */
export function transformedCompositeSurfaceWindow(
  window: CompositeSurfaceWindow,
  matrix: AffineMatrix,
  canvasWidth: number,
  canvasHeight: number,
): CompositeSurfaceWindow | undefined {
  if (![matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f, canvasWidth, canvasHeight]
    .every(Number.isFinite)
    || canvasWidth <= 0
    || canvasHeight <= 0) return undefined;
  const corners = [
    transformPoint(matrix, { x: window.x, y: window.y }),
    transformPoint(matrix, { x: window.x + window.width, y: window.y }),
    transformPoint(matrix, { x: window.x, y: window.y + window.height }),
    transformPoint(matrix, { x: window.x + window.width, y: window.y + window.height }),
  ];
  const pixelX = Math.max(0, Math.floor(Math.min(...corners.map((point) => point.x)) * window.dpr));
  const pixelY = Math.max(0, Math.floor(Math.min(...corners.map((point) => point.y)) * window.dpr));
  const pixelRight = Math.min(
    Math.ceil(canvasWidth * window.dpr),
    Math.ceil(Math.max(...corners.map((point) => point.x)) * window.dpr),
  );
  const pixelBottom = Math.min(
    Math.ceil(canvasHeight * window.dpr),
    Math.ceil(Math.max(...corners.map((point) => point.y)) * window.dpr),
  );
  const pixelWidth = pixelRight - pixelX;
  const pixelHeight = pixelBottom - pixelY;
  return pixelWidth > 0 && pixelHeight > 0
    ? {
        x: pixelX / window.dpr,
        y: pixelY / window.dpr,
        width: pixelWidth / window.dpr,
        height: pixelHeight / window.dpr,
        pixelX,
        pixelY,
        pixelWidth,
        pixelHeight,
        dpr: window.dpr,
      }
    : undefined;
}
