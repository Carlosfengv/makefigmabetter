import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createNode, type CanvasNode, type DocumentTextProperties } from "./editor-protocol";
import { createPhase2ProfessionalCompositeFixture } from "./phase2-professional-composite-fixture";
import { hasMissingRustTextGlyph, parseRustTextLayout } from "./rust-text-layout";
import { textFrozenLayoutFace, textSvgLayoutInput } from "./text-svg-layout-input";

const assetId = "00000000-0000-4000-8000-0000000000f1";
const font = { assetId, faceIndex: 0, variationAxes: [{ tag: "wght", value: 400 }] };

function node(properties: DocumentTextProperties): CanvasNode {
  return {
    ...createNode("text", 0, 0), width: 160, text: "Design", textProperties: properties,
  };
}

function run(start: number, end: number, patch: Partial<DocumentTextProperties["runs"][number]> = {}) {
  return { start, end, font, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0, ...patch };
}

const paragraph = { alignment: "left" as const, lineHeight: 20, paragraphSpacing: 0 };
const fontBytes = new Map([[assetId, new ArrayBuffer(4)]]);

describe("textSvgLayoutInput", () => {
  it("freezes contiguous paint-only style runs with one shared face and metrics", () => {
    const input = textSvgLayoutInput(node({
      runs: [run(0, 3, { color: { space: "srgb", components: [1, 0, 0], alpha: 1 } }), run(3, 6, { color: { space: "srgb", components: [0, 0, 1], alpha: 1 } })],
      paragraph, autoSize: "fixed", fallbackFonts: [],
    }), fontBytes);

    expect(input).toMatchObject({ source: "Design", faceIndex: 0, fontSize: 16, axes: '[{"tag":"wght","value":400}]' });
  });

  it("keeps a browser fallback when any run can change line advances", () => {
    const changedWeight = textSvgLayoutInput(node({ runs: [run(0, 3), run(3, 6, { fontWeight: 700 })], paragraph, autoSize: "fixed", fallbackFonts: [] }), fontBytes);
    const gappedRanges = textSvgLayoutInput(node({ runs: [run(0, 2), run(3, 6)], paragraph, autoSize: "fixed", fallbackFonts: [] }), fontBytes);
    const syntheticWeight = textSvgLayoutInput(node({ runs: [run(0, 6, { fontWeight: 700 })], paragraph, autoSize: "fixed", fallbackFonts: [] }), fontBytes);
    const syntheticItalic = textSvgLayoutInput(node({ runs: [run(0, 6, { italic: true })], paragraph, autoSize: "fixed", fallbackFonts: [] }), fontBytes);
    const tracking = textSvgLayoutInput(node({ runs: [run(0, 6, { letterSpacing: .25 })], paragraph, autoSize: "fixed", fallbackFonts: [] }), fontBytes);

    expect(changedWeight).toBeUndefined();
    expect(gappedRanges).toBeUndefined();
    expect(syntheticWeight).toBeUndefined();
    expect(syntheticItalic).toBeUndefined();
    expect(tracking).toBeUndefined();
  });

  it("keeps a browser fallback for an otherwise default-style document-font node", () => {
    const fallbackOnly = node({
      runs: [], paragraph, autoSize: "fixed", fallbackFonts: [font],
    });

    expect(textFrozenLayoutFace(fallbackOnly)).toBeUndefined();
    expect(textSvgLayoutInput(fallbackOnly, fontBytes)).toBeUndefined();
  });

  it("uses a fallback face for contiguous default-font runs with a shared metric style", () => {
    const fallbackRuns = node({
      runs: [
        { start: 0, end: 3, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 },
        { start: 3, end: 6, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0, color: { space: "srgb", components: [0, 0, 1], alpha: 1 } },
      ],
      paragraph, autoSize: "fixed", fallbackFonts: [font],
    });

    expect(textFrozenLayoutFace(fallbackRuns)).toMatchObject({ font, fontSize: 16 });
  });

  it("shapes an explicit regular fallback-font run through the real Rust/WASM boundary", async () => {
    const fixture = createPhase2ProfessionalCompositeFixture();
    const embedded = fixture.assets.find((asset) => asset.mediaType === "font/ttf" && asset.bytesBase64);
    if (!embedded?.bytesBase64) throw new Error("Professional fixture is missing its embedded font");
    const bytes = Uint8Array.from(atob(embedded.bytesBase64), (character) => character.charCodeAt(0));
    const fallback = { assetId: embedded.assetId, faceIndex: 0 };
    const fallbackNode = node({ runs: [{ start: 0, end: 6, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 }], paragraph, autoSize: "fixed", fallbackFonts: [fallback] });
    const input = textSvgLayoutInput(fallbackNode, new Map([[embedded.assetId, bytes.buffer]]));
    if (!input) throw new Error("Fallback font did not produce a frozen layout input");
    const wasm = await import("../wasm/generated/editor_wasm");
    wasm.initSync(readFileSync(new URL("../wasm/generated/editor_wasm_bg.wasm", import.meta.url)));
    const layout = parseRustTextLayout(
      wasm.layout_shaped_text_with_variations_json(new Uint8Array(input.fontBytes), input.faceIndex, input.axes, input.source, fallbackNode.width / input.fontSize),
      input.source,
    );

    expect(layout?.lines).toHaveLength(1);
    expect(layout && hasMissingRustTextGlyph(layout)).toBe(false);
  });
});
