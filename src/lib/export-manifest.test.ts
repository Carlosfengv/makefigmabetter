import { describe, expect, it } from "vitest";
import { buildExportManifest, buildPdfExportManifestSet, exportTransparency } from "./export-manifest";
import type { SvgExportResult } from "./svg-export";

const result = (sourceRevision = 42, fallbacks: SvgExportResult["compatibilityFallbacks"] = []): SvgExportResult => ({
  svg: "<svg/>", width: 40, height: 20, sourceRevision, warnings: ["visible fallback"], compatibilityFallbacks: fallbacks,
});

describe("export compatibility manifest", () => {
  it("records a frozen target, requested format, color fallback and transparent output", () => {
    const manifest = buildExportManifest(result(42, [{ nodeId: "shape", capability: "display-p3", outcome: "fallback", reason: "P3" }]), {
      target: { pageId: "page", nodeIds: ["shape"] }, formatRequested: "png", background: "transparent",
    });

    expect(manifest).toMatchObject({ sourceRevision: 42, target: { pageId: "page", nodeIds: ["shape"] }, formatRequested: "png", colorProfile: "display-p3-fallback", transparency: "preserved" });
  });

  it("always records PDF rasterization at the manifest boundary, including a transparent alpha-soft-mask delivery", () => {
    const manifest = buildExportManifest(result(42), {
      target: { pageId: "page", nodeIds: ["shape"] }, formatRequested: "pdf", background: "transparent",
    });

    expect(manifest.fallbacks).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: "shape", capability: "pdf-rasterization", outcome: "fallback" }),
    ]));
    expect(manifest.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("alpha soft mask"),
    ]));
  });

  it("normalizes PDF matte and retains each page target in canonical input order from one frozen revision", () => {
    const manifest = buildPdfExportManifestSet([
      { id: "p-a", name: "A", result: result(7), target: { pageId: "p-a" } },
      { id: "p-b", name: "B", result: result(7), target: { pageId: "p-b" } },
    ], "#Aa11Ff");

    expect(exportTransparency("not-a-color")).toEqual({ matte: "#ffffff" });
    expect(manifest).toMatchObject({ formatRequested: "pdf", sourceRevision: 7, transparency: { matte: "#aa11ff" }, targets: [{ id: "p-a", target: { pageId: "p-a" } }, { id: "p-b", target: { pageId: "p-b" } }] });
  });

  it("keeps one per-target PDF rasterization record in a multi-target artifact sidecar", () => {
    const manifest = buildPdfExportManifestSet([
      { id: "slice-a", name: "Slice A", result: result(9, [{ nodeId: "slice-a", capability: "pdf-rasterization", outcome: "fallback", reason: "Raster PDF" }]), target: { pageId: "page", sliceId: "slice-a" } },
      { id: "slice-b", name: "Slice B", result: result(9, [{ nodeId: "slice-b", capability: "pdf-rasterization", outcome: "fallback", reason: "Raster PDF" }]), target: { pageId: "page", sliceId: "slice-b" } },
    ]);

    expect(manifest).toMatchObject({
      sourceRevision: 9,
      targets: [
        { id: "slice-a", target: { pageId: "page", sliceId: "slice-a" }, fallbacks: [expect.objectContaining({ nodeId: "slice-a", capability: "pdf-rasterization" })] },
        { id: "slice-b", target: { pageId: "page", sliceId: "slice-b" }, fallbacks: [expect.objectContaining({ nodeId: "slice-b", capability: "pdf-rasterization" })] },
      ],
    });
  });

  it("rejects a multi-page artifact assembled from more than one source revision", () => {
    expect(() => buildPdfExportManifestSet([
      { id: "p-a", name: "A", result: result(7), target: { pageId: "p-a" } },
      { id: "p-b", name: "B", result: result(8), target: { pageId: "p-b" } },
    ])).toThrow("PDF_EXPORT_REVISION_MISMATCH");
  });
});
