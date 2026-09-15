import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRemediationRtlGpuTextFixture } from "./remediation-rtl-gpu-text-fixture";
import { parseRustTextLayout } from "./rust-text-layout";
import { textFrozenLayoutPlan, textSvgLayoutInput } from "./text-svg-layout-input";

describe("RTL GPU text fixture", () => {
  it("owns an immutable OFL Hebrew subset and one GPU-compatible metric run", () => {
    const fixture = createRemediationRtlGpuTextFixture();
    const asset = fixture.assets[0]!;
    const text = fixture.nodes[0]!;
    const bytes = Uint8Array.from(atob(asset.bytesBase64!), (character) => character.charCodeAt(0));
    const plan = textFrozenLayoutPlan(text);

    expect(bytes).toHaveLength(asset.byteLength);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(asset.contentHash);
    expect(plan?.runs).toEqual([expect.objectContaining({
      font: { assetId: asset.assetId, faceIndex: 0 },
      fontSize: 48,
      letterSpacing: 1,
    })]);
    expect(text.textProperties?.paragraph.alignment).toBe("left");
    expect(text.textProperties?.runs.every((run) => run.color === undefined && run.fillStack === undefined)).toBe(true);
  });

  it("shapes a pure RTL line as a physical left-to-right glyph stream", async () => {
    const fixture = createRemediationRtlGpuTextFixture();
    const asset = fixture.assets[0]!;
    const text = fixture.nodes[0]!;
    const bytes = Uint8Array.from(atob(asset.bytesBase64!), (character) => character.charCodeAt(0));
    const input = textSvgLayoutInput(text, new Map([[asset.assetId, bytes.buffer]]));
    if (!input) throw new Error("RTL fixture did not produce a frozen layout input");
    const wasm = await import("../wasm/generated/editor_wasm");
    wasm.initSync(readFileSync(new URL("../wasm/generated/editor_wasm_bg.wasm", import.meta.url)));
    const layout = parseRustTextLayout(wasm.layout_shaped_text_runs_json(
      new Uint8Array(input.fontBundle),
      input.runsJson,
      input.shapingSource,
      text.width,
    ), input.shapingSource);
    const line = layout?.lines[0];

    expect(line?.direction).toBe("rtl");
    expect(line?.glyphs.every((glyph) => glyph.glyphId !== 0 && glyph.xAdvance >= 0)).toBe(true);
    expect(line?.glyphs.map((glyph) => glyph.cluster)).toEqual([6, 4, 2, 0]);
    expect(line?.glyphs.reduce((sum, glyph) => sum + glyph.xAdvance, 0)).toBe(line?.advance);
    expect(line?.visualCarets?.map((caret) => caret.byteOffset)).toEqual([8, 6, 4, 2, 0]);
  });
});
