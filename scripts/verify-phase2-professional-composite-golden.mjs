#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const defaultManifest = "verification/phase2/q1-professional-composite-golden-manifest.json";
const pendingMarker = "TO_BE_RECORDED_BY_REVIEWED_CAPTURE";

/**
 * Verifies a reviewer-frozen Q1 screenshot without allowing the capture
 * process to promote its own candidate to a Golden baseline.
 */
export function verifyPhase2ProfessionalCompositeGolden({ capturePath, manifestPath = defaultManifest, diffPath, root = process.cwd() }) {
  const absoluteManifest = resolve(root, manifestPath);
  const absoluteCapture = resolve(root, capturePath);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(absoluteManifest, "utf8"));
  } catch (error) {
    return failed("INVALID_MANIFEST", { manifestPath, message: messageFor(error) });
  }
  if (manifest.format !== "makefigma-golden-manifest-v1" || manifest.fixtureName !== "F-PHASE2-PROFESSIONAL-COMPOSITE" || !Array.isArray(manifest.captures) || manifest.captures.length !== 1) {
    return failed("INVALID_MANIFEST", { manifestPath, message: "expected one F-PHASE2-PROFESSIONAL-COMPOSITE capture" });
  }
  const capture = manifest.captures[0];
  if (!isExpectedCapture(capture)) return failed("INVALID_MANIFEST", { manifestPath, message: "expected the fixed 1440x960 DPR 1 Q1 capture contract" });
  if (!isSha256(manifest.fixtureSha256)) return failed("INVALID_MANIFEST", { manifestPath, message: "fixtureSha256 must be SHA-256" });

  const fixturePath = resolve(root, manifest.fixture);
  if (!existsSync(fixturePath)) return failed("MISSING_FIXTURE", { fixture: manifest.fixture });
  const fixtureSha256 = sha256File(fixturePath);
  if (fixtureSha256 !== manifest.fixtureSha256) return failed("FIXTURE_HASH_MISMATCH", { expected: manifest.fixtureSha256, actual: fixtureSha256 });
  if (!existsSync(absoluteCapture)) return failed("MISSING_CAPTURE", { capturePath });

  const captureSha256 = sha256File(absoluteCapture);
  const base = { fixture: manifest.fixture, fixtureSha256, capture: capturePath, captureSha256, backend: capture.backend, viewport: capture.viewport };
  if (capture.status === "pending-reviewed-baseline" || capture.baselineSha256 === pendingMarker || !existsSync(resolve(root, capture.baseline))) {
    return { status: "pending", reason: "PENDING_REVIEWED_BASELINE", ...base, baseline: capture.baseline };
  }
  if (!isSha256(capture.baselineSha256)) return failed("INVALID_MANIFEST", { ...base, message: "baselineSha256 must be SHA-256" });

  const baselinePath = resolve(root, capture.baseline);
  const baselineSha256 = sha256File(baselinePath);
  if (baselineSha256 !== capture.baselineSha256) return failed("BASELINE_HASH_MISMATCH", { ...base, expected: capture.baselineSha256, actual: baselineSha256 });
  let comparison;
  try {
    comparison = comparePngPixels(readFileSync(baselinePath), readFileSync(absoluteCapture), capture.pixelTolerance);
  } catch (error) {
    return failed("INVALID_PNG", { ...base, baseline: capture.baseline, baselineSha256, message: messageFor(error) });
  }
  if (comparison.width !== capture.viewport.width || comparison.height !== capture.viewport.height
    || comparison.baselineWidth !== undefined && (comparison.baselineWidth !== capture.viewport.width || comparison.baselineHeight !== capture.viewport.height)) {
    const diff = diffPath ? writeGoldenDiff({ baselinePath, capturePath: absoluteCapture, diffPath: resolve(root, diffPath) }) : undefined;
    return failed("GOLDEN_DIMENSIONS_MISMATCH", { ...base, baseline: capture.baseline, baselineSha256, expectedWidth: capture.viewport.width, expectedHeight: capture.viewport.height, pixelDiff: comparison, ...(diff ? { diff } : {}) });
  }
  if (!comparison.matches) {
    const diff = diffPath ? writeGoldenDiff({ baselinePath, capturePath: absoluteCapture, diffPath: resolve(root, diffPath) }) : undefined;
    return failed("GOLDEN_MISMATCH", { ...base, baseline: capture.baseline, baselineSha256, pixelTolerance: capture.pixelTolerance, pixelDiff: comparison, ...(diff ? { diff } : {}) });
  }
  return { status: "pass", ...base, baseline: capture.baseline, baselineSha256, pixelTolerance: capture.pixelTolerance, pixelDiff: comparison };
}

function sha256File(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function isSha256(value) { return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value); }
function messageFor(error) { return error instanceof Error ? error.message : "unreadable manifest"; }
function isExpectedCapture(capture) {
  return capture && capture.id === "phase2-professional-composite-1440x960-dpr1"
    && capture.backend === "WebGPU + Canvas 2D overlay"
    && capture.viewport?.width === 1440
    && capture.viewport?.height === 960
    && capture.viewport?.dpr === 1
    && capture.viewport?.zoom === 1
    && capture.pixelTolerance === 0
    && (capture.status === "pending-reviewed-baseline" || capture.status === "reviewed");
}
function failed(reason, details) { return { status: "fail", reason, ...details }; }

function comparePngPixels(baselineBytes, captureBytes, pixelTolerance) {
  const baseline = decodePngRgba(baselineBytes);
  const capture = decodePngRgba(captureBytes);
  if (baseline.width !== capture.width || baseline.height !== capture.height) {
    return { matches: false, width: capture.width, height: capture.height, baselineWidth: baseline.width, baselineHeight: baseline.height, differentPixels: capture.width * capture.height, maximumChannelDelta: 255 };
  }
  let differentPixels = 0;
  let maximumChannelDelta = 0;
  for (let index = 0; index < baseline.pixels.length; index += 4) {
    let different = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(baseline.pixels[index + channel] - capture.pixels[index + channel]);
      maximumChannelDelta = Math.max(maximumChannelDelta, delta);
      if (delta > pixelTolerance) different = true;
    }
    if (different) differentPixels += 1;
  }
  return { matches: differentPixels === 0, width: capture.width, height: capture.height, differentPixels, maximumChannelDelta };
}

/** Writes a review-friendly image: matching pixels are dimmed baseline pixels;
 * regressions are opaque magenta. It is deliberately derived only after the
 * baseline SHA check and never becomes a source of Golden truth. */
function writeGoldenDiff({ baselinePath, capturePath, diffPath }) {
  const baseline = decodePngRgba(readFileSync(baselinePath));
  const capture = decodePngRgba(readFileSync(capturePath));
  const width = Math.max(baseline.width, capture.width);
  const height = Math.max(baseline.height, capture.height);
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const target = (y * width + x) * 4;
    const baselineIndex = x < baseline.width && y < baseline.height ? (y * baseline.width + x) * 4 : undefined;
    const captureIndex = x < capture.width && y < capture.height ? (y * capture.width + x) * 4 : undefined;
    const changed = baselineIndex === undefined || captureIndex === undefined || [0, 1, 2, 3].some((channel) => baseline.pixels[baselineIndex + channel] !== capture.pixels[captureIndex + channel]);
    if (changed) {
      pixels[target] = 255;
      pixels[target + 1] = 0;
      pixels[target + 2] = 180;
      pixels[target + 3] = 255;
    } else {
      pixels[target] = Math.round(baseline.pixels[baselineIndex] * .22);
      pixels[target + 1] = Math.round(baseline.pixels[baselineIndex + 1] * .22);
      pixels[target + 2] = Math.round(baseline.pixels[baselineIndex + 2] * .22);
      pixels[target + 3] = 255;
    }
  }
  writeFileSync(diffPath, encodeRgbaPng(width, height, pixels));
  return diffPath;
}

function encodeRgbaPng(width, height, pixels) {
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let row = 0; row < height; row += 1) {
    const target = row * (width * 4 + 1);
    scanlines[target] = 0;
    pixels.copy(scanlines, target + 1, row * width * 4, (row + 1) * width * 4);
  }
  const chunk = (type, data) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(data.length, 0);
    header.write(type, 4, 4, "ascii");
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])), 0);
    return Buffer.concat([header, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(scanlines)), chunk("IEND", Buffer.alloc(0))]);
}

const crcTable = (() => {
  const values = new Uint32Array(256);
  for (let index = 0; index < values.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    values[index] = value >>> 0;
  }
  return values;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function decodePngRgba(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < signature.length || !bytes.subarray(0, signature.length).equals(signature)) throw new Error("Golden comparison requires PNG screenshots");
  let offset = signature.length;
  let width;
  let height;
  let colorType;
  const idat = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) throw new Error("Invalid PNG chunk length");
    const data = bytes.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0 || ![2, 6].includes(data[9])) throw new Error("Golden PNG must be non-interlaced 8-bit RGB or RGBA");
      colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset = dataEnd + 4;
  }
  if (!width || !height || colorType === undefined || idat.length === 0) throw new Error("PNG is missing image data");
  if (width * height > 1_382_400) throw new Error("Golden PNG exceeds the fixed 1440x960 capture budget");
  const sourceChannels = colorType === 6 ? 4 : 3;
  const stride = width * sourceChannels;
  const inflated = inflateSync(Buffer.concat(idat));
  if (inflated.length !== height * (stride + 1)) throw new Error("Unexpected PNG scanline length");
  const pixels = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  let cursor = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = inflated[cursor++];
    const filtered = inflated.subarray(cursor, cursor + stride);
    cursor += stride;
    const scanline = Buffer.alloc(stride);
    for (let index = 0; index < stride; index += 1) {
      const left = index >= sourceChannels ? scanline[index - sourceChannels] : 0;
      const up = previous[index];
      const upLeft = index >= sourceChannels ? previous[index - sourceChannels] : 0;
      scanline[index] = unfilterPngByte(filter, filtered[index], left, up, upLeft);
    }
    for (let pixel = 0; pixel < width; pixel += 1) {
      const source = pixel * sourceChannels;
      const target = (row * width + pixel) * 4;
      pixels[target] = scanline[source];
      pixels[target + 1] = scanline[source + 1];
      pixels[target + 2] = scanline[source + 2];
      pixels[target + 3] = sourceChannels === 4 ? scanline[source + 3] : 255;
    }
    previous = scanline;
  }
  return { width, height, pixels };
}

function unfilterPngByte(filter, value, left, up, upLeft) {
  if (filter === 0) return value;
  if (filter === 1) return (value + left) & 0xff;
  if (filter === 2) return (value + up) & 0xff;
  if (filter === 3) return (value + Math.floor((left + up) / 2)) & 0xff;
  if (filter === 4) {
    const predictor = left + up - upLeft;
    const leftDistance = Math.abs(predictor - left);
    const upDistance = Math.abs(predictor - up);
    const upLeftDistance = Math.abs(predictor - upLeft);
    return (value + (leftDistance <= upDistance && leftDistance <= upLeftDistance ? left : upDistance <= upLeftDistance ? up : upLeft)) & 0xff;
  }
  throw new Error(`Unsupported PNG filter ${filter}`);
}

function parseArgs(args) {
  let capturePath;
  let manifestPath = defaultManifest;
  let diffPath;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--manifest") manifestPath = args[++index] ?? "";
    else if (args[index] === "--diff") diffPath = args[++index] ?? "";
    else if (!capturePath) capturePath = args[index];
    else return undefined;
  }
  return capturePath ? { capturePath, manifestPath, diffPath } : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error(`Usage: node ${dirname(fileURLToPath(import.meta.url))}/verify-phase2-professional-composite-golden.mjs <capture.png> [--manifest <manifest.json>] [--diff <diff.png>]`);
    process.exitCode = 64;
  } else {
    const result = verifyPhase2ProfessionalCompositeGolden(args);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === "pass" ? 0 : result.status === "pending" ? 2 : 1;
  }
}
