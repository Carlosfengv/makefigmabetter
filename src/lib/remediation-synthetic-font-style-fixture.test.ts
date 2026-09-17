import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRustGlyphRaster } from "./rust-glyph-raster";
import { hasMissingRustTextGlyph, parseRustTextLayout } from "./rust-text-layout";
import { textLayoutInputFromPlan, textFrozenLayoutPlan } from "./text-svg-layout-input";
import { createRemediationSyntheticFontStyleFixture } from "./remediation-synthetic-font-style-fixture";

describe("synthetic font style GPU fixture", () => {
  it("carries regular, bold, italic and bold-italic identities through shaping and rasterization", async () => {
    const fixture = createRemediationSyntheticFontStyleFixture();
    const text = fixture.nodes[0]!;
    const asset = fixture.assets[0]!;
    if (!asset.bytesBase64) throw new Error("Synthetic font fixture bytes are missing");
    const bytes = Uint8Array.from(atob(asset.bytesBase64), (character) => character.charCodeAt(0));
    const plan = textFrozenLayoutPlan(text);
    if (!plan) throw new Error("Synthetic style plan was rejected");
    const input = textLayoutInputFromPlan(plan, new Map([[asset.assetId, bytes.buffer]]));
    if (!input) throw new Error("Synthetic style input was rejected");
    const wasm = await import("../wasm/generated/editor_wasm");
    wasm.initSync(readFileSync(new URL("../wasm/generated/editor_wasm_bg.wasm", import.meta.url)));
    const layout = parseRustTextLayout(wasm.layout_shaped_text_runs_json(
      new Uint8Array(input.fontBundle), input.runsJson, input.shapingSource, text.width,
    ), input.shapingSource);
    if (!layout) throw new Error("Synthetic style layout was rejected");
    const raster = (fontWeight: number, italic: boolean) => parseRustGlyphRaster(
      wasm.rasterize_glyph_with_style_json(bytes, 0, "[]", fontWeight, italic, 1, 48),
    );
    const regular = raster(400, false);
    const bold = raster(700, false);
    const italic = raster(400, true);
    const both = raster(700, true);

    expect(plan.runs.map((run) => [run.fontWeight, run.italic])).toEqual([
      [400, false], [700, false], [400, true], [700, true],
    ]);
    expect(layout.lines).toHaveLength(1);
    expect(hasMissingRustTextGlyph(layout)).toBe(false);
    expect(new Set(layout.lines[0]!.glyphs.map((glyph) => glyph.runIndex))).toEqual(new Set([0, 1, 2, 3]));
    expect([regular, bold, italic, both].every(Boolean)).toBe(true);
    expect(regular).toMatchObject({ descent: expect.any(Number), capHeight: expect.any(Number) });
    expect(regular!.capHeight).toBeGreaterThan(0);
    expect([bold, italic, both].every((styled) => styled!.advanceX === regular!.advanceX && styled!.ascent === regular!.ascent)).toBe(true);
    expect([bold, italic, both].every((styled) => styled!.descent === regular!.descent && styled!.capHeight === regular!.capHeight)).toBe(true);
    expect(new Set([regular, bold, italic, both].map((styled) => `${styled!.width}x${styled!.height}:${Array.from(styled!.alphaMask).join(",")}`)).size).toBe(4);
  });
});
