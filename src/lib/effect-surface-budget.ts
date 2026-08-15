/** Per-surface and per-frame limits from ADR 0031. Effect surfaces are
 * derived Canvas state, never durable document state. */
export const MAX_EFFECT_SURFACE_BYTES = 128 * 1024 * 1024;
export const MAX_EFFECT_SURFACE_FRAME_BYTES = 256 * 1024 * 1024;

export type EffectSurfaceAdmission =
  | { accepted: true; bytesPerSurface: number; totalBytes: number }
  | { accepted: false; reason: "invalidDimensions" | "surfaceLimit" | "frameLimit" };

/** Validates a reusable group of RGBA8 effect canvases before allocation. */
export function admitEffectSurfacePool(pixelWidth: number, pixelHeight: number, surfaceCount: number): EffectSurfaceAdmission {
  if (![pixelWidth, pixelHeight, surfaceCount].every(Number.isSafeInteger) || pixelWidth < 1 || pixelHeight < 1 || surfaceCount < 1) {
    return { accepted: false, reason: "invalidDimensions" };
  }
  const bytesPerSurface = pixelWidth * pixelHeight * 4;
  if (!Number.isSafeInteger(bytesPerSurface) || bytesPerSurface > MAX_EFFECT_SURFACE_BYTES) {
    return { accepted: false, reason: "surfaceLimit" };
  }
  const totalBytes = bytesPerSurface * surfaceCount;
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_EFFECT_SURFACE_FRAME_BYTES) {
    return { accepted: false, reason: "frameLimit" };
  }
  return { accepted: true, bytesPerSurface, totalBytes };
}
