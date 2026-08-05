import { MAX_RASTER_DECODED_BYTES } from "./untrusted-asset";

export type RasterOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface RasterDimensions {
  width: number;
  height: number;
}

export interface RasterDecodeMetadata {
  source: RasterDimensions;
  decoded: RasterDimensions;
  orientation: "normalized";
  /** Container declaration, retained only as bounded diagnostic metadata. */
  sourceColorProfile: "srgb" | "embedded-icc" | "unknown";
  canonicalColorSpace: "srgb";
  /** Container-declared alpha is retained for deterministic rendering decisions. */
  alpha: "opaque" | "present" | "unknown";
  decodedByteLength: number;
}

/** The isolated decoder always asks the platform to apply EXIF orientation and
 * convert embedded ICC/P3 data to the renderer's canonical sRGB working space. */
export function rasterDecodeOptions(source: RasterDimensions, maxDecodedBytes = MAX_RASTER_DECODED_BYTES): ImageBitmapOptions | undefined {
  const pixels = source.width * source.height;
  const maxPixels = Math.floor(maxDecodedBytes / 4);
  if (!Number.isSafeInteger(maxPixels) || maxPixels <= 0) return undefined;
  if (!Number.isSafeInteger(pixels) || pixels <= maxPixels) {
    return {
      imageOrientation: "from-image",
      colorSpaceConversion: "default",
      premultiplyAlpha: "none",
    };
  }
  const scale = Math.sqrt(maxPixels / pixels);
  return {
    imageOrientation: "from-image",
    colorSpaceConversion: "default",
    premultiplyAlpha: "none",
    resizeWidth: Math.max(1, Math.floor(source.width * scale)),
    resizeHeight: Math.max(1, Math.floor(source.height * scale)),
    resizeQuality: "high",
  };
}

export function decodedRasterByteLength(dimensions: RasterDimensions, maxDecodedBytes = MAX_RASTER_DECODED_BYTES): number | undefined {
  const bytes = dimensions.width * dimensions.height * 4;
  return Number.isSafeInteger(bytes) && bytes > 0 && bytes <= maxDecodedBytes ? bytes : undefined;
}

export function dimensionsMatchAfterOrientation(
  expected: RasterDimensions,
  actual: RasterDimensions,
  orientation: RasterOrientation = 1,
): boolean {
  const swapped = orientation >= 5;
  return swapped
    ? actual.width === expected.height && actual.height === expected.width
    : actual.width === expected.width && actual.height === expected.height;
}

/** Reads the bounded APP1 EXIF record without attempting a JPEG decode. */
export function jpegExifOrientation(bytes: Uint8Array): RasterOrientation {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9 || marker === undefined) return 1;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    const length = readBe16(bytes, offset);
    const dataStart = offset + 2;
    const next = offset + length;
    if (length < 2 || next > bytes.length) return 1;
    if (marker === 0xe1 && asciiAt(bytes, dataStart, "Exif\0\0")) {
      return readExifOrientation(bytes, dataStart + 6);
    }
    offset = next;
  }
  return 1;
}

/** The value is declarative rather than a full pixel scan; decoded pixels still
 * use non-premultiplied alpha to keep the renderer's compositing deterministic. */
export function declaredRasterAlpha(mediaType: string, bytes: Uint8Array): "opaque" | "present" | "unknown" {
  if (mediaType === "image/jpeg") return "opaque";
  if (mediaType === "image/png") return pngAlpha(bytes);
  if (mediaType === "image/webp") {
    if (asciiAt(bytes, 12, "VP8X")) return (bytes[20] ?? 0) & 0x10 ? "present" : "opaque";
    if (asciiAt(bytes, 12, "VP8L")) return (bytes[24] ?? 0) & 0x10 ? "present" : "opaque";
  }
  return "unknown";
}

/**
 * Detects only whether a supported container explicitly declares sRGB or embeds
 * an ICC profile. It never parses profile payloads: the isolated decoder is the
 * sole pixel/color conversion boundary, and all decoded output is normalized to
 * sRGB. Keeping this source marker makes that conversion auditable without
 * persisting untrusted profile bytes in the Document.
 */
export function declaredRasterColorProfile(mediaType: string, bytes: Uint8Array): "srgb" | "embedded-icc" | "unknown" {
  if (mediaType === "image/png") return pngColorProfile(bytes);
  if (mediaType === "image/jpeg") return jpegColorProfile(bytes);
  if (mediaType === "image/webp") return webpColorProfile(bytes);
  return "unknown";
}

function pngAlpha(bytes: Uint8Array): "opaque" | "present" | "unknown" {
  if (!asciiAt(bytes, 12, "IHDR") || bytes.length < 29) return "unknown";
  if (bytes[25] === 4 || bytes[25] === 6) return "present";
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = readBe32(bytes, offset);
    const typeOffset = offset + 4;
    const next = typeOffset + 4 + length + 4;
    if (!Number.isSafeInteger(next) || next > bytes.length) return "unknown";
    if (asciiAt(bytes, typeOffset, "tRNS")) return "present";
    if (asciiAt(bytes, typeOffset, "IDAT") || asciiAt(bytes, typeOffset, "IEND")) return "opaque";
    offset = next;
  }
  return "unknown";
}

function pngColorProfile(bytes: Uint8Array): "srgb" | "embedded-icc" | "unknown" {
  if (!matches(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "unknown";
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = readBe32(bytes, offset);
    const typeOffset = offset + 4;
    const next = typeOffset + 4 + length + 4;
    if (!Number.isSafeInteger(next) || next > bytes.length) return "unknown";
    if (asciiAt(bytes, typeOffset, "iCCP")) return "embedded-icc";
    if (asciiAt(bytes, typeOffset, "sRGB")) return "srgb";
    if (asciiAt(bytes, typeOffset, "IDAT") || asciiAt(bytes, typeOffset, "IEND")) return "unknown";
    offset = next;
  }
  return "unknown";
}

function jpegColorProfile(bytes: Uint8Array): "embedded-icc" | "unknown" {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return "unknown";
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9 || marker === undefined) return "unknown";
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    const length = readBe16(bytes, offset);
    const dataStart = offset + 2;
    const next = offset + length;
    if (length < 2 || next > bytes.length) return "unknown";
    if (marker === 0xe2 && asciiAt(bytes, dataStart, "ICC_PROFILE\0")) return "embedded-icc";
    offset = next;
  }
  return "unknown";
}

function webpColorProfile(bytes: Uint8Array): "embedded-icc" | "unknown" {
  if (!matches(bytes, 0, [0x52, 0x49, 0x46, 0x46]) || !asciiAt(bytes, 8, "WEBP")) return "unknown";
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const length = readLe32(bytes, offset + 4);
    const paddedLength = length + (length & 1);
    const next = offset + 8 + paddedLength;
    if (!Number.isSafeInteger(next) || next > bytes.length) return "unknown";
    if (asciiAt(bytes, offset, "ICCP")) return "embedded-icc";
    offset = next;
  }
  return "unknown";
}

function readExifOrientation(bytes: Uint8Array, tiff: number): RasterOrientation {
  const littleEndian = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  const bigEndian = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d;
  if ((!littleEndian && !bigEndian) || read16(bytes, tiff + 2, littleEndian) !== 42) return 1;
  const ifd = tiff + read32(bytes, tiff + 4, littleEndian);
  if (ifd + 2 > bytes.length) return 1;
  const entries = read16(bytes, ifd, littleEndian);
  for (let index = 0; index < entries; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > bytes.length) return 1;
    if (read16(bytes, entry, littleEndian) !== 0x0112 || read16(bytes, entry + 2, littleEndian) !== 3 || read32(bytes, entry + 4, littleEndian) !== 1) continue;
    const orientation = read16(bytes, entry + 8, littleEndian);
    return orientation >= 1 && orientation <= 8 ? orientation as RasterOrientation : 1;
  }
  return 1;
}

function asciiAt(bytes: Uint8Array, offset: number, expected: string): boolean {
  return [...expected].every((value, index) => bytes[offset + index] === value.charCodeAt(0));
}
function matches(bytes: Uint8Array, offset: number, expected: number[]): boolean { return expected.every((value, index) => bytes[offset + index] === value); }
function readBe16(bytes: Uint8Array, offset: number): number { return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0); }
function readBe32(bytes: Uint8Array, offset: number): number { return ((bytes[offset] ?? 0) * 0x1000000) + (((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)); }
function readLe32(bytes: Uint8Array, offset: number): number { return (bytes[offset] ?? 0) + ((bytes[offset + 1] ?? 0) << 8) + ((bytes[offset + 2] ?? 0) << 16) + ((bytes[offset + 3] ?? 0) * 0x1000000); }
function read16(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  return littleEndian ? ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) : readBe16(bytes, offset);
}
function read32(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  if (!littleEndian) return readBe32(bytes, offset);
  return (bytes[offset] ?? 0) + ((bytes[offset + 1] ?? 0) << 8) + ((bytes[offset + 2] ?? 0) << 16) + ((bytes[offset + 3] ?? 0) * 0x1000000);
}
