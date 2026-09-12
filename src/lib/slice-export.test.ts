import { describe, expect, it } from "vitest";
import { admitSliceRasterBatch, admitSliceRasterExport, MAX_SLICE_EXPORT_PIXELS, pdfExportBackgroundColor, pdfFromJpeg, pdfFromJpegs, pdfFromRgbaPages, sliceExportBackgroundColor, SliceExportError } from "./slice-export";

describe("Slice export budget", () => {
  it("admits bounded raster regions and reports exact backing-store cost", () => {
    expect(admitSliceRasterExport(320, 180, 2)).toEqual({ accepted: true, width: 640, height: 360, pixelCount: 230_400, rgbaBytes: 921_600 });
  });

  it("rejects unsafe scale, dimensions and backing-store sizes before allocating canvas memory", () => {
    expect(admitSliceRasterExport(1, 1, 0)).toEqual({ accepted: false, reason: "INVALID_SIZE" });
    expect(admitSliceRasterExport(16_385, 1)).toEqual({ accepted: false, reason: "RESOURCE_LIMIT" });
    expect(admitSliceRasterExport(MAX_SLICE_EXPORT_PIXELS, 2)).toEqual({ accepted: false, reason: "RESOURCE_LIMIT" });
  });

  it("bounds a batch by its aggregate frozen region before any raster job begins", () => {
    expect(admitSliceRasterBatch([{ width: 100, height: 100 }, { width: 200, height: 50 }])).toMatchObject({ accepted: true, pixelCount: 20_000 });
    expect(admitSliceRasterBatch([{ width: 8_192, height: 8_192 }, { width: 1, height: 1 }])).toEqual({ accepted: false, reason: "RESOURCE_LIMIT" });
  });

  it("keeps transparent PNGs transparent while allowing a normalized explicit matte", () => {
    expect(sliceExportBackgroundColor("transparent")).toBeUndefined();
    expect(sliceExportBackgroundColor("white")).toBe("#ffffff");
    expect(sliceExportBackgroundColor("#Aa11Ff")).toBe("#aa11ff");
    expect(sliceExportBackgroundColor("#bad" as `#${string}`)).toBe("#ffffff");
    expect(pdfExportBackgroundColor("#Aa11Ff")).toBe("#aa11ff");
    expect(pdfExportBackgroundColor("transparent")).toBeUndefined();
  });
});

describe("Slice PDF encoding", () => {
  it("writes lossless RGBA PDF pages with a PDF 1.4 alpha soft mask", async () => {
    const source = new TextDecoder().decode(await (await pdfFromRgbaPages([{
      rgba: Uint8ClampedArray.from([255, 0, 0, 0, 0, 64, 255, 255]),
      pageWidth: 20,
      pageHeight: 10,
      imageWidth: 2,
      imageHeight: 1,
    }])).arrayBuffer());

    expect(source).toContain("%PDF-1.4");
    expect(source).toContain("/MediaBox [0 0 20 10]");
    expect(source).toContain("/ColorSpace /DeviceRGB");
    expect(source).toContain("/ColorSpace /DeviceGray");
    expect(source).toContain("/SMask 6 0 R");
    expect(source).toContain("/Filter /FlateDecode");
  });

  it("writes a single-page PDF 1.4 container with a JPEG image stream", async () => {
    const pdf = await pdfFromJpeg(new Blob([Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)], { type: "image/jpeg" }), 100, 80, 200, 160);
    const source = new TextDecoder().decode(await pdf.arrayBuffer());

    expect(pdf.type).toBe("application/pdf");
    expect(source).toContain("%PDF-1.4");
    expect(source).toContain("/MediaBox [0 0 100 80]");
    expect(source).toContain("/Filter /DCTDecode");
    expect(source).toContain("xref\n0 6");
  });

  it("creates one PDF page per selected Slice while preserving each page size", async () => {
    const jpeg = new Blob([Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)], { type: "image/jpeg" });
    const source = new TextDecoder().decode(await (await pdfFromJpegs([
      { jpeg, pageWidth: 100, pageHeight: 80, imageWidth: 200, imageHeight: 160 },
      { jpeg, pageWidth: 60, pageHeight: 40, imageWidth: 120, imageHeight: 80 },
    ])).arrayBuffer());

    expect(source).toContain("/Count 2");
    expect(source).toContain("/MediaBox [0 0 100 80]");
    expect(source).toContain("/MediaBox [0 0 60 40]");
  });

  it("applies the aggregate raster budget even when PDF encoding is called directly", async () => {
    const jpeg = new Blob([Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)], { type: "image/jpeg" });
    await expect(pdfFromJpegs([
      { jpeg, pageWidth: 8_192, pageHeight: 8_192, imageWidth: 8_192, imageHeight: 8_192 },
      { jpeg, pageWidth: 1, pageHeight: 1, imageWidth: 1, imageHeight: 1 },
    ])).rejects.toMatchObject({ code: "RESOURCE_LIMIT" } satisfies Partial<SliceExportError>);
  });

  it("rejects malformed RGBA page data before writing a PDF", async () => {
    await expect(pdfFromRgbaPages([{
      rgba: Uint8ClampedArray.of(0, 0, 0),
      pageWidth: 1,
      pageHeight: 1,
      imageWidth: 1,
      imageHeight: 1,
    }])).rejects.toMatchObject({ code: "INVALID_SIZE" } satisfies Partial<SliceExportError>);
  });

  it("rejects data that is not a JPEG instead of emitting a malformed PDF", async () => {
    await expect(pdfFromJpeg(new Blob([Uint8Array.of(1, 2, 3, 4)], { type: "image/jpeg" }), 100, 80, 100, 80)).rejects.toMatchObject({ code: "RASTERIZATION_FAILED" } satisfies Partial<SliceExportError>);
  });
});
