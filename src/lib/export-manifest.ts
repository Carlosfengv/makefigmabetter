import type { SvgCompatibilityFallback, SvgExportResult } from "./svg-export";
import { withPdfRasterizationFallback } from "./export-compatibility";
import type { PdfExportBackground } from "./slice-export";

export type ExportFormat = "svg" | "png" | "pdf";
export type ExportTarget = { pageId: string; nodeIds?: readonly string[]; sliceId?: string };
export type ExportTransparency = "preserved" | { matte: `#${string}` };

export type ExportManifest = {
  format: "makefigma-export-compatibility-v2";
  sourceRevision: number | null;
  target: ExportTarget;
  formatRequested: ExportFormat;
  colorProfile: "srgb" | "display-p3-fallback";
  transparency: ExportTransparency;
  warnings: readonly string[];
  fallbacks: readonly SvgCompatibilityFallback[];
};

export type ExportManifestSet = {
  format: "makefigma-export-compatibility-v2";
  /** One physical PDF is generated from one frozen document snapshot. */
  sourceRevision: number | null;
  formatRequested: "pdf";
  colorProfile: "srgb" | "display-p3-fallback";
  transparency: ExportTransparency;
  warnings: readonly string[];
  targets: ReadonlyArray<ExportManifest & { id: string; name: string }>;
};

export function exportTransparency(background: "transparent" | string = "transparent"): ExportTransparency {
  if (background === "transparent") return "preserved";
  return { matte: (/^#[0-9a-fA-F]{6}$/.test(background) ? background.toLowerCase() : "#ffffff") as `#${string}` };
}

export function buildExportManifest(result: SvgExportResult, input: {
  target: ExportTarget;
  formatRequested: ExportFormat;
  background?: "transparent" | string;
}): ExportManifest {
  // A PDF is always a raster delivery in Phase 2. Keep that claim at the
  // sidecar boundary rather than relying on every UI/export caller to add it.
  // This remains idempotent for callers that already prepared the result.
  const deliveryResult = input.formatRequested === "pdf"
    ? withPdfRasterizationFallback(result, pdfFallbackTargetId(input.target), normalizedPdfBackground(input.background))
    : result;
  return {
    format: "makefigma-export-compatibility-v2",
    sourceRevision: deliveryResult.sourceRevision ?? null,
    target: { ...input.target, ...(input.target.nodeIds ? { nodeIds: [...input.target.nodeIds] } : {}) },
    formatRequested: input.formatRequested,
    colorProfile: deliveryResult.compatibilityFallbacks.some((entry) => entry.capability === "display-p3") ? "display-p3-fallback" : "srgb",
    transparency: exportTransparency(input.background),
    warnings: [...deliveryResult.warnings],
    fallbacks: [...deliveryResult.compatibilityFallbacks],
  };
}

function pdfFallbackTargetId(target: ExportTarget): string {
  if (target.sliceId) return target.sliceId;
  if (target.nodeIds?.length === 1) return target.nodeIds[0]!;
  return target.pageId;
}

function normalizedPdfBackground(background: "transparent" | string | undefined): PdfExportBackground {
  if (background === "transparent" || background === undefined) return "transparent";
  return (/^#[0-9a-fA-F]{6}$/.test(background) ? background.toLowerCase() : "#ffffff") as PdfExportBackground;
}

/** A multipage PDF is one artifact, but every canonical Page remains a
 * separately-addressable export target in its one compatibility sidecar. */
export function buildPdfExportManifestSet(entries: ReadonlyArray<{
  id: string;
  name: string;
  result: SvgExportResult;
  target: ExportTarget;
}>, background: "transparent" | string = "transparent"): ExportManifestSet {
  const sourceRevisions = new Set(entries.map(({ result }) => result.sourceRevision ?? null));
  if (sourceRevisions.size !== 1) {
    throw new Error("PDF_EXPORT_REVISION_MISMATCH");
  }
  const [sourceRevision] = sourceRevisions;
  const targets = entries.map(({ id, name, result, target }) => ({
    id,
    name,
    ...buildExportManifest(result, { target, formatRequested: "pdf", background }),
  }));
  return {
    format: "makefigma-export-compatibility-v2",
    sourceRevision,
    formatRequested: "pdf",
    colorProfile: targets.some((target) => target.colorProfile === "display-p3-fallback") ? "display-p3-fallback" : "srgb",
    transparency: exportTransparency(background),
    warnings: [...new Set(targets.flatMap((target) => target.warnings))],
    targets,
  };
}
