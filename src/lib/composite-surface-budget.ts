import { admitEffectSurfacePool, type EffectSurfaceAdmission } from "./effect-surface-budget";
import { MAX_EFFECT_SURFACE_BYTES, MAX_EFFECT_SURFACE_FRAME_BYTES } from "./effect-surface-budget";

/**
 * Charges a new Canvas compositing pool against every persistent offscreen
 * RGBA surface already retained by the frame. Individual mask/effect limits
 * still apply before this shared peak check.
 */
export function admitCompositeSurfaceAllocation(
  pixelWidth: number,
  pixelHeight: number,
  allocatedSurfaces: number,
  additionalSurfaces: number,
): EffectSurfaceAdmission {
  if (![allocatedSurfaces, additionalSurfaces].every(Number.isSafeInteger)
    || allocatedSurfaces < 0
    || additionalSurfaces < 1) {
    return { accepted: false, reason: "invalidDimensions" };
  }
  return admitEffectSurfacePool(
    pixelWidth,
    pixelHeight,
    allocatedSurfaces + additionalSurfaces,
  );
}

/** Charges a variably-sized pool against already admitted RGBA8 bytes. */
export function admitCompositeSurfaceBytes(
  allocatedBytes: number,
  pixelWidth: number,
  pixelHeight: number,
  surfaceCount: number,
): EffectSurfaceAdmission {
  if (![allocatedBytes, pixelWidth, pixelHeight, surfaceCount].every(Number.isSafeInteger)
    || allocatedBytes < 0
    || pixelWidth < 1
    || pixelHeight < 1
    || surfaceCount < 1) return { accepted: false, reason: "invalidDimensions" };
  const bytesPerSurface = pixelWidth * pixelHeight * 4;
  if (!Number.isSafeInteger(bytesPerSurface) || bytesPerSurface > MAX_EFFECT_SURFACE_BYTES)
    return { accepted: false, reason: "surfaceLimit" };
  const totalBytes = allocatedBytes + bytesPerSurface * surfaceCount;
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_EFFECT_SURFACE_FRAME_BYTES)
    return { accepted: false, reason: "frameLimit" };
  return { accepted: true, bytesPerSurface, totalBytes };
}
