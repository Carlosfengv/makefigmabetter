import { describe, expect, it } from "vitest";
import { probeUntrustedAsset } from "./asset-probe";

const text = new TextEncoder();

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set(text.encode("IHDR"), 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
    height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  ]);
}

function webp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set(text.encode("RIFF"), 0);
  bytes.set(text.encode("WEBPVP8X"), 8);
  const writeU24 = (offset: number, value: number) => {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >> 8) & 0xff;
    bytes[offset + 2] = (value >> 16) & 0xff;
  };
  writeU24(24, width - 1);
  writeU24(27, height - 1);
  return bytes;
}

function probe(kind: "svg" | "raster-image" | "font", declaredMime: string, bytes: Uint8Array) {
  return probeUntrustedAsset({ kind, declaredMime, bytes });
}

describe("untrusted asset probe", () => {
  it("detects bounded PNG, JPEG, and WebP dimensions before any decoder allocation", () => {
    expect(probe("raster-image", "image/png", png(400, 200))).toEqual({ detectedMime: "image/png", admission: { accepted: true, mime: "image/png" } });
    expect(probe("raster-image", "image/jpeg", jpeg(640, 480))).toEqual({ detectedMime: "image/jpeg", admission: { accepted: true, mime: "image/jpeg" } });
    expect(probe("raster-image", "image/webp", webp(320, 240))).toEqual({ detectedMime: "image/webp", admission: { accepted: true, mime: "image/webp" } });
  });

  it("rejects forged, corrupt, and decode-amplified raster input", () => {
    expect(probe("raster-image", "image/jpeg", png(4, 4))).toEqual({ detectedMime: "image/png", admission: { accepted: false, reason: "MIME_MISMATCH" } });
    expect(probe("raster-image", "image/png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toEqual({ detectedMime: "image/png", admission: { accepted: false, reason: "CORRUPT_DATA" } });
    expect(probe("raster-image", "image/png", png(16_385, 1))).toEqual({ detectedMime: "image/png", admission: { accepted: false, reason: "RESOURCE_LIMIT" } });
  });

  it("runs SVG source through strict UTF-8 and DOM-free safety admission", () => {
    const unsafe = text.encode("<svg><script>alert(1)</script></svg>");
    expect(probe("svg", "image/svg+xml", unsafe)).toEqual({ detectedMime: "image/svg+xml", admission: { accepted: false, reason: "UNSAFE_SVG" } });
    expect(probe("svg", "image/svg+xml", text.encode('<svg><path d="M0 0"/></svg>'))).toEqual({ detectedMime: "image/svg+xml", admission: { accepted: true, mime: "image/svg+xml" } });
    expect(probe("svg", "image/svg+xml", text.encode('\uFEFF<?xml version="1.0"?><svg/>'))).toEqual({ detectedMime: "image/svg+xml", admission: { accepted: true, mime: "image/svg+xml" } });
  });

  it("recognizes common font container signatures without opening font tables", () => {
    expect(probe("font", "font/woff2", text.encode("wOF2bounded-font"))).toEqual({ detectedMime: "font/woff2", admission: { accepted: true, mime: "font/woff2" } });
    expect(probe("font", "font/otf", text.encode("OTTObounded-font"))).toEqual({ detectedMime: "font/otf", admission: { accepted: true, mime: "font/otf" } });
  });
});
