import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { alphaChannelFromRgba, maskNeedsRenderedAlphaHit, renderedMaskAlphaAtWorldPoint, type RenderedMaskAlphaHit } from "./rendered-mask-alpha-hit";

const viewport = { x: 10, y: -5, zoom: 2 };
const rendered: RenderedMaskAlphaHit = {
  revision: 7,
  resourceGeneration: 3,
  viewport,
  canvasWidth: 200,
  canvasHeight: 100,
  window: { x: 118, y: 38, width: 2, height: 1, pixelX: 236, pixelY: 76, pixelWidth: 4, pixelHeight: 2, dpr: 2 },
  alpha: Uint8Array.of(0, 255, 0, 0, 0, 0, 255, 0),
};

describe("rendered mask alpha hit", () => {
  it("samples device pixels through the exact revision/resource/camera fence", () => {
    const state = { revision: 7, resourceGeneration: 3, viewport, canvasWidth: 200, canvasHeight: 100 };
    expect(renderedMaskAlphaAtWorldPoint(rendered, state, { x: -0.75, y: -0.875 })).toBe(true);
    expect(renderedMaskAlphaAtWorldPoint(rendered, state, { x: -0.875, y: -0.875 })).toBe(false);
    expect(renderedMaskAlphaAtWorldPoint(rendered, state, { x: 20, y: 20 })).toBe(false);
    expect(renderedMaskAlphaAtWorldPoint(rendered, { ...state, revision: 8 }, { x: 9.4, y: -3 })).toBeUndefined();
    expect(renderedMaskAlphaAtWorldPoint(rendered, { ...state, viewport: { ...viewport, zoom: 1 } }, { x: 9.4, y: -3 })).toBeUndefined();
  });

  it("extracts a compact alpha-only cache and rejects malformed RGBA", () => {
    expect(alphaChannelFromRgba(Uint8ClampedArray.of(1, 2, 3, 4, 5, 6, 7, 8), 2, 1)).toEqual(Uint8Array.of(4, 8));
    expect(alphaChannelFromRgba(Uint8ClampedArray.of(1, 2, 3), 1, 1)).toBeUndefined();
  });

  it("uses rendered alpha only for masks whose support is not analytic", () => {
    const rectangle = { ...createNode("rectangle", 0, 0), fill: "#ffffff", stroke: "transparent", strokeWidth: 0 };
    expect(maskNeedsRenderedAlphaHit(rectangle)).toBe(false);
    expect(maskNeedsRenderedAlphaHit({ ...rectangle, effectStack: [{ layerBlur: { radius: 8, visible: true } }] })).toBe(true);
    expect(maskNeedsRenderedAlphaHit({ ...rectangle, fillStack: { layers: [
      { paint: { css: "#fff" }, visible: true, opacity: 1, blendMode: "normal" },
      { paint: { css: "#000" }, visible: true, opacity: 1, blendMode: "normal" },
    ] } })).toBe(true);
    expect(maskNeedsRenderedAlphaHit({ ...rectangle, fills: [{ css: "transparent", gradient: { start: [0, 0], end: [1, 0], stops: [] } }] })).toBe(true);
    expect(maskNeedsRenderedAlphaHit({ ...rectangle, stroke: "#fff", strokeWidth: 2 })).toBe(true);
    expect(maskNeedsRenderedAlphaHit({ ...createNode("vector", 0, 0), fill: "#ffffff", stroke: "transparent", strokeWidth: 0 })).toBe(true);
  });
});
