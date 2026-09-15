import { createNode, type CanvasNode, type DocumentAsset, type Viewport } from "./editor-protocol";
import { createPhase2ProfessionalCompositeFixture } from "./phase2-professional-composite-fixture";

export type RemediationMultiRunGpuTextFixture = {
  format: "makefigma-remediation-multi-run-gpu-text-fixture-v1";
  viewport: Viewport;
  assets: Array<DocumentAsset & { bytesBase64?: string; preRegistered?: true }>;
  nodes: CanvasNode[];
};

/** Minimal browser fixture for the per-glyph WebGPU font-resource boundary.
 * The second immutable AssetId intentionally reuses the same small Inter font
 * bytes so the fixture stays self-contained while still exercising resource
 * selection, atlas identity and independent raster scale for each Style Run. */
export function createRemediationMultiRunGpuTextFixture(): RemediationMultiRunGpuTextFixture {
  const primary = createPhase2ProfessionalCompositeFixture().assets.find(
    (asset) => asset.mediaType === "font/ttf" && asset.bytesBase64,
  );
  if (!primary?.bytesBase64) throw new Error("Embedded GPU text fixture font is unavailable");
  const secondary = {
    ...primary,
    assetId: "00000000-0000-4000-8000-0000000030f2",
  };
  const text: CanvasNode = {
    ...createNode("text", -220, -60),
    id: "00000000-0000-4000-8000-0000000030c2",
    name: "Per-glyph GPU font resources",
    width: 440,
    height: 120,
    fill: "#0f172a",
    text: "DesignDesign",
    textProperties: {
      runs: [
        { start: 0, end: 6, font: { assetId: primary.assetId, faceIndex: 0 }, fontSize: 24, fontWeight: 400, italic: false, letterSpacing: 0 },
        { start: 6, end: 12, font: { assetId: secondary.assetId, faceIndex: 0 }, fontSize: 48, fontWeight: 400, italic: false, letterSpacing: 0 },
      ],
      paragraph: { alignment: "left", lineHeight: 64, paragraphSpacing: 0 },
      autoSize: "fixed",
      fallbackFonts: [],
    },
  };
  return {
    format: "makefigma-remediation-multi-run-gpu-text-fixture-v1",
    viewport: { x: 0, y: 0, zoom: 1 },
    assets: [{ ...primary }, secondary],
    nodes: [text],
  };
}
