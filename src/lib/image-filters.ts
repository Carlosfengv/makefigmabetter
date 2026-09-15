import type { DocumentImageFilters } from "./editor-protocol";

export const IMAGE_FILTER_FIELDS = [
  "exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows",
] as const satisfies readonly (keyof DocumentImageFilters)[];

export function imageFiltersAreNeutral(filters: DocumentImageFilters | undefined): boolean {
  return !filters || IMAGE_FILTER_FIELDS.every((field) => (filters[field] ?? 0) === 0);
}

export function imageFiltersKey(filters: DocumentImageFilters): string {
  return IMAGE_FILTER_FIELDS.map((field) => `${field}:${filters[field] ?? 0}`).join(";");
}

/** Applies MakeFigma's deterministic encoded-sRGB adjustment pipeline.
 * Figma publishes field meaning and range but not its shader constants. This
 * formula stays isolated and golden-tested so pixel-oracle constants can be
 * updated without changing persisted document data. Alpha remains unchanged. */
export function applyImageFiltersToRgba(
  rgba: Uint8ClampedArray,
  filters: DocumentImageFilters,
): Uint8ClampedArray {
  const exposure = filters.exposure ?? 0;
  const contrast = filters.contrast ?? 0;
  const saturation = filters.saturation ?? 0;
  const temperature = filters.temperature ?? 0;
  const tint = filters.tint ?? 0;
  const highlights = filters.highlights ?? 0;
  const shadows = filters.shadows ?? 0;
  const exposureScale = 2 ** exposure;
  const contrastScale = 1 + contrast;

  for (let offset = 0; offset < rgba.length; offset += 4) {
    let red = rgba[offset]! / 255;
    let green = rgba[offset + 1]! / 255;
    let blue = rgba[offset + 2]! / 255;
    red = (red * exposureScale - .5) * contrastScale + .5;
    green = (green * exposureScale - .5) * contrastScale + .5;
    blue = (blue * exposureScale - .5) * contrastScale + .5;
    const toneLuminance = luminance(red, green, blue);
    const toneDelta = (highlights * toneLuminance * toneLuminance
      + shadows * (1 - toneLuminance) * (1 - toneLuminance)) * .25;
    red += toneDelta + temperature * .1 + tint * .05;
    green += toneDelta - tint * .1;
    blue += toneDelta - temperature * .1 + tint * .05;
    const colorLuminance = luminance(red, green, blue);
    const saturationScale = 1 + saturation;
    red = colorLuminance + (red - colorLuminance) * saturationScale;
    green = colorLuminance + (green - colorLuminance) * saturationScale;
    blue = colorLuminance + (blue - colorLuminance) * saturationScale;
    rgba[offset] = byte(red);
    rgba[offset + 1] = byte(green);
    rgba[offset + 2] = byte(blue);
  }
  return rgba;
}

function luminance(red: number, green: number, blue: number): number {
  return red * .2126 + green * .7152 + blue * .0722;
}

function byte(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 255);
}
