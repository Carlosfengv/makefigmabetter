export type AssetKind = "svg" | "raster-image" | "font";
export type AssetRejection = "INVALID_SIZE" | "INVALID_DIMENSIONS" | "RESOURCE_LIMIT" | "UNSUPPORTED_MIME" | "MIME_MISMATCH" | "UNSAFE_SVG" | "MISSING_SVG_SOURCE" | "MISSING_RASTER_DIMENSIONS" | "CORRUPT_DATA";

export interface UntrustedAssetCandidate {
  kind: AssetKind;
  declaredMime: string;
  detectedMime: string;
  byteLength: number;
  /** Required only for SVG, after UTF-8 decoding in an isolated parser worker. */
  svgSource?: string;
  /** Required for raster images after an isolated header probe, before decode. */
  rasterDimensions?: { width: number; height: number };
}

export type AssetAdmission = { accepted: true; mime: string } | { accepted: false; reason: AssetRejection };

const MAX_BYTES: Readonly<Record<AssetKind, number>> = {
  svg: 1 * 1024 * 1024,
  "raster-image": 80 * 1024 * 1024,
  font: 32 * 1024 * 1024,
};

/** These are parser-admission limits, not rendering support claims. */
export const MAX_SVG_ELEMENTS = 20_000;
export const MAX_SVG_NESTING = 64;
export const MAX_RASTER_DIMENSION = 16_384;
export const MAX_RASTER_PIXELS = 64 * 1024 * 1024;
export const MAX_RASTER_DECODED_BYTES = 256 * 1024 * 1024;

const MIMES: Readonly<Record<AssetKind, readonly string[]>> = {
  svg: ["image/svg+xml"],
  // Phase 0 only has bounded dimension probes for these three containers.
  "raster-image": ["image/png", "image/jpeg", "image/webp"],
  font: ["font/woff2", "font/woff", "font/ttf", "font/otf"],
};

/**
 * Admission guard for a future isolated asset parser. The browser-provided MIME is
 * never enough: the parser must provide a detected MIME and SVG source is rejected
 * before it reaches a DOM, canvas, document Snapshot, or export process.
 */
export function admitUntrustedAsset(candidate: UntrustedAssetCandidate): AssetAdmission {
  const sizeRejection = checkUntrustedAssetByteLength(candidate.kind, candidate.byteLength);
  if (sizeRejection) return { accepted: false, reason: sizeRejection };
  const declared = normalizeMime(candidate.declaredMime);
  const detected = normalizeMime(candidate.detectedMime);
  if (!MIMES[candidate.kind].includes(detected)) return { accepted: false, reason: "UNSUPPORTED_MIME" };
  if (declared !== detected) return { accepted: false, reason: "MIME_MISMATCH" };
  if (candidate.kind === "raster-image") {
    const rasterAdmission = admitRasterDimensions(candidate.rasterDimensions);
    if (!rasterAdmission.accepted) return rasterAdmission;
  }
  if (candidate.kind === "svg") {
    if (typeof candidate.svgSource !== "string") return { accepted: false, reason: "MISSING_SVG_SOURCE" };
    // `byteLength` originates from the isolated decoder, but source text is still
    // untrusted. Bound it independently before any structural walk.
    if (candidate.svgSource.length > MAX_BYTES.svg || utf8ByteLength(candidate.svgSource) > MAX_BYTES.svg) {
      return { accepted: false, reason: "RESOURCE_LIMIT" };
    }
    if (containsActiveSvgContent(candidate.svgSource)) return { accepted: false, reason: "UNSAFE_SVG" };
    if (!hasSvgRoot(candidate.svgSource)) return { accepted: false, reason: "CORRUPT_DATA" };
    if (!hasSafeSvgStructure(candidate.svgSource)) return { accepted: false, reason: "RESOURCE_LIMIT" };
  }
  return { accepted: true, mime: detected };
}

/** Performs allocation-free size admission before a probe decodes SVG text. */
export function checkUntrustedAssetByteLength(kind: AssetKind, byteLength: number): Extract<AssetRejection, "INVALID_SIZE" | "RESOURCE_LIMIT"> | undefined {
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) return "INVALID_SIZE";
  return byteLength > MAX_BYTES[kind] ? "RESOURCE_LIMIT" : undefined;
}

/**
 * Header dimensions are verified before any image decoder, Canvas, or GPU upload
 * allocates pixels. The RGBA8 estimate is intentionally conservative for this
 * admission boundary; real decoders must retain their own cancellation path.
 */
function admitRasterDimensions(dimensions: UntrustedAssetCandidate["rasterDimensions"]): AssetAdmission {
  if (!dimensions) return { accepted: false, reason: "MISSING_RASTER_DIMENSIONS" };
  const { width, height } = dimensions;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    return { accepted: false, reason: "INVALID_DIMENSIONS" };
  }
  const pixels = width * height;
  const decodedBytes = pixels * 4;
  if (width > MAX_RASTER_DIMENSION || height > MAX_RASTER_DIMENSION || !Number.isSafeInteger(pixels) || !Number.isSafeInteger(decodedBytes) || pixels > MAX_RASTER_PIXELS || decodedBytes > MAX_RASTER_DECODED_BYTES) {
    return { accepted: false, reason: "RESOURCE_LIMIT" };
  }
  return { accepted: true, mime: "" };
}

function normalizeMime(value: string): string { return value.trim().toLowerCase().split(";", 1)[0] ?? ""; }

/** Accepts an optional BOM/XML declaration, followed by an actual SVG root. */
export function hasSvgRoot(source: string): boolean {
  return /^\uFEFF?\s*(?:<\?xml\s+[^>]*>\s*)?<svg(?:\s|\/?>)/i.test(source);
}

function containsActiveSvgContent(source: string): boolean {
  if (/<\s*(?:script|foreignobject|iframe|object|embed|style|animate(?:motion|transform)?|set)\b|\bon[a-z]+\s*=|<!\s*(?:doctype|entity)\b/i.test(source)) return true;
  if (hasNonFragmentSvgReference(source)) return true;
  return hasNonFragmentSvgPaintUrl(source);
}

/**
 * Static Phase 0 SVG accepts only local fragment references such as `href="#id"`.
 * That rejects network, JavaScript and data URLs before a browser/XML parser can
 * interpret them, while retaining local gradients and `<use>` definitions.
 */
function hasNonFragmentSvgReference(source: string): boolean {
  const references = /\b(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of source.matchAll(references)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!value.startsWith("#")) return true;
  }
  return false;
}

/** Allows paint/clip/filter URL references only when they point at the same SVG. */
function hasNonFragmentSvgPaintUrl(source: string): boolean {
  const urls = /\burl\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)/gi;
  for (const match of source.matchAll(urls)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!value.startsWith("#")) return true;
  }
  return false;
}

function utf8ByteLength(source: string): number {
  return new TextEncoder().encode(source).byteLength;
}

/**
 * A tiny token walk used only to impose resource limits before an isolated XML
 * parser runs. It deliberately does not interpret SVG semantics. Quoted `>`
 * characters are skipped so an attribute cannot desynchronise the depth count.
 */
function hasSafeSvgStructure(source: string): boolean {
  let offset = 0;
  let depth = 0;
  let elements = 0;
  const names: string[] = [];

  while (offset < source.length) {
    const start = source.indexOf("<", offset);
    if (start < 0) break;
    if (source.startsWith("<!--", start)) {
      const end = source.indexOf("-->", start + 4);
      if (end < 0) return false;
      offset = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", start)) {
      const end = source.indexOf("]]>", start + 9);
      if (end < 0) return false;
      offset = end + 3;
      continue;
    }

    const end = tagEnd(source, start + 1);
    if (end < 0) return false;
    const token = source.slice(start, end + 1);
    offset = end + 1;
    if (/^<\s*[!?]/.test(token)) continue;

    const match = /^<\s*(\/)?\s*([A-Za-z][\w:.-]*)(?:\s|\/?>)/.exec(token);
    if (!match) return false;
    const closing = Boolean(match[1]);
    const name = match[2].toLowerCase();
    if (closing) {
      if (names.pop() !== name) return false;
      depth -= 1;
      continue;
    }

    elements += 1;
    if (elements > MAX_SVG_ELEMENTS) return false;
    if (/\/\s*>$/.test(token)) continue;
    names.push(name);
    depth += 1;
    if (depth > MAX_SVG_NESTING) return false;
  }

  return names.length === 0;
}

function tagEnd(source: string, offset: number): number {
  let quote: "'" | '"' | undefined;
  for (let index = offset; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === ">") return index;
  }
  return -1;
}
