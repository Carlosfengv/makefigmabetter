import type { WebGpuTextGlyph } from "./webgpu-scene";

export type CanvasTextGlyphBitmap = Readonly<{
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}>;

export type CanvasTextGlyphPose = Readonly<{
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  rotationRadians: number;
  opacity: number;
}>;

export const MAX_CANVAS_TEXT_GLYPH_SURFACE_BYTES = 32 * 1024 * 1024;

/** Returns the exact RGBA cache cost only for dimensions Canvas can safely own. */
export function canvasTextGlyphSurfaceByteLength(
  glyph: Pick<WebGpuTextGlyph, "maskWidth" | "maskHeight">,
): number | undefined {
  const pixelCount = glyph.maskWidth * glyph.maskHeight;
  const bytes = pixelCount * 4;
  if (!Number.isSafeInteger(glyph.maskWidth) || glyph.maskWidth <= 0
    || !Number.isSafeInteger(glyph.maskHeight) || glyph.maskHeight <= 0
    || !Number.isSafeInteger(pixelCount) || pixelCount <= 0
    || !Number.isSafeInteger(bytes) || bytes <= 0
    || bytes > MAX_CANVAS_TEXT_GLYPH_SURFACE_BYTES) return undefined;
  return bytes;
}

/**
 * Converts the Rust raster's straight alpha mask to an unpremultiplied RGBA
 * bitmap. Node/run opacity stays separate so one colored bitmap can be reused
 * by Canvas2D for every occurrence of the same glyph resource.
 */
export function canvasTextGlyphBitmap(
  glyph: Pick<WebGpuTextGlyph, "fill" | "maskWidth" | "maskHeight" | "alphaMask">,
): CanvasTextGlyphBitmap | undefined {
  const color = hexColor(glyph.fill);
  const pixelCount = glyph.maskWidth * glyph.maskHeight;
  if (!color
    || canvasTextGlyphSurfaceByteLength(glyph) === undefined
    || glyph.alphaMask.byteLength !== pixelCount) return undefined;
  const rgba = new Uint8ClampedArray(pixelCount * 4);
  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4;
    rgba[offset] = color.red;
    rgba[offset + 1] = color.green;
    rgba[offset + 2] = color.blue;
    rgba[offset + 3] = Math.round(glyph.alphaMask[index]! * color.alpha);
  }
  return { width: glyph.maskWidth, height: glyph.maskHeight, rgba };
}

/** Maps a world-space glyph quad back into the node-local Canvas transform. */
export function canvasTextGlyphPose(
  glyph: Pick<WebGpuTextGlyph, "x" | "y" | "width" | "height" | "rotation" | "opacity">,
): CanvasTextGlyphPose | undefined {
  if (![glyph.x, glyph.y, glyph.width, glyph.height, glyph.rotation, glyph.opacity].every(Number.isFinite)
    || glyph.width <= 0 || glyph.height <= 0 || glyph.opacity < 0 || glyph.opacity > 1) return undefined;
  return {
    centerX: glyph.x + glyph.width / 2,
    centerY: glyph.y + glyph.height / 2,
    width: glyph.width,
    height: glyph.height,
    rotationRadians: glyph.rotation * Math.PI / 180,
    opacity: glyph.opacity,
  };
}

function hexColor(value: string) {
  if (value === "transparent") return { red: 0, green: 0, blue: 0, alpha: 0 };
  const source = value.startsWith("#") ? value.slice(1) : "";
  const expanded = source.length === 3 || source.length === 4
    ? [...source].map((component) => component + component).join("")
    : source;
  if (!/^[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(expanded)) return undefined;
  return {
    red: Number.parseInt(expanded.slice(0, 2), 16),
    green: Number.parseInt(expanded.slice(2, 4), 16),
    blue: Number.parseInt(expanded.slice(4, 6), 16),
    alpha: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
  };
}
