import { admitUntrustedAsset, checkUntrustedAssetByteLength, hasSvgRoot, type AssetAdmission, type AssetKind } from "./untrusted-asset";

export interface AssetProbeRequest {
  kind: AssetKind;
  declaredMime: string;
  bytes: Uint8Array;
}

export interface AssetProbeResult {
  detectedMime: string;
  admission: AssetAdmission;
  /** Header-only raster dimensions, safe to persist as Resource Index metadata. */
  rasterDimensions?: { width: number; height: number };
}

/**
 * Bounded, decode-free detector intended for the isolated Asset Probe Worker.
 * It only reads magic/header bytes for raster/font assets; SVG is UTF-8 decoded
 * after the byte guard and is still passed through the DOM-free SVG preflight.
 */
export function probeUntrustedAsset(request: AssetProbeRequest): AssetProbeResult {
  const sizeRejection = checkUntrustedAssetByteLength(request.kind, request.bytes.byteLength);
  if (sizeRejection) return rejected("", sizeRejection);
  const svgPrefix = decodeUtf8(request.bytes.subarray(0, Math.min(request.bytes.length, 1024)));
  if (svgPrefix !== undefined && hasSvgRoot(svgPrefix)) {
    const svgSource = decodeUtf8(request.bytes);
    if (svgSource === undefined) return rejected("image/svg+xml", "CORRUPT_DATA");
    return admitted({ kind: request.kind, declaredMime: request.declaredMime, detectedMime: "image/svg+xml", byteLength: request.bytes.byteLength, svgSource });
  }
  const raster = probeRaster(request.bytes);
  if (raster) {
    if (!raster.dimensions) return rejected(raster.mime, "CORRUPT_DATA");
    return admitted({ kind: request.kind, declaredMime: request.declaredMime, detectedMime: raster.mime, byteLength: request.bytes.byteLength, rasterDimensions: raster.dimensions });
  }
  const fontMime = probeFontMime(request.bytes);
  if (fontMime) return admitted({ kind: request.kind, declaredMime: request.declaredMime, detectedMime: fontMime, byteLength: request.bytes.byteLength });
  return admitted({ kind: request.kind, declaredMime: request.declaredMime, detectedMime: "", byteLength: request.bytes.byteLength });
}

function admitted(candidate: Parameters<typeof admitUntrustedAsset>[0]): AssetProbeResult {
  const admission = admitUntrustedAsset(candidate);
  return { detectedMime: candidate.detectedMime, admission, ...(admission.accepted && candidate.rasterDimensions ? { rasterDimensions: candidate.rasterDimensions } : {}) };
}

function rejected(detectedMime: string, reason: "CORRUPT_DATA" | "INVALID_SIZE" | "RESOURCE_LIMIT"): AssetProbeResult {
  return { detectedMime, admission: { accepted: false, reason } };
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return undefined; }
}

type RasterProbe = { mime: "image/png" | "image/jpeg" | "image/webp"; dimensions?: { width: number; height: number } };

function probeRaster(bytes: Uint8Array): RasterProbe | undefined {
  if (matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: "image/png", dimensions: pngDimensions(bytes) };
  if (matches(bytes, [0xff, 0xd8])) return { mime: "image/jpeg", dimensions: jpegDimensions(bytes) };
  if (matches(bytes, [0x52, 0x49, 0x46, 0x46]) && ascii(bytes, 8, "WEBP")) return { mime: "image/webp", dimensions: webpDimensions(bytes) };
  return undefined;
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (!ascii(bytes, 12, "IHDR") || bytes.length < 24) return undefined;
  return dimensions(readU32(bytes, 16), readU32(bytes, 20));
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  let index = 2;
  while (index + 3 < bytes.length) {
    if (bytes[index] !== 0xff) return undefined;
    while (bytes[index] === 0xff) index += 1;
    const marker = bytes[index];
    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { index += 1; continue; }
    const length = readU16(bytes, index + 1);
    if (length < 2 || index + 1 + length > bytes.length) return undefined;
    // SOF stores precision, then height, then width. The Resource Index records
    // width × height, so preserve the container's actual order here.
    if (isSof(marker)) return dimensions(readU16(bytes, index + 6), readU16(bytes, index + 4));
    index += 1 + length;
  }
  return undefined;
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 30) return undefined;
  if (ascii(bytes, 12, "VP8X")) return dimensions(readLeU24(bytes, 24) + 1, readLeU24(bytes, 27) + 1);
  if (ascii(bytes, 12, "VP8 ") && matches(bytes.subarray(23), [0x9d, 0x01, 0x2a])) return dimensions(readLeU16(bytes, 26) & 0x3fff, readLeU16(bytes, 28) & 0x3fff);
  if (ascii(bytes, 12, "VP8L") && bytes[20] === 0x2f) {
    const width = 1 + bytes[21] + ((bytes[22] & 0x3f) << 8);
    const height = 1 + ((bytes[22] & 0xc0) >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10);
    return dimensions(width, height);
  }
  return undefined;
}

function probeFontMime(bytes: Uint8Array): "font/woff2" | "font/woff" | "font/ttf" | "font/otf" | undefined {
  if (ascii(bytes, 0, "wOF2")) return "font/woff2";
  if (ascii(bytes, 0, "wOFF")) return "font/woff";
  if (ascii(bytes, 0, "OTTO")) return "font/otf";
  return matches(bytes, [0x00, 0x01, 0x00, 0x00]) ? "font/ttf" : undefined;
}

function dimensions(width: number, height: number): { width: number; height: number } | undefined {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 ? { width, height } : undefined;
}
function isSof(marker: number): boolean { return [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker); }
function matches(bytes: Uint8Array, expected: number[]): boolean { return expected.every((value, index) => bytes[index] === value); }
function ascii(bytes: Uint8Array, offset: number, expected: string): boolean { return [...expected].every((value, index) => bytes[offset + index] === value.charCodeAt(0)); }
function readU16(bytes: Uint8Array, offset: number): number { return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0); }
function readLeU16(bytes: Uint8Array, offset: number): number { return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8); }
function readLeU24(bytes: Uint8Array, offset: number): number { return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16); }
function readU32(bytes: Uint8Array, offset: number): number { return ((bytes[offset] ?? 0) * 0x1000000) + (((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)); }
