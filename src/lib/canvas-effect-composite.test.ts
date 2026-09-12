import { describe, expect, it } from "vitest";
import { compositeEffectSurface } from "./canvas-effect-composite";

describe("effect surface composition", () => {
  it.each([1, 1.5, 2])("covers the entire destination at DPR %s, including its lower-right corner", (dpr) => {
    const surface = { width: 8, height: 6, dpr };
    const pixelWidth = surface.width * dpr;
    const pixelHeight = surface.height * dpr;
    const coverage = new Uint8Array(pixelWidth * pixelHeight);
    let transform = [1, 0, 0, 1, 0, 0];
    let saved: { transform: number[]; mode: GlobalCompositeOperation };
    // A minimal raster probe, independent of the helper's call sequence. It
    // records which device pixels a logical draw actually covers.
    const context = {
      globalCompositeOperation: "multiply" as GlobalCompositeOperation,
      save() { saved = { transform: [...transform], mode: this.globalCompositeOperation }; },
      restore() { transform = saved.transform; this.globalCompositeOperation = saved.mode; },
      setTransform(...matrix: number[]) { transform = matrix; },
      drawImage(_source: OffscreenCanvas, x: number, y: number, width: number, height: number) {
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
    compositeEffectSurface(context as unknown as OffscreenCanvasRenderingContext2D, {} as OffscreenCanvas, surface);
    expect([...coverage].every((pixel) => pixel === 1)).toBe(true);
    expect(transform).toEqual([1, 0, 0, 1, 0, 0]);
    expect(context.globalCompositeOperation).toBe("multiply");
  });
});
