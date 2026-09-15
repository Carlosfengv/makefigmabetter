import {
  compositeLinearBlendRgba,
  isLinearBlendMode,
  type LinearBlendMode,
} from "./linear-blend-composite";

/** Effect buffers are device-sized rasters. Every composition must explicitly
 * restore the destination DPR before drawing them at their logical size;
 * pooled contexts can otherwise still have their initial identity transform. */
export function compositeEffectSurface(
  destination: OffscreenCanvasRenderingContext2D,
  source: OffscreenCanvas,
  surface: Readonly<{ x?: number; y?: number; width: number; height: number; dpr: number; pixelWidth?: number; pixelHeight?: number }>,
  mode: GlobalCompositeOperation | LinearBlendMode = "source-over",
  opacity = 1,
  destinationWindow?: Readonly<{ pixelX: number; pixelY: number }>,
  recordReadbackBytes?: (bytes: number) => void,
) {
  destination.save();
  try {
    const x = surface.x ?? 0;
    const y = surface.y ?? 0;
    const pixelWidth = surface.pixelWidth ?? source.width;
    const pixelHeight = surface.pixelHeight ?? source.height;
    if (isLinearBlendMode(mode)) {
      const destinationX = Math.round(x * surface.dpr) - (destinationWindow?.pixelX ?? 0);
      const destinationY = Math.round(y * surface.dpr) - (destinationWindow?.pixelY ?? 0);
      const clippedX = Math.max(0, destinationX);
      const clippedY = Math.max(0, destinationY);
      const sourceX = clippedX - destinationX;
      const sourceY = clippedY - destinationY;
      const width = Math.min(pixelWidth - sourceX, destination.canvas.width - clippedX);
      const height = Math.min(pixelHeight - sourceY, destination.canvas.height - clippedY);
      if (width <= 0 || height <= 0) return true;
      const sourceContext = source.getContext("2d", { willReadFrequently: true });
      if (!sourceContext) return false;
      try {
        const backdrop = destination.getImageData(clippedX, clippedY, width, height);
        recordReadbackBytes?.(width * height * 4);
        const foreground = sourceContext.getImageData(sourceX, sourceY, width, height);
        recordReadbackBytes?.(width * height * 4);
        compositeLinearBlendRgba(backdrop.data, foreground.data, mode, opacity);
        sourceContext.putImageData(backdrop, sourceX, sourceY);
      } catch {
        return false;
      }
      destination.setTransform(1, 0, 0, 1, 0, 0);
      destination.clearRect(clippedX, clippedY, width, height);
      destination.setTransform(
        surface.dpr,
        0,
        0,
        surface.dpr,
        destinationWindow ? -destinationWindow.pixelX : 0,
        destinationWindow ? -destinationWindow.pixelY : 0,
      );
      destination.globalCompositeOperation = "source-over";
      destination.globalAlpha = 1;
      destination.drawImage(
        source,
        sourceX,
        sourceY,
        width,
        height,
        x + sourceX / surface.dpr,
        y + sourceY / surface.dpr,
        width / surface.dpr,
        height / surface.dpr,
      );
      return true;
    }
    destination.setTransform(
      surface.dpr,
      0,
      0,
      surface.dpr,
      destinationWindow ? -destinationWindow.pixelX : 0,
      destinationWindow ? -destinationWindow.pixelY : 0,
    );
    destination.globalCompositeOperation = mode;
    destination.globalAlpha = opacity;
    destination.drawImage(source, 0, 0, pixelWidth, pixelHeight, x, y, surface.width, surface.height);
    return true;
  } finally {
    destination.restore();
  }
}
