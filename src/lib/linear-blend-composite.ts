export type LinearBlendMode = "linear-burn" | "linear-dodge";

export function isLinearBlendMode(mode: string | undefined): mode is LinearBlendMode {
  return mode === "linear-burn" || mode === "linear-dodge";
}

export function linearBlendChannel(
  backdrop: number,
  source: number,
  mode: LinearBlendMode,
): number {
  return mode === "linear-dodge"
    ? Math.min(1, backdrop + source)
    : Math.max(0, backdrop + source - 1);
}

/**
 * Applies the W3C source-over blend equation to unpremultiplied sRGB bytes.
 * The blend function is Figma's Linear Dodge/Add or Linear Burn/Subtract;
 * alpha is combined separately so translucent sources do not inherit Canvas
 * `lighter`'s Porter-Duff alpha and clipping behavior.
 */
export function compositeLinearBlendRgba(
  backdrop: Uint8ClampedArray,
  source: Uint8ClampedArray,
  mode: LinearBlendMode,
  opacity = 1,
): void {
  if (backdrop.length !== source.length || backdrop.length % 4 !== 0)
    throw new RangeError("Linear blend buffers must have the same RGBA length.");
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1)
    throw new RangeError("Linear blend opacity must be within [0, 1].");

  for (let offset = 0; offset < backdrop.length; offset += 4) {
    const sourceAlpha = source[offset + 3]! / 255 * opacity;
    if (sourceAlpha === 0) continue;
    const backdropAlpha = backdrop[offset + 3]! / 255;
    const outputAlpha = sourceAlpha + backdropAlpha * (1 - sourceAlpha);
    if (outputAlpha === 0) {
      backdrop[offset] = 0;
      backdrop[offset + 1] = 0;
      backdrop[offset + 2] = 0;
      backdrop[offset + 3] = 0;
      continue;
    }

    for (let channel = 0; channel < 3; channel += 1) {
      const sourceColor = source[offset + channel]! / 255;
      const backdropColor = backdrop[offset + channel]! / 255;
      const blended = linearBlendChannel(backdropColor, sourceColor, mode);
      const premultiplied =
        sourceAlpha * (1 - backdropAlpha) * sourceColor
        + backdropAlpha * (1 - sourceAlpha) * backdropColor
        + sourceAlpha * backdropAlpha * blended;
      backdrop[offset + channel] = Math.round(premultiplied / outputAlpha * 255);
    }
    backdrop[offset + 3] = Math.round(outputAlpha * 255);
  }
}
