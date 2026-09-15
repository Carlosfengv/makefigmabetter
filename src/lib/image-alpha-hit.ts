import type { DocumentImagePaint } from "./editor-protocol";
import {
  imagePaintLayoutBox,
  resolvedImagePaintTransform,
} from "./image-paint-transform";
import { invertAffine, transformPoint } from "./scene-transform";

export type RasterAlpha = Readonly<{
  width: number;
  height: number;
  alpha: Uint8Array | Uint8ClampedArray;
}>;

/** Samples the same fit/fill/crop/tile projection used by Canvas image paint.
 * The input point is in the owning node's local document coordinate space. */
export function imagePaintHasAlphaAtLocalPoint(
  image: DocumentImagePaint,
  nodeWidth: number,
  nodeHeight: number,
  raster: RasterAlpha,
  point: Readonly<{ x: number; y: number }>,
): boolean {
  if (
    !Number.isFinite(nodeWidth) || !Number.isFinite(nodeHeight) || nodeWidth <= 0 || nodeHeight <= 0 ||
    !Number.isSafeInteger(raster.width) || !Number.isSafeInteger(raster.height) || raster.width <= 0 || raster.height <= 0 ||
    raster.alpha.length !== raster.width * raster.height
  ) return false;
  const resolved = resolvedImagePaintTransform(image, nodeWidth, nodeHeight);
  const layout = imagePaintLayoutBox(image, nodeWidth, nodeHeight);
  const inverse = resolved && invertAffine(resolved);
  if (!inverse || !layout) return false;
  const local = transformPoint(inverse, point);
  let pixelX: number;
  let pixelY: number;
  if (image.scaleMode === "tile") {
    pixelX = positiveModulo(local.x, raster.width);
    pixelY = positiveModulo(local.y, raster.height);
  } else {
    const scale = image.scaleMode === "fit"
      ? Math.min(layout.width / raster.width, layout.height / raster.height)
      : Math.max(layout.width / raster.width, layout.height / raster.height);
    if (!Number.isFinite(scale) || scale <= 0) return false;
    const drawWidth = raster.width * scale;
    const drawHeight = raster.height * scale;
    pixelX = (local.x - layout.x - (layout.width - drawWidth) / 2) / scale;
    pixelY = (local.y - layout.y - (layout.height - drawHeight) / 2) / scale;
    if (pixelX < 0 || pixelY < 0 || pixelX >= raster.width || pixelY >= raster.height) return false;
  }
  const x = Math.min(raster.width - 1, Math.floor(pixelX));
  const y = Math.min(raster.height - 1, Math.floor(pixelY));
  return raster.alpha[y * raster.width + x]! > 0;
}

function positiveModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}
