import { describe, expect, it } from "vitest";
import { createNode, type DocumentEffect, type DocumentPaint } from "./editor-protocol";
import { normalizedFillLayers, normalizedNodeView } from "./normalized-node-view";

describe("normalized node view", () => {
  it("uses ordered paints and effects when present without mutating canonical input", () => {
    const fill: DocumentPaint = { css: "#f00" };
    const stroke: DocumentPaint = { css: "#0f0" };
    const effect: DocumentEffect = { layerBlur: { radius: 4, visible: true } };
    const node = {
      ...createNode("rectangle", 10, 20),
      fills: [fill],
      strokes: [stroke],
      effectStack: [effect],
      dropShadow: { offsetX: 1, offsetY: 2, blurRadius: 3, spread: 0, color: { space: "srgb" as const, components: [0, 0, 0] as [number, number, number], alpha: .5 }, visible: true },
      relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 30, f: 40 },
    };
    const before = structuredClone(node);

    expect(normalizedNodeView(node)).toEqual({
      fills: [fill],
      strokes: [stroke],
      effects: [effect],
      transform: { source: "relative-v1", value: node.relativeTransform },
    });
    expect(node).toEqual(before);
  });

  it("falls back to singular legacy fields for missing or empty ordered stacks", () => {
    const node = {
      ...createNode("rectangle", 10, 20),
      fill: "#123456",
      stroke: "#654321",
      fills: [],
      strokes: [],
      dropShadow: { offsetX: 1, offsetY: 2, blurRadius: 3, spread: 0, color: { space: "srgb" as const, components: [0, 0, 0] as [number, number, number], alpha: .5 }, visible: true },
    };

    expect(normalizedNodeView(node)).toMatchObject({
      fills: [{ css: "#123456" }],
      strokes: [{ css: "#654321" }],
      effects: [{ dropShadow: node.dropShadow }],
      transform: { source: "legacy-world", value: { x: 10, y: 20, rotation: 0 } },
    });
  });

  it("keeps explicit empty and layer presentation distinct from legacy fallback", () => {
    const node = {
      ...createNode("rectangle", 10, 20),
      fill: "#123456",
      stroke: "#654321",
      fillStack: { layers: [] },
      strokeStack: {
        layers: [
          { paint: { css: "#abcdef" }, visible: true, opacity: 0.25, blendMode: "multiply" as const },
          { paint: { css: "#ffffff" }, visible: false, opacity: 1, blendMode: "normal" as const },
        ],
      },
    };

    expect(normalizedNodeView(node)).toMatchObject({
      fills: [],
      strokes: [{ css: "#abcdef", layerOpacity: 0.25, layerBlendMode: "multiply" }],
    });
  });

  it("preserves image layers and their order in the normalized stack", () => {
    const image = { assetId: "asset-image", scaleMode: "crop" as const, transform: { a: 1, b: 0, c: 0, d: 1, e: 4, f: 6 } };
    const node = {
      ...createNode("rectangle", 0, 0),
      fillStack: { layers: [
        { paint: { css: "#112233" }, visible: true, opacity: 1, blendMode: "normal" as const },
        { image, visible: true, opacity: 0.5, blendMode: "screen" as const },
      ] },
    };

    expect(normalizedFillLayers(node)).toEqual([
      expect.objectContaining({ paint: { css: "#112233" } }),
      expect.objectContaining({ image, opacity: 0.5, blendMode: "screen" }),
    ]);
  });
});
