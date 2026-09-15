import { describe, expect, it } from "vitest";
import { verifyRf06ExportPixels } from "./verify-rf06-export-pixels.mjs";

const evidenceRoot = "verification/remediation/2026-09-13";

describe("RF-06 browser export pixels", () => {
  it("keeps six blend samples and every PNG/PDF RGBA pixel identical after encoding", () => {
    const result = verifyRf06ExportPixels({
      pngPath: `${evidenceRoot}/rf06-professional-composite-export.png`,
      pdfPath: `${evidenceRoot}/rf06-professional-composite-export.pdf`,
      pngSidecarPath: `${evidenceRoot}/rf06-professional-composite-export-png.compatibility.json`,
      pdfSidecarPath: `${evidenceRoot}/rf06-professional-composite-export-pdf.compatibility.json`,
    });

    expect(result).toMatchObject({
      status: "pass",
      dimensions: { width: 992, height: 712, rgbaBytes: 2_825_216 },
      comparison: { matches: true, differentPixels: 0, maximumChannelDelta: 0 },
      sidecars: { accepted: true, sourceRevision: 0 },
    });
    expect(result.blendSamples).toHaveLength(6);
    expect(result.blendSamples.every((sample) => sample.matches)).toBe(true);
    expect(result.png.rgbaSha256).toBe(result.pdf.rgbaSha256);
  });
});
