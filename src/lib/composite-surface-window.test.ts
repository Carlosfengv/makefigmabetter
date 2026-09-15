import { describe, expect, it } from "vitest";
import { compositeSurfaceWindowForWorldBounds, setCompositeSurfaceTransform, transformedCompositeSurfaceWindow } from "./composite-surface-window";

describe("composite surface window", () => {
  it("projects, pads, clips and rounds through a fractional DPR", () => {
    expect(compositeSurfaceWindowForWorldBounds(
      { left: -10.2, top: -4.4, right: 20.1, bottom: 12.2 },
      { x: 0, y: 0, zoom: 2 },
      100,
      80,
      1.5,
      1,
    )).toEqual({
      x: 42 / 1.5,
      y: 45 / 1.5,
      width: 95 / 1.5,
      height: 54 / 1.5,
      pixelX: 42,
      pixelY: 45,
      pixelWidth: 95,
      pixelHeight: 54,
      dpr: 1.5,
    });
  });

  it("returns no allocation for an envelope outside the viewport", () => {
    expect(compositeSurfaceWindowForWorldBounds(
      { left: 100, top: 100, right: 120, bottom: 120 },
      { x: 0, y: 0, zoom: 1 },
      40,
      40,
      2,
    )).toBeUndefined();
  });

  it("retains a bounded canonical window outside the viewport for a derived occurrence", () => {
    expect(compositeSurfaceWindowForWorldBounds(
      { left: 100, top: 100, right: 120, bottom: 120 },
      { x: 0, y: 0, zoom: 1 },
      40,
      40,
      2,
      0,
      false,
    )).toEqual({
      x: 120,
      y: 120,
      width: 20,
      height: 20,
      pixelX: 240,
      pixelY: 240,
      pixelWidth: 40,
      pixelHeight: 40,
      dpr: 2,
    });
  });

  it("maps global logical coordinates into the local device bitmap", () => {
    const calls: number[][] = [];
    setCompositeSurfaceTransform(
      { setTransform: (...values: number[]) => calls.push(values) },
      { x: 10, y: 20, width: 30, height: 40, pixelX: 15, pixelY: 30, pixelWidth: 45, pixelHeight: 60, dpr: 1.5 },
    );
    expect(calls).toEqual([[1.5, 0, 0, 1.5, -15, -30]]);
  });

  it("rounds and clips the device window touched by an occurrence affine", () => {
    expect(transformedCompositeSurfaceWindow(
      { x: 10, y: 20, width: 30, height: 20, pixelX: 20, pixelY: 40, pixelWidth: 60, pixelHeight: 40, dpr: 2 },
      { a: 0, b: 1, c: -1, d: 0, e: 100, f: 0 },
      90,
      80,
    )).toEqual({
      x: 60,
      y: 10,
      width: 20,
      height: 30,
      pixelX: 120,
      pixelY: 20,
      pixelWidth: 40,
      pixelHeight: 60,
      dpr: 2,
    });
  });
});
