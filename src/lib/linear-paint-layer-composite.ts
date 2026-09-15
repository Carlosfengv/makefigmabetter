import type { CompositeSurfaceWindow } from "./composite-surface-window";
import { compositeLinearBlendRgba, type LinearBlendMode } from "./linear-blend-composite";

export type RelativeCompositePixelWindow = Readonly<{
  pixelX: number;
  pixelY: number;
  pixelWidth: number;
  pixelHeight: number;
}>;

/** Maps a screen-space readback window into the current cropped destination. */
export function relativeCompositePixelWindow(
  globalWindow: Pick<CompositeSurfaceWindow, "pixelX" | "pixelY" | "pixelWidth" | "pixelHeight">,
  destinationWindow: Pick<CompositeSurfaceWindow, "pixelX" | "pixelY"> | undefined,
  canvasWidth: number,
  canvasHeight: number,
): RelativeCompositePixelWindow | undefined {
  if (![globalWindow.pixelX, globalWindow.pixelY, globalWindow.pixelWidth, globalWindow.pixelHeight, canvasWidth, canvasHeight]
    .every(Number.isSafeInteger)
    || globalWindow.pixelWidth < 1
    || globalWindow.pixelHeight < 1
    || canvasWidth < 1
    || canvasHeight < 1) return undefined;
  const localX = globalWindow.pixelX - (destinationWindow?.pixelX ?? 0);
  const localY = globalWindow.pixelY - (destinationWindow?.pixelY ?? 0);
  const pixelX = Math.max(0, localX);
  const pixelY = Math.max(0, localY);
  const pixelRight = Math.min(canvasWidth, localX + globalWindow.pixelWidth);
  const pixelBottom = Math.min(canvasHeight, localY + globalWindow.pixelHeight);
  const pixelWidth = pixelRight - pixelX;
  const pixelHeight = pixelBottom - pixelY;
  return pixelWidth > 0 && pixelHeight > 0
    ? { pixelX, pixelY, pixelWidth, pixelHeight }
    : undefined;
}

/**
 * Captures a bounded backdrop, renders one paint layer into the same context
 * so the current path and clip remain authoritative, then applies the exact
 * Linear Burn/Dodge source-over equation to the captured pixels.
 */
export function compositeLinearPaintLayer(
  context: OffscreenCanvasRenderingContext2D,
  globalWindow: Pick<CompositeSurfaceWindow, "pixelX" | "pixelY" | "pixelWidth" | "pixelHeight">,
  destinationWindow: Pick<CompositeSurfaceWindow, "pixelX" | "pixelY"> | undefined,
  mode: LinearBlendMode,
  opacity: number,
  draw: () => void,
  recordReadbackBytes?: (bytes: number) => void,
): boolean {
  const window = relativeCompositePixelWindow(
    globalWindow,
    destinationWindow,
    context.canvas.width,
    context.canvas.height,
  );
  if (!window) return true;

  const { pixelX, pixelY, pixelWidth, pixelHeight } = window;
  let backdrop: ImageData | undefined;
  let backdropRestored = false;
  context.save();
  try {
    backdrop = context.getImageData(pixelX, pixelY, pixelWidth, pixelHeight);
    recordReadbackBytes?.(pixelWidth * pixelHeight * 4);
    context.putImageData(context.createImageData(pixelWidth, pixelHeight), pixelX, pixelY);
    context.globalCompositeOperation = "source-over";
    draw();
    const source = context.getImageData(pixelX, pixelY, pixelWidth, pixelHeight);
    recordReadbackBytes?.(pixelWidth * pixelHeight * 4);
    context.putImageData(backdrop, pixelX, pixelY);
    backdropRestored = true;
    compositeLinearBlendRgba(backdrop.data, source.data, mode, opacity);
    context.putImageData(backdrop, pixelX, pixelY);
    return true;
  } catch {
    if (backdrop && !backdropRestored) {
      try { context.putImageData(backdrop, pixelX, pixelY); } catch { /* Preserve the original failure contract. */ }
    }
    return false;
  } finally {
    context.restore();
  }
}
