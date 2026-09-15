import { createNode, type CanvasNode, type DocumentAsset, type Viewport } from "./editor-protocol";
import { createPhase2ProfessionalCompositeFixture } from "./phase2-professional-composite-fixture";

export type RemediationSyntheticFontStyleFixture = {
  format: "makefigma-remediation-synthetic-font-style-fixture-v1";
  viewport: Viewport;
  assets: Array<DocumentAsset & { bytesBase64?: string; preRegistered?: true }>;
  nodes: CanvasNode[];
};

/** One explicit font face rendered through four deterministic style identities.
 * Reusing glyphs across the runs proves the atlas cannot alias regular, bold,
 * italic and bold-italic alpha masks by font/glyph/size alone. */
export function createRemediationSyntheticFontStyleFixture(): RemediationSyntheticFontStyleFixture {
  const font = createPhase2ProfessionalCompositeFixture().assets.find(
    (asset) => asset.mediaType === "font/ttf" && asset.bytesBase64,
  );
  if (!font?.bytesBase64) throw new Error("Embedded synthetic font fixture is unavailable");
  const text: CanvasNode = {
    ...createNode("text", -300, -40),
    id: "00000000-0000-4000-8000-0000000030c5",
    name: "Synthetic font style GPU text",
    width: 600,
    height: 80,
    fill: "#0f172a",
    text: "DesignDesignDesignDesign",
    textProperties: {
      runs: [
        { start: 0, end: 6, font: { assetId: font.assetId, faceIndex: 0 }, fontSize: 36, fontWeight: 400, italic: false, letterSpacing: 0 },
        { start: 6, end: 12, font: { assetId: font.assetId, faceIndex: 0 }, fontSize: 36, fontWeight: 700, italic: false, letterSpacing: 0 },
        { start: 12, end: 18, font: { assetId: font.assetId, faceIndex: 0 }, fontSize: 36, fontWeight: 400, italic: true, letterSpacing: 0 },
        { start: 18, end: 24, font: { assetId: font.assetId, faceIndex: 0 }, fontSize: 36, fontWeight: 700, italic: true, letterSpacing: 0 },
      ],
      paragraph: { alignment: "left", lineHeight: 52, paragraphSpacing: 0 },
      autoSize: "fixed",
      fallbackFonts: [],
    },
  };
  return {
    format: "makefigma-remediation-synthetic-font-style-fixture-v1",
    viewport: { x: 0, y: 0, zoom: 1 },
    assets: [{ ...font }],
    nodes: [text],
  };
}
