#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { decodePngRgba } from "./verify-phase2-professional-composite-golden.mjs";

const expectedBlendSamples = [
  { mode: "normal", point: [514, 295], rgba: [96, 165, 250, 255] },
  { mode: "multiply", point: [568, 295], rgba: [92, 102, 11, 255] },
  { mode: "screen", point: [622, 295], rgba: [249, 221, 250, 255] },
  { mode: "overlay", point: [676, 295], rgba: [243, 187, 22, 255] },
  { mode: "darken", point: [730, 295], rgba: [96, 158, 11, 255] },
  { mode: "lighten", point: [784, 295], rgba: [245, 165, 250, 255] },
];

/** Verifies the actual browser-encoded PNG and the lossless RGB + `/SMask`
 * streams stored in the actual PDF. Reading the encoded PDF again is
 * intentional: comparing only the pre-encoding RGBA page would not catch a
 * broken object reference, stream length or channel split in the PDF writer. */
export function verifyRf06ExportPixels({ pngPath, pdfPath, pngSidecarPath, pdfSidecarPath, root = process.cwd() }) {
  try {
    const pngBytes = readFileSync(resolve(root, pngPath));
    const pdfBytes = readFileSync(resolve(root, pdfPath));
    const png = decodePngRgba(pngBytes);
    const pdf = decodeLosslessPdfRgba(pdfBytes);
    if (png.width !== 992 || png.height !== 712 || pdf.width !== png.width || pdf.height !== png.height)
      return failed("DIMENSION_MISMATCH", { png: dimensions(png), pdf: dimensions(pdf) });

    const comparison = compareExactRgba(png.pixels, pdf.pixels);
    if (!comparison.matches) return failed("PNG_PDF_PIXEL_MISMATCH", { png: dimensions(png), pdf: dimensions(pdf), comparison });

    const blendSamples = expectedBlendSamples.map((sample) => {
      const actual = pixelAt(png, sample.point[0], sample.point[1]);
      return { ...sample, actual, matches: sameBytes(actual, sample.rgba) };
    });
    if (blendSamples.some((sample) => !sample.matches)) return failed("BLEND_SAMPLE_MISMATCH", { blendSamples });

    const pngSidecar = readSidecar(root, pngSidecarPath);
    const pdfSidecar = readSidecar(root, pdfSidecarPath);
    const sidecars = verifySidecars(pngSidecar, pdfSidecar);
    if (!sidecars.accepted) return failed("SIDECAR_MISMATCH", { sidecars });

    return {
      format: "makefigma-rf06-export-pixel-verification-v1",
      status: "pass",
      dimensions: dimensions(png),
      png: { path: pngPath, sha256: sha256(pngBytes), rgbaSha256: sha256(png.pixels) },
      pdf: {
        path: pdfPath,
        sha256: sha256(pdfBytes),
        rgbaSha256: sha256(pdf.pixels),
        version: "1.4",
        imageEncoding: "lossless RGB FlateDecode + DeviceGray alpha SMask",
      },
      comparison,
      blendSamples,
      sidecars,
    };
  } catch (error) {
    return failed("INVALID_EXPORT", { message: error instanceof Error ? error.message : String(error) });
  }
}

function decodeLosslessPdfRgba(bytes) {
  const source = bytes.toString("latin1");
  if (!source.startsWith("%PDF-1.4")) throw new Error("RF-06 PDF must be PDF 1.4");
  const streams = new Map();
  const pattern = /^(\d+) 0 obj\n(<< \/Type \/XObject \/Subtype \/Image [^\n]+ \/Length (\d+) >>)\nstream\n/gm;
  for (const match of source.matchAll(pattern)) {
    const id = Number(match[1]);
    const dictionary = match[2];
    const encodedLength = Number(match[3]);
    const start = match.index + match[0].length;
    if (!dictionary.includes("/BitsPerComponent 8") || !dictionary.includes("/Filter /FlateDecode"))
      throw new Error(`PDF image ${id} is not an 8-bit lossless FlateDecode stream`);
    streams.set(id, { dictionary, bytes: inflateSync(bytes.subarray(start, start + encodedLength)) });
  }
  const rgbEntry = [...streams.entries()].find(([, entry]) => entry.dictionary.includes("/ColorSpace /DeviceRGB"));
  if (!rgbEntry) throw new Error("PDF has no lossless DeviceRGB image");
  const [rgbId, rgbImage] = rgbEntry;
  const width = numberFromDictionary(rgbImage.dictionary, "Width");
  const height = numberFromDictionary(rgbImage.dictionary, "Height");
  const maskId = numberFromDictionary(rgbImage.dictionary, "SMask");
  const alphaImage = streams.get(maskId);
  if (!alphaImage?.dictionary.includes("/ColorSpace /DeviceGray")) throw new Error(`PDF RGB image ${rgbId} has no DeviceGray SMask`);
  if (numberFromDictionary(alphaImage.dictionary, "Width") !== width || numberFromDictionary(alphaImage.dictionary, "Height") !== height)
    throw new Error("PDF RGB and alpha streams have different dimensions");
  if (rgbImage.bytes.length !== width * height * 3 || alphaImage.bytes.length !== width * height)
    throw new Error("PDF image stream length does not match its dimensions");
  if (!source.includes(`/MediaBox [0 0 ${width} ${height}]`)) throw new Error("PDF MediaBox does not match its raster dimensions");
  const pixels = Buffer.alloc(width * height * 4);
  for (let pixel = 0, color = 0, target = 0; pixel < alphaImage.bytes.length; pixel += 1, color += 3, target += 4) {
    pixels[target] = rgbImage.bytes[color];
    pixels[target + 1] = rgbImage.bytes[color + 1];
    pixels[target + 2] = rgbImage.bytes[color + 2];
    pixels[target + 3] = alphaImage.bytes[pixel];
  }
  return { width, height, pixels };
}

function verifySidecars(png, pdf) {
  const pngFallbacks = png.fallbacks ?? [];
  const pdfFallbacks = pdf.fallbacks ?? [];
  const pdfRasterization = pdfFallbacks.find((fallback) => fallback.capability === "pdf-rasterization");
  const pdfSourceFallbacks = pdfFallbacks.filter((fallback) => fallback.capability !== "pdf-rasterization");
  const requiredEffectFallbacks = ["layer-blur", "inner-shadow", "background-blur"];
  const accepted = png.format === "makefigma-export-compatibility-v2"
    && pdf.format === png.format
    && png.sourceRevision === pdf.sourceRevision
    && JSON.stringify(png.target) === JSON.stringify(pdf.target)
    && png.formatRequested === "png" && pdf.formatRequested === "pdf"
    && png.colorProfile === "srgb" && pdf.colorProfile === "srgb"
    && png.transparency === "preserved" && pdf.transparency === "preserved"
    && JSON.stringify(pngFallbacks) === JSON.stringify(pdfSourceFallbacks)
    && requiredEffectFallbacks.every((capability) => pngFallbacks.some((fallback) => fallback.capability === capability))
    && pdfRasterization?.outcome === "fallback";
  return {
    accepted,
    sourceRevision: png.sourceRevision,
    target: png.target,
    commonFallbacks: pngFallbacks.map((fallback) => fallback.capability),
    pdfRasterization: pdfRasterization?.reason,
  };
}

function readSidecar(root, path) {
  const value = JSON.parse(readFileSync(resolve(root, path), "utf8"));
  if (!value || typeof value !== "object") throw new Error(`${path} is not a compatibility sidecar`);
  return value;
}

function compareExactRgba(left, right) {
  if (left.length !== right.length) return { matches: false, differentPixels: Math.max(left.length, right.length) / 4, maximumChannelDelta: 255 };
  let differentPixels = 0;
  let maximumChannelDelta = 0;
  for (let index = 0; index < left.length; index += 4) {
    let different = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(left[index + channel] - right[index + channel]);
      maximumChannelDelta = Math.max(maximumChannelDelta, delta);
      if (delta) different = true;
    }
    if (different) differentPixels += 1;
  }
  return { matches: differentPixels === 0, differentPixels, maximumChannelDelta };
}

function pixelAt(image, x, y) {
  const offset = (y * image.width + x) * 4;
  return [...image.pixels.subarray(offset, offset + 4)];
}

function numberFromDictionary(dictionary, key) {
  const match = dictionary.match(new RegExp(`/${key} (\\d+)`));
  if (!match) throw new Error(`PDF image dictionary has no /${key}`);
  return Number(match[1]);
}

function sameBytes(left, right) { return left.length === right.length && left.every((value, index) => value === right[index]); }
function dimensions(value) { return { width: value.width, height: value.height, rgbaBytes: value.width * value.height * 4 }; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function failed(reason, details) { return { format: "makefigma-rf06-export-pixel-verification-v1", status: "fail", reason, ...details }; }

function parseArgs(args) {
  if (args.length < 4) return undefined;
  const [pngPath, pdfPath, pngSidecarPath, pdfSidecarPath, ...rest] = args;
  let outputPath;
  if (rest.length) {
    if (rest.length !== 2 || rest[0] !== "--output") return undefined;
    outputPath = rest[1];
  }
  return { pngPath, pdfPath, pngSidecarPath, pdfSidecarPath, outputPath };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error(`Usage: node ${dirname(fileURLToPath(import.meta.url))}/verify-rf06-export-pixels.mjs <png> <pdf> <png-sidecar> <pdf-sidecar> [--output <report.json>]`);
    process.exitCode = 64;
  } else {
    const result = verifyRf06ExportPixels(args);
    const payload = `${JSON.stringify(result, null, 2)}\n`;
    if (args.outputPath) writeFileSync(resolve(args.outputPath), payload);
    process.stdout.write(payload);
    if (result.status !== "pass") process.exitCode = 1;
  }
}
