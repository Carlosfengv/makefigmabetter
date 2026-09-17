import { describe, expect, it } from "vitest";
import { createNode, type DocumentPaintLayer } from "./editor-protocol";
import { textPathGlyphBounds, textPathPaintBatches } from "./text-path-paint-plan";
import type { WebGpuTextGlyph } from "./webgpu-scene";

function glyph(paintRunIndex: number, x = 0, rotation = 0): WebGpuTextGlyph {
  return {
    textureKey: `glyph-${paintRunIndex}-${x}`,
    nodeId: "text-path",
    x,
    y: 10,
    width: 10,
    height: 20,
    rotation,
    paintRunIndex,
    fill: "#000",
    opacity: 1,
    maskWidth: 1,
    maskHeight: 1,
    alphaMask: Uint8Array.of(255),
  };
}

const fallback: DocumentPaintLayer[] = [
  { visible: true, opacity: 1, blendMode: "normal", paint: { css: "#111" } },
  { visible: true, opacity: .5, blendMode: "multiply", image: { assetId: "image", scaleMode: "fill", transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } } },
];

describe("TextPath Paint Stack planning", () => {
  it("keeps layer-major order across run-specific and fallback paints", () => {
    const node = {
      ...createNode("textPath", 0, 0),
      textProperties: {
        runs: [
          { start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0, fillStack: { layers: [
            { visible: true, opacity: 1, blendMode: "normal" as const, paint: { css: "linear-gradient", gradient: { start: [0, 0] as [number, number], end: [1, 0] as [number, number], stops: [] } } },
            { visible: true, opacity: .8, blendMode: "screen" as const, paint: { css: "#fff" } },
          ] } },
          { start: 1, end: 2, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 },
        ],
        paragraph: { alignment: "left" as const, paragraphSpacing: 0 },
        autoSize: "fixed" as const,
      },
    };
    const batches = textPathPaintBatches(node, [glyph(0), glyph(1, 20)], fallback);
    expect(batches.map((batch) => [batch.layer.blendMode, batch.glyphIndexes])).toEqual([
      ["normal", [0]],
      ["normal", [1]],
      ["screen", [0]],
      ["multiply", [1]],
    ]);
  });

  it("uses explicit empty run stacks as no paint instead of falling back", () => {
    const node = {
      textProperties: {
        runs: [{ start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0, fillStack: { layers: [] } }],
        paragraph: { alignment: "left" as const, paragraphSpacing: 0 },
        autoSize: "fixed" as const,
      },
    };
    expect(textPathPaintBatches(node, [glyph(0)], fallback)).toEqual([]);
  });

  it("retains invisible layer positions across different runs", () => {
    const node = {
      textProperties: {
        runs: [
          { start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0, fillStack: { layers: [
            { visible: false, opacity: 1, blendMode: "normal" as const, paint: { css: "#000" } },
            { visible: true, opacity: 1, blendMode: "screen" as const, paint: { css: "#fff" } },
          ] } },
          { start: 1, end: 2, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0, fillStack: { layers: [
            { visible: true, opacity: 1, blendMode: "multiply" as const, paint: { css: "#f00" } },
          ] } },
        ],
        paragraph: { alignment: "left" as const, paragraphSpacing: 0 },
        autoSize: "fixed" as const,
      },
    };
    expect(textPathPaintBatches(node, [glyph(0), glyph(1)], fallback).map((batch) => batch.layer.blendMode)).toEqual(["multiply", "screen"]);
  });

  it("bounds rotated glyphs in local screen pixels with an antialias margin", () => {
    expect(textPathGlyphBounds([glyph(0, 0, 90)], 2)).toEqual({ x: -11, y: 29, width: 42, height: 22 });
  });
});
