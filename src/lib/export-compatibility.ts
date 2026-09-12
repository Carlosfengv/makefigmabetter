import type { SvgCompatibilityFallback, SvgExportResult } from "./svg-export";
import type { PdfExportBackground } from "./slice-export";

/** Adds a target-format fallback without changing the frozen SVG payload that
 * PNG/PDF rasterization consumes. Duplicate capability records stay stable so
 * a sidecar is predictable even when several export steps report the same
 * limitation. */
export function withExportCompatibilityFallback(result: SvgExportResult, fallback: SvgCompatibilityFallback): SvgExportResult {
  if (result.compatibilityFallbacks.some((entry) => entry.nodeId === fallback.nodeId && entry.capability === fallback.capability)) return result;
  return {
    ...result,
    warnings: [...new Set([...result.warnings, fallback.reason])],
    compatibilityFallbacks: [...result.compatibilityFallbacks, fallback],
  };
}

/** PDF raster output preserves alpha through a PDF 1.4 soft mask when the
 * caller selects a transparent background. It is still an explicit raster
 * fallback, never a claim that the exported PDF retained editable vectors. */
export function withPdfRasterizationFallback(result: SvgExportResult, targetId: string, background: PdfExportBackground = "transparent"): SvgExportResult {
  const surface = background === "transparent"
    ? "with a PDF 1.4 alpha soft mask"
    : `with ${/^#[0-9a-fA-F]{6}$/.test(background) ? background.toLowerCase() : "#ffffff"} matte`;
  return withExportCompatibilityFallback(result, {
    nodeId: targetId,
    capability: "pdf-rasterization",
    outcome: "fallback",
    reason: `PDF fallback for ${targetId}: PDF embeds a lossless RGBA raster ${surface}, not editable vector content.`,
  });
}
