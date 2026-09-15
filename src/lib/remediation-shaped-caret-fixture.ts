import { createNode, type CanvasNode, type DocumentAsset, type Viewport } from "./editor-protocol";
import { createPhase2ProfessionalCompositeFixture } from "./phase2-professional-composite-fixture";

export type RemediationShapedCaretFixture = {
  format: "makefigma-remediation-shaped-caret-fixture-v1";
  viewport: Viewport;
  assets: Array<DocumentAsset & { bytesBase64?: string; preRegistered?: true }>;
  nodes: CanvasNode[];
};

/** Minimal explicit-font fixture for pointer-to-caret browser evidence. The
 * embedded Inter subset contains every scalar in `Design`, so no platform
 * fallback can change Rustybuzz advances during the assertion. */
export function createRemediationShapedCaretFixture(): RemediationShapedCaretFixture {
  const font = createPhase2ProfessionalCompositeFixture().assets.find(
    (asset) => asset.mediaType === "font/ttf",
  )!;
  const text: CanvasNode = {
    ...createNode("text", -200, -50),
    id: "00000000-0000-4000-8000-0000000030c1",
    name: "Shaped caret coordinates",
    width: 400,
    height: 100,
    fill: "#0f172a",
    text: "Design",
    textProperties: {
      runs: [{
        start: 0,
        end: 6,
        fontSize: 48,
        fontWeight: 400,
        italic: false,
        letterSpacing: 0,
      }],
      paragraph: { alignment: "center", lineHeight: 60, paragraphSpacing: 0 },
      autoSize: "fixed",
      fallbackFonts: [{ assetId: font.assetId, faceIndex: 0 }],
    },
  };
  return {
    format: "makefigma-remediation-shaped-caret-fixture-v1",
    viewport: { x: 0, y: 0, zoom: 1 },
    assets: [{ ...font }],
    nodes: [text],
  };
}
