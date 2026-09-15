import { describe, expect, it } from "vitest";
import { basicTextDecorationPattern, basicTextDecorationRect, textDecorationPaintLayers, textDecorationVisibleSegments } from "./text-decoration";

describe("basicTextDecorationRect", () => {
  it("anchors underline geometry for left, center, and right aligned spans", () => {
    const base = { decoration: "underline" as const, fontSize: 20, zoom: 2, textWidth: 80, anchorX: 100, baseline: 50, actualBoundingBoxDescent: 8 };
    expect(basicTextDecorationRect({ ...base, textAlign: "left" })).toEqual({ x: 100, y: 52.4, width: 80, height: 2.4 });
    expect(basicTextDecorationRect({ ...base, textAlign: "center" })?.x).toBe(60);
    expect(basicTextDecorationRect({ ...base, textAlign: "right" })?.x).toBe(20);
  });

  it("places strikethrough above the alphabetic baseline and rejects invalid metrics", () => {
    expect(basicTextDecorationRect({ decoration: "strikethrough", fontSize: 20, zoom: 1, textWidth: 40, textAlign: "left", anchorX: 0, baseline: 30, actualBoundingBoxDescent: 4 })).toEqual({ x: 0, y: 23.4, width: 40, height: 1.2 });
    expect(basicTextDecorationRect({ decoration: "underline", fontSize: 20, zoom: 0, textWidth: 40, textAlign: "left", anchorX: 0, baseline: 30, actualBoundingBoxDescent: 4 })).toBeUndefined();
  });

  it("applies pixel and font-relative percentage offsets from the AUTO underline position", () => {
    const base = { decoration: "underline" as const, fontSize: 20, zoom: 2, textWidth: 80, textAlign: "left" as const, anchorX: 100, baseline: 50, actualBoundingBoxDescent: 8 };
    expect(basicTextDecorationRect({ ...base, offset: { value: 3, unit: "pixels" } })?.y).toBeCloseTo(58.4);
    expect(basicTextDecorationRect({ ...base, offset: { value: -25, unit: "percent" } })?.y).toBeCloseTo(42.4);

    const auto = basicTextDecorationRect(base)!;
    const pixels = basicTextDecorationRect({ ...base, thickness: { value: 3, unit: "pixels" } })!;
    const percent = basicTextDecorationRect({ ...base, thickness: { value: 10, unit: "percent" } })!;
    expect(pixels.height).toBeCloseTo(6);
    expect(percent.height).toBeCloseTo(4);
    expect(pixels.y + pixels.height / 2).toBeCloseTo(auto.y + auto.height / 2);
    expect(percent.y + percent.height / 2).toBeCloseTo(auto.y + auto.height / 2);
    expect(basicTextDecorationRect({ ...base, offset: { value: 2, unit: "pixels" }, thickness: { value: 3, unit: "pixels" } })?.y).toBeCloseTo(54.6);
  });

  it("derives bounded solid, dotted, and wavy patterns from the same thickness", () => {
    expect(basicTextDecorationPattern(undefined, 2)).toEqual({ kind: "solid" });
    expect(basicTextDecorationPattern("dotted", 2)).toEqual({ kind: "dotted", radius: 1, spacing: 5 });
    expect(basicTextDecorationPattern("wavy", 2)).toEqual({ kind: "wavy", amplitude: 2, wavelength: 8, strokeWidth: 1.5 });
    expect(basicTextDecorationPattern("wavy", 0)).toBeUndefined();
  });

  it("uses glyph paints for AUTO and exactly one layer for an explicit underline color", () => {
    const glyphLayers = [
      { visible: true, opacity: 1, blendMode: "normal" as const, paint: { css: "#111" } },
      { visible: true, opacity: .5, blendMode: "multiply" as const, paint: { css: "#222" } },
    ];
    expect(textDecorationPaintLayers("underline", undefined, glyphLayers)).toBe(glyphLayers);
    expect(textDecorationPaintLayers("strikethrough", {
      color: { space: "srgb", components: [1, 0, 0], alpha: 1 }, visible: true, opacity: .75, blendMode: "screen",
    }, glyphLayers)).toBe(glyphLayers);
    expect(textDecorationPaintLayers("underline", {
      color: { space: "srgb", components: [1, .25, .5], alpha: 1 }, visible: true, opacity: .75, blendMode: "multiply",
    }, glyphLayers)).toEqual([{
      visible: true, opacity: .75, blendMode: "multiply",
      paint: { css: "#ff4080", color: { space: "srgb", components: [1, .25, .5], alpha: 1 } },
    }]);
    expect(textDecorationPaintLayers("underline", {
      color: { space: "srgb", components: [1, 0, 0], alpha: 1 }, visible: false, opacity: 1, blendMode: "normal",
    }, glyphLayers)).toEqual([]);
  });

  it("clips, merges, and subtracts measured descender intervals for skip ink", () => {
    expect(textDecorationVisibleSegments(
      { x: 10, y: 20, width: 100, height: 2 },
      [{ start: 50, end: 65 }, { start: 30, end: 45 }, { start: 42, end: 55 }, { start: -10, end: 15 }, { start: 120, end: 130 }],
    )).toEqual([
      { x: 15, y: 20, width: 15, height: 2 },
      { x: 65, y: 20, width: 45, height: 2 },
    ]);
  });
});
