import { describe, expect, it } from "vitest";
import { compositeLinearPaintLayer, relativeCompositePixelWindow } from "./linear-paint-layer-composite";

describe("linear paint-layer composition", () => {
  it("maps a global readback window into a cropped destination", () => {
    expect(relativeCompositePixelWindow(
      { pixelX: 80, pixelY: 50, pixelWidth: 40, pixelHeight: 30 },
      { pixelX: 100, pixelY: 40 },
      64,
      24,
    )).toEqual({ pixelX: 0, pixelY: 10, pixelWidth: 20, pixelHeight: 14 });
    expect(relativeCompositePixelWindow(
      { pixelX: 10, pixelY: 10, pixelWidth: 5, pixelHeight: 5 },
      { pixelX: 100, pixelY: 100 },
      20,
      20,
    )).toBeUndefined();
  });

  it.each([
    ["linear-burn", [133, 61, 46, 255]],
    ["linear-dodge", [194, 122, 97, 255]],
  ] as const)("applies exact %s pixels and restores context state", (mode, expected) => {
    let pixels = new Uint8ClampedArray([153, 102, 77, 255]);
    let alpha = .8;
    let operation: GlobalCompositeOperation = "multiply";
    let saved: { alpha: number; operation: GlobalCompositeOperation };
    let readbackBytes = 0;
    const context = {
      canvas: { width: 1, height: 1 },
      get globalAlpha() { return alpha; },
      set globalAlpha(value: number) { alpha = value; },
      get globalCompositeOperation() { return operation; },
      set globalCompositeOperation(value: GlobalCompositeOperation) { operation = value; },
      save() { saved = { alpha, operation }; },
      restore() { alpha = saved.alpha; operation = saved.operation; },
      createImageData() { return { data: new Uint8ClampedArray(4) }; },
      getImageData() { return { data: new Uint8ClampedArray(pixels) }; },
      putImageData(value: ImageData) { pixels = new Uint8ClampedArray(value.data); },
    };
    const result = compositeLinearPaintLayer(
      context as unknown as OffscreenCanvasRenderingContext2D,
      { pixelX: 0, pixelY: 0, pixelWidth: 1, pixelHeight: 1 },
      undefined,
      mode,
      .5,
      () => { pixels = new Uint8ClampedArray([204, 51, 51, Math.round(255 * alpha)]); },
      (bytes) => { readbackBytes += bytes; },
    );
    expect(result).toBe(true);
    expect([...pixels]).toEqual(expected);
    expect(alpha).toBe(.8);
    expect(operation).toBe("multiply");
    expect(readbackBytes).toBe(8);
  });

  it("restores the backdrop when source rendering fails", () => {
    let pixels = new Uint8ClampedArray([12, 34, 56, 255]);
    const context = {
      canvas: { width: 1, height: 1 },
      globalAlpha: 1,
      globalCompositeOperation: "source-over" as GlobalCompositeOperation,
      save() {}, restore() {},
      createImageData() { return { data: new Uint8ClampedArray(4) }; },
      getImageData() { return { data: new Uint8ClampedArray(pixels) }; },
      putImageData(value: ImageData) { pixels = new Uint8ClampedArray(value.data); },
    };
    expect(compositeLinearPaintLayer(
      context as unknown as OffscreenCanvasRenderingContext2D,
      { pixelX: 0, pixelY: 0, pixelWidth: 1, pixelHeight: 1 },
      undefined,
      "linear-burn",
      1,
      () => { throw new Error("draw failed"); },
    )).toBe(false);
    expect([...pixels]).toEqual([12, 34, 56, 255]);
  });
});
