import { describe, expect, it } from "vitest";
import { colorToOpaqueSrgbCss, colorToSrgbCss, createDefaultLinearGradient, sampleLinearGradientForCanvas } from "./color-rendering";

describe("Canvas/CSS color projection", () => {
  it("preserves encoded sRGB bytes and alpha", () => {
    expect(colorToSrgbCss({ space: "srgb", components: [17 / 255, 34 / 255, 51 / 255], alpha: 128 / 255 })).toBe("#11223380");
  });

  it("encodes linear sRGB at the projection boundary", () => {
    expect(colorToSrgbCss({ space: "linear-srgb", components: [0.5, 0.5, 0.5], alpha: 1 })).toBe("#bcbcbc");
  });

  it("converts Display P3 instead of treating its encoded components as sRGB", () => {
    const p3 = { space: "display-p3" as const, components: [0.2, 0.8, 0.4] as [number, number, number], alpha: 1 };
    expect(colorToOpaqueSrgbCss(p3)).not.toBe("#33cc66");
    expect(colorToOpaqueSrgbCss(p3)).toBe("#00d058");
  });

  it("emits linear-light samples while preserving exact gradient stops", () => {
    const stops = sampleLinearGradientForCanvas({
      start: [0, 0], end: [1, 0], stops: [
        { position: 0, color: { space: "srgb", components: [0, 0, 0], alpha: 1 } },
        { position: 1, color: { space: "srgb", components: [1, 1, 1], alpha: 1 } },
      ],
    }, 2);
    expect(stops).toEqual([
      { position: 0, color: "#000000" },
      { position: 0.5, color: "#bcbcbc" },
      { position: 1, color: "#ffffff" },
    ]);
  });

  it("keeps legal hard stops as separate Canvas stop entries", () => {
    const stops = sampleLinearGradientForCanvas({
      start: [0, 0], end: [1, 0], stops: [
        { position: 0, color: { space: "srgb", components: [0, 0, 0], alpha: 1 } },
        { position: 0.5, color: { space: "srgb", components: [1, 0, 0], alpha: 1 } },
        { position: 0.5, color: { space: "srgb", components: [0, 0, 1], alpha: 1 } },
      ],
    }, 1);
    expect(stops.at(-2)).toEqual({ position: 0.5, color: "#ff0000" });
    expect(stops.at(-1)).toEqual({ position: 0.5, color: "#0000ff" });
  });

  it("creates an editable visible horizontal gradient from a solid fill", () => {
    const gradient = createDefaultLinearGradient({ space: "srgb", components: [0, 0, 0], alpha: 0.6 });

    expect(gradient.start).toEqual([0, 0]);
    expect(gradient.end).toEqual([1, 0]);
    expect(gradient.stops).toEqual([
      { position: 0, color: { space: "srgb", components: [0, 0, 0], alpha: 0.6 } },
      { position: 1, color: { space: "linear-srgb", components: [0.32, 0.32, 0.32], alpha: 0.6 } },
    ]);
  });
});
