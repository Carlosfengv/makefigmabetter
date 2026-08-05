import { describe, expect, it } from "vitest";
import { admitUntrustedAsset } from "./untrusted-asset";

describe("untrusted asset admission", () => {
  it("accepts a bounded inert SVG only when declared and detected MIME agree", () => {
    expect(admitUntrustedAsset({ kind: "svg", declaredMime: "image/svg+xml; charset=utf-8", detectedMime: "image/svg+xml", byteLength: 64, svgSource: '<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>' })).toEqual({ accepted: true, mime: "image/svg+xml" });
    expect(admitUntrustedAsset({ kind: "svg", declaredMime: "image/svg+xml", detectedMime: "image/svg+xml", byteLength: 64, svgSource: '\uFEFF<?xml version="1.0"?><svg/>' })).toEqual({ accepted: true, mime: "image/svg+xml" });
  });

  it("rejects non-SVG XML at the shared admission boundary", () => {
    expect(admitUntrustedAsset({ kind: "svg", declaredMime: "image/svg+xml", detectedMime: "image/svg+xml", byteLength: 16, svgSource: "<diagram/>" })).toEqual({ accepted: false, reason: "CORRUPT_DATA" });
  });

  it("rejects forged MIME, scripts, event handlers and external SVG references", () => {
    expect(admitUntrustedAsset({ kind: "svg", declaredMime: "image/png", detectedMime: "image/svg+xml", byteLength: 10, svgSource: "<svg/>" })).toEqual({ accepted: false, reason: "MIME_MISMATCH" });
    expect(admitUntrustedAsset({ kind: "svg", declaredMime: "image/svg+xml", detectedMime: "image/svg+xml", byteLength: 30, svgSource: "<svg><script>alert(1)</script></svg>" })).toEqual({ accepted: false, reason: "UNSAFE_SVG" });
    expect(admitUntrustedAsset({ kind: "svg", declaredMime: "image/svg+xml", detectedMime: "image/svg+xml", byteLength: 30, svgSource: '<svg onload="run()"/>' })).toEqual({ accepted: false, reason: "UNSAFE_SVG" });
    expect(admitUntrustedAsset({ kind: "svg", declaredMime: "image/svg+xml", detectedMime: "image/svg+xml", byteLength: 30, svgSource: '<svg><use href="https://evil.invalid/x"/></svg>' })).toEqual({ accepted: false, reason: "UNSAFE_SVG" });
  });

  it("accepts local definitions but rejects active, data, DTD, and non-local paint references", () => {
    const local = '<svg><defs><path id="shape" d="M0 0"/><linearGradient id="paint"/></defs><use href="#shape" fill="url(#paint)"/></svg>';
    expect(admitUntrustedAsset({ kind: "svg", declaredMime: "image/svg+xml", detectedMime: "image/svg+xml", byteLength: local.length, svgSource: local })).toEqual({ accepted: true, mime: "image/svg+xml" });
    for (const source of [
      '<svg><use href="data:image/svg+xml,%3Csvg%3E"/></svg>',
      '<svg><rect fill="url(https://evil.invalid/paint)"/></svg>',
      '<svg><style>path { fill: red }</style></svg>',
      '<!DOCTYPE svg><svg/>',
      '<svg><animate attributeName="x"/></svg>',
    ]) {
      expect(admitUntrustedAsset({ kind: "svg", declaredMime: "image/svg+xml", detectedMime: "image/svg+xml", byteLength: source.length, svgSource: source })).toEqual({ accepted: false, reason: "UNSAFE_SVG" });
    }
  });

  it("rejects hostile sizes before parser or decoder allocation", () => {
    expect(admitUntrustedAsset({ kind: "raster-image", declaredMime: "image/png", detectedMime: "image/png", byteLength: 256 * 1024 * 1024 + 1 })).toEqual({ accepted: false, reason: "RESOURCE_LIMIT" });
    expect(admitUntrustedAsset({ kind: "font", declaredMime: "font/woff2", detectedMime: "font/woff2", byteLength: Number.POSITIVE_INFINITY })).toEqual({ accepted: false, reason: "INVALID_SIZE" });
  });

  it("admits a raster only after bounded header dimensions are available", () => {
    const image = { kind: "raster-image" as const, declaredMime: "image/png", detectedMime: "image/png", byteLength: 2_048, rasterDimensions: { width: 4_096, height: 2_048 } };
    expect(admitUntrustedAsset(image)).toEqual({ accepted: true, mime: "image/png" });
    expect(admitUntrustedAsset({ ...image, rasterDimensions: undefined })).toEqual({ accepted: false, reason: "MISSING_RASTER_DIMENSIONS" });
    expect(admitUntrustedAsset({ ...image, declaredMime: "image/avif", detectedMime: "image/avif" })).toEqual({ accepted: false, reason: "UNSUPPORTED_MIME" });
  });

  it("rejects invalid or unbounded raster dimensions before Canvas allocation", () => {
    const image = { kind: "raster-image" as const, declaredMime: "image/png", detectedMime: "image/png", byteLength: 2_048 };
    expect(admitUntrustedAsset({ ...image, rasterDimensions: { width: 0, height: 1 } })).toEqual({ accepted: false, reason: "INVALID_DIMENSIONS" });
    expect(admitUntrustedAsset({ ...image, rasterDimensions: { width: 16_385, height: 1 } })).toEqual({ accepted: false, reason: "RESOURCE_LIMIT" });
    expect(admitUntrustedAsset({ ...image, rasterDimensions: { width: 8_192, height: 8_193 } })).toEqual({ accepted: true, mime: "image/png" });
    expect(admitUntrustedAsset({ ...image, rasterDimensions: { width: 16_384, height: 16_384 } })).toEqual({ accepted: true, mime: "image/png" });
    expect(admitUntrustedAsset({ ...image, rasterDimensions: { width: 16_384, height: 16_385 } })).toEqual({ accepted: false, reason: "RESOURCE_LIMIT" });
    expect(admitUntrustedAsset({ ...image, rasterDimensions: { width: Number.MAX_SAFE_INTEGER, height: 2 } })).toEqual({ accepted: false, reason: "RESOURCE_LIMIT" });
  });

  it("rejects deep or element-heavy SVG before the isolated parser can exhaust resources", () => {
    const tooDeep = `<svg>${"<g>".repeat(65)}${"</g>".repeat(65)}</svg>`;
    const tooManyElements = `<svg>${"<path/>".repeat(20_001)}</svg>`;
    expect(admitUntrustedAsset({ kind: "svg", declaredMime: "image/svg+xml", detectedMime: "image/svg+xml", byteLength: tooDeep.length, svgSource: tooDeep })).toEqual({ accepted: false, reason: "RESOURCE_LIMIT" });
    expect(admitUntrustedAsset({ kind: "svg", declaredMime: "image/svg+xml", detectedMime: "image/svg+xml", byteLength: tooManyElements.length, svgSource: tooManyElements })).toEqual({ accepted: false, reason: "RESOURCE_LIMIT" });
  });

  it("counts tags safely when a quoted attribute contains a greater-than character", () => {
    const source = '<svg><path aria-label="a > b" d="M0 0"/></svg>';
    expect(admitUntrustedAsset({ kind: "svg", declaredMime: "image/svg+xml", detectedMime: "image/svg+xml", byteLength: source.length, svgSource: source })).toEqual({ accepted: true, mime: "image/svg+xml" });
  });
});
