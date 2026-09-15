export const MAX_ALPHA_MASK_NESTING = 2;
export const MAX_ALPHA_MASK_SURFACE_BYTES = 128 * 1024 * 1024;

export type AlphaMaskAdmission =
  | { accepted: true; bytes: number }
  | { accepted: false; reason: "nesting" | "surface"; bytes: number };

/** Bounds the temporary alpha-composition surfaces independently of the main
 * canvas admission. A rejected mask must fail closed in the renderer. */
export function admitAlphaMaskSurface(pixelWidth: number, pixelHeight: number, depth: number): AlphaMaskAdmission {
  // Keep target-run and mask-source RGBA surfaces live together. Painting the
  // source directly into the target would let Paint Stack blend modes replace
  // the final `destination-in` operation.
  const bytes = pixelWidth * pixelHeight * 4 * 2;
  if (!Number.isSafeInteger(pixelWidth) || !Number.isSafeInteger(pixelHeight) || pixelWidth < 1 || pixelHeight < 1 || !Number.isSafeInteger(depth) || depth < 0) return { accepted: false, reason: "surface", bytes: Number.POSITIVE_INFINITY };
  if (depth >= MAX_ALPHA_MASK_NESTING) return { accepted: false, reason: "nesting", bytes };
  if (!Number.isSafeInteger(bytes) || bytes > MAX_ALPHA_MASK_SURFACE_BYTES) return { accepted: false, reason: "surface", bytes };
  return { accepted: true, bytes };
}
