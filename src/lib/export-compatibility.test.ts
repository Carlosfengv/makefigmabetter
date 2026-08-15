import { describe, expect, it } from "vitest";
import { withPdfRasterizationFallback } from "./export-compatibility";
import type { SvgExportResult } from "./svg-export";

describe("export compatibility", () => {
  it("records the PDF JPEG fallback once while preserving prior SVG fallbacks", () => {
    const original: SvgExportResult = {
      svg: "<svg/>", width: 40, height: 20,
      warnings: ["Existing SVG fallback"],
      compatibilityFallbacks: [{ nodeId: "image", capability: "image-asset", outcome: "fallback", reason: "Existing SVG fallback" }],
    };

    const once = withPdfRasterizationFallback(original, "slice", "#Aa11Ff");
    const twice = withPdfRasterizationFallback(once, "slice", "#Aa11Ff");

    expect(once).toMatchObject({ svg: original.svg, width: 40, height: 20 });
    expect(once.compatibilityFallbacks).toEqual([
      original.compatibilityFallbacks[0],
      expect.objectContaining({ nodeId: "slice", capability: "pdf-rasterization", outcome: "fallback" }),
    ]);
    expect(once.warnings).toEqual(["Existing SVG fallback", expect.stringContaining("opaque JPEG raster with #aa11ff matte")]);
    expect(twice).toBe(once);
  });
});
