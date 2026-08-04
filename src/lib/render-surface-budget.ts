export const MAX_RENDER_SURFACE_BYTES = 512 * 1024 * 1024;

export type RenderSurfaceAdmission =
  | { accepted: true; bytes: number; pixelWidth: number; pixelHeight: number }
  | { accepted: false; reason: "INVALID_DIMENSIONS" | "RESOURCE_LIMIT" };

/** Estimates an RGBA8 OffscreenCanvas backing store before assigning width/height. */
export function admitRenderSurface(width: number, height: number, dpr: number, budgetBytes = MAX_RENDER_SURFACE_BYTES): RenderSurfaceAdmission {
  if (![width, height, dpr, budgetBytes].every(Number.isFinite) || width < 0 || height < 0 || dpr <= 0 || budgetBytes < 0) return { accepted: false, reason: "INVALID_DIMENSIONS" };
  const pixelWidth = Math.ceil(width * dpr);
  const pixelHeight = Math.ceil(height * dpr);
  const bytes = pixelWidth * pixelHeight * 4;
  if (!Number.isSafeInteger(pixelWidth) || !Number.isSafeInteger(pixelHeight) || !Number.isSafeInteger(bytes) || bytes > budgetBytes) return { accepted: false, reason: "RESOURCE_LIMIT" };
  return { accepted: true, bytes, pixelWidth, pixelHeight };
}
