/** Effect buffers are device-sized rasters. Every composition must explicitly
 * restore the destination DPR before drawing them at their logical size;
 * pooled contexts can otherwise still have their initial identity transform. */
export function compositeEffectSurface(
  destination: OffscreenCanvasRenderingContext2D,
  source: OffscreenCanvas,
  surface: Readonly<{ width: number; height: number; dpr: number }>,
  mode: GlobalCompositeOperation = "source-over",
) {
  destination.save();
  try {
    destination.setTransform(surface.dpr, 0, 0, surface.dpr, 0, 0);
    destination.globalCompositeOperation = mode;
    destination.drawImage(source, 0, 0, surface.width, surface.height);
  } finally {
    destination.restore();
  }
}
