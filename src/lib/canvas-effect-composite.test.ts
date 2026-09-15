import { describe, expect, it } from "vitest";
import { compositeEffectSurface } from "./canvas-effect-composite";

describe("effect surface composition", () => {
  it.each([1, 1.5, 2])("covers the entire destination at DPR %s, including its lower-right corner", (dpr) => {
    const surface = { width: 8, height: 6, dpr };
    const pixelWidth = surface.width * dpr;
    const pixelHeight = surface.height * dpr;
    const coverage = new Uint8Array(pixelWidth * pixelHeight);
    let transform = [1, 0, 0, 1, 0, 0];
    let saved: { transform: number[]; mode: GlobalCompositeOperation; alpha: number };
    // A minimal raster probe, independent of the helper's call sequence. It
    // records which device pixels a logical draw actually covers.
    const context = {
      globalCompositeOperation: "multiply" as GlobalCompositeOperation,
      globalAlpha: .75,
      save() { saved = { transform: [...transform], mode: this.globalCompositeOperation, alpha: this.globalAlpha }; },
      restore() { transform = saved.transform; this.globalCompositeOperation = saved.mode; this.globalAlpha = saved.alpha; },
      setTransform(...matrix: number[]) { transform = matrix; },
      drawImage(_source: OffscreenCanvas, ...args: number[]) {
        const [x, y, width, height] = args.length === 4 ? args : args.slice(4);
        const [a, , , d, e, f] = transform;
        for (let py = 0; py < pixelHeight; py++) {
          for (let px = 0; px < pixelWidth; px++) {
            if (px + .5 >= x * a + e && px + .5 < (x + width) * a + e &&
                py + .5 >= y * d + f && py + .5 < (y + height) * d + f)
              coverage[py * pixelWidth + px] = 1;
          }
        }
      },
    };
    compositeEffectSurface(context as unknown as OffscreenCanvasRenderingContext2D, {} as OffscreenCanvas, surface, "screen", .25);
    expect([...coverage].every((pixel) => pixel === 1)).toBe(true);
    expect(transform).toEqual([1, 0, 0, 1, 0, 0]);
    expect(context.globalCompositeOperation).toBe("multiply");
    expect(context.globalAlpha).toBe(.75);
  });

  it("places a cropped source at its logical screen origin", () => {
    const calls: unknown[][] = [];
    const context = {
      globalCompositeOperation: "source-over" as GlobalCompositeOperation,
      globalAlpha: 1,
      save() {}, restore() {}, setTransform(...args: unknown[]) { calls.push(["transform", ...args]); },
      drawImage(...args: unknown[]) { calls.push(["draw", ...args.slice(1)]); },
    };
    compositeEffectSurface(
      context as unknown as OffscreenCanvasRenderingContext2D,
      { width: 80, height: 60 } as OffscreenCanvas,
      { x: 10, y: 20, width: 40, height: 30, pixelWidth: 80, pixelHeight: 60, dpr: 2 },
    );
    expect(calls).toEqual([
      ["transform", 2, 0, 0, 2, 0, 0],
      ["draw", 0, 0, 80, 60, 10, 20, 40, 30],
    ]);
  });

  it("places a child window into a cropped destination window", () => {
    const calls: unknown[][] = [];
    const context = {
      globalCompositeOperation: "source-over" as GlobalCompositeOperation,
      globalAlpha: 1,
      save() {}, restore() {}, setTransform(...args: unknown[]) { calls.push(["transform", ...args]); },
      drawImage(...args: unknown[]) { calls.push(["draw", ...args.slice(1)]); },
    };
    compositeEffectSurface(
      context as unknown as OffscreenCanvasRenderingContext2D,
      { width: 40, height: 20 } as OffscreenCanvas,
      { x: 30, y: 40, width: 20, height: 10, pixelWidth: 40, pixelHeight: 20, dpr: 2 },
      "source-over",
      1,
      { pixelX: 20, pixelY: 50 },
    );
    expect(calls[0]).toEqual(["transform", 2, 0, 0, 2, -20, -50]);
  });

  it("applies owner opacity once after an opaque subtree source and multiplies nested boundaries", () => {
    const context = (initialAlpha = 0) => {
      let outputAlpha = initialAlpha;
      let savedAlpha = 1;
      return {
        get outputAlpha() { return outputAlpha; },
        globalAlpha: 1,
        globalCompositeOperation: "source-over" as GlobalCompositeOperation,
        save() { savedAlpha = this.globalAlpha; },
        restore() { this.globalAlpha = savedAlpha; },
        setTransform() {},
        drawImage(source: OffscreenCanvas & { alpha?: number }) {
          const sourceAlpha = (source.alpha ?? 1) * this.globalAlpha;
          outputAlpha = sourceAlpha + outputAlpha * (1 - sourceAlpha);
        },
      };
    };
    const surface = { width: 1, height: 1, dpr: 1 };
    const innerDestination = context();
    compositeEffectSurface(
      innerDestination as unknown as OffscreenCanvasRenderingContext2D,
      { alpha: 1 } as unknown as OffscreenCanvas,
      surface,
      "source-over",
      .5,
    );
    expect(innerDestination.outputAlpha).toBe(.5);

    const outerDestination = context();
    compositeEffectSurface(
      outerDestination as unknown as OffscreenCanvasRenderingContext2D,
      { alpha: innerDestination.outputAlpha } as unknown as OffscreenCanvas,
      surface,
      "source-over",
      .5,
    );
    expect(outerDestination.outputAlpha).toBe(.25);
  });
});
