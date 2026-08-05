/** Validated presentation-only output of Rust's explicit-font rasterizer. */
export type RustGlyphRaster = {
  width: number;
  height: number;
  bearingX: number;
  bearingY: number;
  ascent: number;
  advanceX: number;
  alphaMask: Uint8Array;
};

const MAX_GLYPH_DIMENSION = 512;

export function parseRustGlyphRaster(payload: string): RustGlyphRaster | undefined {
  try {
    const value = JSON.parse(payload) as Record<string, unknown>;
    const width = integer(value.width, 1, MAX_GLYPH_DIMENSION);
    const height = integer(value.height, 1, MAX_GLYPH_DIMENSION);
    const bearingX = integer(value.bearingX, -32_768, 32_767);
    const bearingY = integer(value.bearingY, -32_768, 32_767);
    const ascent = integer(value.ascent, -32_768, 32_767);
    const advanceX = integer(value.advanceX, -32_768, 32_767);
    if ([width, height, bearingX, bearingY, ascent, advanceX].some((item) => item === undefined) || !Array.isArray(value.pixels) || value.pixels.length !== width! * height!) return undefined;
    const alphaMask = new Uint8Array(value.pixels.length);
    for (let index = 0; index < value.pixels.length; index += 1) {
      const alpha = integer(value.pixels[index], 0, 255);
      if (alpha === undefined) return undefined;
      alphaMask[index] = alpha;
    }
    return { width: width!, height: height!, bearingX: bearingX!, bearingY: bearingY!, ascent: ascent!, advanceX: advanceX!, alphaMask };
  } catch {
    return undefined;
  }
}

function integer(value: unknown, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined;
}
