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

/** PDF currently embeds an opaque JPEG page for offline portability. Record
 * that explicitly: consumers must not mistake a page or Slice export for a
 * vector or alpha-preserving deliverable. */
export function withPdfRasterizationFallback(result: SvgExportResult, targetId: string, background: PdfExportBackground = "#ffffff"): SvgExportResult {
  const matte = /^#[0-9a-fA-F]{6}$/.test(background) ? background.toLowerCase() : "#ffffff";
  return withExportCompatibilityFallback(result, {
    nodeId: targetId,
    capability: "pdf-rasterization",
    outcome: "fallback",
    reason: `PDF fallback for ${targetId}: PDF embeds an opaque JPEG raster with ${matte} matte, not vector or alpha-preserving content.`,
  });
}
