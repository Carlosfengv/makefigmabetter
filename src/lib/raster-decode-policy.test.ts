import { describe, expect, it } from "vitest";
import { MAX_RASTER_DECODED_BYTES } from "./untrusted-asset";
import { declaredRasterAlpha, declaredRasterColorProfile, decodedRasterByteLength, dimensionsMatchAfterOrientation, jpegExifOrientation, rasterDecodeOptions } from "./raster-decode-policy";

describe("isolated raster decode policy", () => {
  it("normalizes orientation and colors while bounding a decoded proxy", () => {
    expect(rasterDecodeOptions({ width: 400, height: 200 })).toMatchObject({
      imageOrientation: "from-image",
      colorSpaceConversion: "default",
      premultiplyAlpha: "none",
    });
    const options = rasterDecodeOptions({ width: 16_384, height: 16_384 });
    expect(options?.resizeWidth).toBeLessThan(16_384);
    expect(options?.resizeHeight).toBeLessThan(16_384);
    expect((options?.resizeWidth ?? 0) * (options?.resizeHeight ?? 0) * 4).toBeLessThanOrEqual(MAX_RASTER_DECODED_BYTES);
  });

  it("accepts EXIF quarter-turn dimensions but never an oversized decoded bitmap", () => {
    expect(dimensionsMatchAfterOrientation({ width: 160, height: 100 }, { width: 100, height: 160 }, 6)).toBe(true);
    expect(dimensionsMatchAfterOrientation({ width: 160, height: 100 }, { width: 100, height: 160 }, 1)).toBe(false);
    expect(decodedRasterByteLength({ width: 100, height: 160 })).toBe(64_000);
    expect(decodedRasterByteLength({ width: 16_384, height: 16_384 })).toBeUndefined();
  });

  it("scales a large image to the caller's visible-image cache share", () => {
    const options = rasterDecodeOptions({ width: 12_000, height: 8_000 }, 16 * 1024 * 1024);
    expect(options?.resizeWidth).toBeDefined();
    expect((options?.resizeWidth ?? 0) * (options?.resizeHeight ?? 0) * 4).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  it("extracts bounded EXIF orientation and declarative alpha without a raster decode", () => {
    const exif = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
      0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00,
      0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
    ]);
    expect(jpegExifOrientation(exif)).toBe(6);
    const pngWithAlpha = new Uint8Array(29);
    pngWithAlpha.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    pngWithAlpha.set([0x49, 0x48, 0x44, 0x52], 12);
    pngWithAlpha[25] = 6;
    expect(declaredRasterAlpha("image/png", pngWithAlpha)).toBe("present");
    expect(declaredRasterAlpha("image/jpeg", exif)).toBe("opaque");
  });

  it("records only bounded source color-profile declarations before normalizing decoded pixels", () => {
    const pngWithIcc = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x00, 0x69, 0x43, 0x43, 0x50,
      0x00, 0x00, 0x00, 0x00,
    ]);
    const pngWithSrgb = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x00, 0x73, 0x52, 0x47, 0x42,
      0x00, 0x00, 0x00, 0x00,
    ]);
    const jpegWithIcc = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe2, 0x00, 0x10,
      0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00,
      0xff, 0xd9,
    ]);
    expect(declaredRasterColorProfile("image/png", pngWithIcc)).toBe("embedded-icc");
    expect(declaredRasterColorProfile("image/png", pngWithSrgb)).toBe("srgb");
    expect(declaredRasterColorProfile("image/jpeg", jpegWithIcc)).toBe("embedded-icc");
    expect(declaredRasterColorProfile("image/webp", new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBe("unknown");
  });
});
