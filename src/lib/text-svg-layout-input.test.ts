import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createNode, type CanvasNode, type DocumentTextProperties } from "./editor-protocol";
import { createPhase2ProfessionalCompositeFixture } from "./phase2-professional-composite-fixture";
import { hasMissingRustTextGlyph, parseRustTextLayout, remapRustTextLayoutToSource } from "./rust-text-layout";
import { parseTextPathSvgLayoutProjection, parseTextSvgLayoutProjection, textFrozenLayoutFace, textSvgLayoutInput } from "./text-svg-layout-input";

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
  it("admits TextPath into the same contiguous multi-run shaping contract", () => {
    const textPath = {
      ...createNode("textPath", 0, 0),
      width: 160,
      text: "Design",
      textProperties: { runs: [run(0, 6)], paragraph, autoSize: "fixed" as const, fallbackFonts: [] },
    };
    const input = textSvgLayoutInput(textPath, fontBytes);

    expect(input).toMatchObject({ source: "Design", shapingSource: "Design", fontSize: 16 });
    expect(JSON.parse(input!.runsJson)).toHaveLength(1);
  });

  it("retains the single-line Rust advance required by SVG TextPath", () => {
    const input = textSvgLayoutInput({
      ...createNode("textPath", 0, 0), width: 160, text: "AB",
      textProperties: { runs: [run(0, 2)], paragraph, autoSize: "fixed", fallbackFonts: [] },
    }, fontBytes)!;
    const payload = JSON.stringify({
      unitsPerEm: 1_000,
      lines: [{ start: 0, end: 2, direction: "ltr", advance: 1_250, visualRuns: [{ start: 0, end: 2, direction: "ltr" }], glyphs: [
        { glyphId: 7, runIndex: 0, cluster: 0, xAdvance: 625, yAdvance: 0, xOffset: 0, yOffset: 0 },
        { glyphId: 8, runIndex: 0, cluster: 1, xAdvance: 625, yAdvance: 0, xOffset: 0, yOffset: 0 },
      ] }],
    });

    expect(parseTextPathSvgLayoutProjection(payload, input)).toEqual({
      unitsPerEm: 1_000,
      lines: [{ start: 0, end: 2, direction: "ltr", advance: 1_250 }],
    });
  });

  it("freezes contiguous paint-only style runs with one shared face and metrics", () => {
    const input = textSvgLayoutInput(node({
      runs: [run(0, 3, { color: { space: "srgb", components: [1, 0, 0], alpha: 1 } }), run(3, 6, { color: { space: "srgb", components: [0, 0, 1], alpha: 1 } })],
      paragraph, autoSize: "fixed", fallbackFonts: [],
    }), fontBytes);

    expect(input).toMatchObject({ source: "Design", fontSize: 16 });
    expect(JSON.parse(input!.runsJson)).toEqual([
      { start: 0, end: 3, fontOffset: 0, fontLength: 4, faceIndex: 0, variationAxes: [{ tag: "wght", value: 400 }], fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 },
      { start: 3, end: 6, fontOffset: 0, fontLength: 4, faceIndex: 0, variationAxes: [{ tag: "wght", value: 400 }], fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 },
    ]);
  });

  it("admits explicit per-run font sizes while retaining the strict single-face helper", () => {
    const sized = node({
      runs: [run(0, 3, { fontSize: 16 }), run(3, 6, { fontSize: 28 })],
      paragraph, autoSize: "fixed", fallbackFonts: [],
    });

    expect(textFrozenLayoutFace(sized)).toBeUndefined();
    expect(textSvgLayoutInput(sized, fontBytes)).toMatchObject({ source: "Design", fontSize: 16 });
  });

  it("admits PIXELS tracking and bounded synthetic styles while rejecting malformed ranges", () => {
    const changedWeight = textSvgLayoutInput(node({ runs: [run(0, 3), run(3, 6, { fontWeight: 700 })], paragraph, autoSize: "fixed", fallbackFonts: [] }), fontBytes);
    const gappedRanges = textSvgLayoutInput(node({ runs: [run(0, 2), run(3, 6)], paragraph, autoSize: "fixed", fallbackFonts: [] }), fontBytes);
    const syntheticWeight = textSvgLayoutInput(node({ runs: [run(0, 6, { fontWeight: 700 })], paragraph, autoSize: "fixed", fallbackFonts: [] }), fontBytes);
    const syntheticItalic = textSvgLayoutInput(node({ runs: [run(0, 6, { italic: true })], paragraph, autoSize: "fixed", fallbackFonts: [] }), fontBytes);
    const tracking = textSvgLayoutInput(node({ runs: [run(0, 6, { letterSpacing: .25 })], paragraph, autoSize: "fixed", fallbackFonts: [] }), fontBytes);

    expect(JSON.parse(changedWeight!.runsJson).map((candidate: { fontWeight: number }) => candidate.fontWeight)).toEqual([400, 700]);
    expect(gappedRanges).toBeUndefined();
    expect(JSON.parse(syntheticWeight!.runsJson)[0]).toMatchObject({ fontWeight: 700, italic: false });
    expect(JSON.parse(syntheticItalic!.runsJson)[0]).toMatchObject({ fontWeight: 400, italic: true });
    expect(JSON.parse(tracking!.runsJson)[0]).toMatchObject({ letterSpacing: .25 });
    expect(textFrozenLayoutFace(node({ runs: [run(0, 6, { letterSpacing: .25 })], paragraph, autoSize: "fixed", fallbackFonts: [] }))).toBeUndefined();
  });

  it("projects case-only runs for shaping while keeping small caps on Canvas", () => {
    for (const textCase of ["upper", "lower", "title"] as const) {
      expect(textFrozenLayoutFace(node({
        runs: [run(0, 6, { textCase })], paragraph, autoSize: "fixed", fallbackFonts: [],
      }))).toMatchObject({ source: "Design" });
    }
    for (const textCase of ["smallCaps", "smallCapsForced"] as const) {
      expect(textFrozenLayoutFace(node({
        runs: [run(0, 6, { textCase })], paragraph, autoSize: "fixed", fallbackFonts: [],
      }))).toBeUndefined();
    }
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
      wasm.layout_shaped_text_runs_json(new Uint8Array(input.fontBundle), input.runsJson, input.shapingSource, fallbackNode.width),
      input.shapingSource,
    );
    const sourceLayout = layout && remapRustTextLayoutToSource(layout, input.projection);

    expect(sourceLayout?.lines).toHaveLength(1);
    expect(sourceLayout && hasMissingRustTextGlyph(sourceLayout)).toBe(false);
  });

  it("shapes a byte-contracting case presentation and remaps every line and caret to source bytes", async () => {
    const bytes = Uint8Array.from(readFileSync(new URL("../../node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf", import.meta.url)));
    const fallback = { assetId: "font-geist", faceIndex: 0 };
    const source = "ſesign";
    const sourceLength = new TextEncoder().encode(source).byteLength;
    const caseNode = {
      ...node({
        runs: [{ start: 0, end: sourceLength, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0, textCase: "upper" }],
        paragraph, autoSize: "fixed", fallbackFonts: [fallback],
      }),
      text: source,
    };
    const input = textSvgLayoutInput(caseNode, new Map([[fallback.assetId, bytes.buffer]]));
    if (!input) throw new Error("TextCase did not produce a frozen layout input");
    const wasm = await import("../wasm/generated/editor_wasm");
    wasm.initSync(readFileSync(new URL("../wasm/generated/editor_wasm_bg.wasm", import.meta.url)));
    const payload = wasm.layout_shaped_text_runs_json(
      new Uint8Array(input.fontBundle),
      input.runsJson,
      input.shapingSource,
      caseNode.width,
    );
    const displayLayout = parseRustTextLayout(payload, input.shapingSource);
    const sourceLayout = displayLayout && remapRustTextLayoutToSource(displayLayout, input.projection);
    const svgProjection = parseTextSvgLayoutProjection(payload, input);

    expect(input).toMatchObject({ source, shapingSource: "SESIGN" });
    expect(sourceLayout?.lines[0]).toMatchObject({ start: 0, end: sourceLength });
    expect(sourceLayout?.carets?.map((caret) => caret.byteOffset)).toEqual([0, 2, 3, 4, 5, 6, 7]);
    expect(sourceLayout && hasMissingRustTextGlyph(sourceLayout)).toBe(false);
    expect(svgProjection?.lines).toEqual([{ start: 0, end: sourceLength, direction: "ltr" }]);
  });

  it("uses generated WASM to wrap explicit per-run font sizes in one source coordinate system", async () => {
    const bytes = Uint8Array.from(readFileSync(new URL("../../node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf", import.meta.url)));
    const explicit = { assetId: "font-geist-multi-run", faceIndex: 0 };
    const source = "office office";
    const boundary = 7;
    const firstNode = {
      ...node({
        runs: [{ start: 0, end: boundary, font: explicit, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 }],
        paragraph, autoSize: "fixed", fallbackFonts: [],
      }),
      text: source.slice(0, boundary),
      width: 1_000,
    };
    const wasm = await import("../wasm/generated/editor_wasm");
    wasm.initSync(readFileSync(new URL("../wasm/generated/editor_wasm_bg.wasm", import.meta.url)));
    const firstInput = textSvgLayoutInput(firstNode, new Map([[explicit.assetId, bytes.buffer]]));
    if (!firstInput) throw new Error("First run did not produce a shaping input");
    const firstDisplay = parseRustTextLayout(wasm.layout_shaped_text_runs_json(
      new Uint8Array(firstInput.fontBundle), firstInput.runsJson, firstInput.shapingSource, firstNode.width,
    ), firstInput.shapingSource);
    if (!firstDisplay) throw new Error("First run did not produce a shaped layout");
    const firstWidth = firstDisplay.lines[0]!.advance * 16 / firstDisplay.unitsPerEm;
    const multiNode = {
      ...node({
        runs: [
          { start: 0, end: boundary, font: explicit, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 },
          { start: boundary, end: source.length, font: explicit, fontSize: 32, fontWeight: 400, italic: false, letterSpacing: 0 },
        ],
        paragraph, autoSize: "fixed", fallbackFonts: [],
      }),
      text: source,
      width: firstWidth + 1,
    };
    const input = textSvgLayoutInput(multiNode, new Map([[explicit.assetId, bytes.buffer]]));
    if (!input) throw new Error("Multi-run text did not produce a shaping input");
    const payload = wasm.layout_shaped_text_runs_json(
      new Uint8Array(input.fontBundle), input.runsJson, input.shapingSource, multiNode.width,
    );
    const projection = parseTextSvgLayoutProjection(payload, input);

    expect(projection?.lines).toEqual([
      { start: 0, end: boundary, direction: "ltr" },
      { start: boundary, end: source.length, direction: "ltr" },
    ]);
  });

  it("uses generated WASM tracking for line advance and physical caret coordinates", async () => {
    const bytes = Uint8Array.from(readFileSync(new URL("../../node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf", import.meta.url)));
    const explicit = { assetId: "font-geist-tracking", faceIndex: 0 };
    const source = "Design";
    const wasm = await import("../wasm/generated/editor_wasm");
    wasm.initSync(readFileSync(new URL("../wasm/generated/editor_wasm_bg.wasm", import.meta.url)));
    const shape = (letterSpacing: number) => {
      const input = textSvgLayoutInput({
        ...node({
          runs: [{ start: 0, end: source.length, font: explicit, fontSize: 16, fontWeight: 400, italic: false, letterSpacing }],
          paragraph, autoSize: "fixed", fallbackFonts: [],
        }),
        text: source,
        width: 1_000,
      }, new Map([[explicit.assetId, bytes.buffer]]));
      if (!input) throw new Error("Tracking did not produce a shaping input");
      const layout = parseRustTextLayout(wasm.layout_shaped_text_runs_json(
        new Uint8Array(input.fontBundle), input.runsJson, input.shapingSource, 1_000,
      ), input.shapingSource);
      if (!layout) throw new Error("Tracking did not produce a shaped layout");
      return layout;
    };
    const untracked = shape(0);
    const expanded = shape(2);
    const tightened = shape(-0.2);

    expect(expanded.lines[0]!.advance).toBeGreaterThan(untracked.lines[0]!.advance);
    expect(tightened.lines[0]!.advance).toBeLessThan(untracked.lines[0]!.advance);
    expect(expanded.lines[0]!.visualCarets?.map((caret) => caret.byteOffset))
      .toEqual(untracked.lines[0]!.visualCarets?.map((caret) => caret.byteOffset));
    expect(expanded.lines[0]!.visualCarets?.at(-1)?.xAdvance).toBe(expanded.lines[0]!.advance);
    expect(expanded.lines[0]!.glyphs.reduce((sum, glyph) => sum + glyph.xAdvance, 0)).toBe(expanded.lines[0]!.advance);
    expect(tightened.lines[0]!.glyphs.reduce((sum, glyph) => sum + glyph.xAdvance, 0)).toBe(tightened.lines[0]!.advance);
  });

  it("shapes the embedded Runtime fixture font through the multi-run WASM bridge", async () => {
    const fixture = createPhase2ProfessionalCompositeFixture();
    const embedded = fixture.assets.find((asset) => asset.mediaType === "font/ttf" && asset.bytesBase64);
    if (!embedded?.bytesBase64) throw new Error("Professional fixture is missing its embedded font");
    const bytes = Uint8Array.from(atob(embedded.bytesBase64), (character) => character.charCodeAt(0));
    const source = "Design\nDesign";
    const explicit = { assetId: embedded.assetId, faceIndex: 0 };
    const input = textSvgLayoutInput({
      ...node({
        runs: [
          { start: 0, end: 7, font: explicit, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 },
          { start: 7, end: source.length, font: explicit, fontSize: 32, fontWeight: 400, italic: false, letterSpacing: 0 },
        ],
        paragraph, autoSize: "fixed", fallbackFonts: [],
      }),
      text: source,
      width: 58,
    }, new Map([[embedded.assetId, bytes.buffer]]));
    if (!input) throw new Error("Runtime fixture did not produce a multi-run input");
    const wasm = await import("../wasm/generated/editor_wasm");
    wasm.initSync(readFileSync(new URL("../wasm/generated/editor_wasm_bg.wasm", import.meta.url)));
    const payload = wasm.layout_shaped_text_runs_json(
      new Uint8Array(input.fontBundle), input.runsJson, input.shapingSource, 58,
    );
    const layout = parseRustTextLayout(payload, input.shapingSource);

    expect(layout?.unitsPerEm).toBeGreaterThan(0);
    expect(layout?.lines.map(({ start, end }) => [start, end])).toEqual([[0, 6], [7, source.length]]);
    expect(layout && hasMissingRustTextGlyph(layout)).toBe(false);
  });
});
