import { describe, expect, it } from "vitest";
import { MAX_CANVAS_ZOOM, MIN_CANVAS_ZOOM, clampCanvasZoom, resolveVisibleCanvasGridStep, shouldRenderCanvasGrid, snapCanvasPoint, snapToCanvasGrid } from "./canvas-grid";

describe("canvas grid", () => {
  it("snaps direct canvas values to the 1px world grid symmetrically", () => {
    expect(snapToCanvasGrid(12.49)).toBe(12);
    expect(snapToCanvasGrid(12.5)).toBe(13);
    expect(snapToCanvasGrid(-12.5)).toBe(-13);
    expect(snapCanvasPoint({ x: 0.49, y: -0.51 })).toEqual({ x: 0, y: -1 });
  });

  it("uses 1px grid lines for the high-zoom precision overlay", () => {
    expect(resolveVisibleCanvasGridStep(0.2)).toBe(20);
    expect(resolveVisibleCanvasGridStep(1)).toBe(5);
    expect(resolveVisibleCanvasGridStep(4)).toBe(1);
    expect(resolveVisibleCanvasGridStep(16)).toBe(1);
    expect(resolveVisibleCanvasGridStep(0.2) * 0.2).toBeGreaterThanOrEqual(4);
  });

  it("only shows grid lines above 400% zoom", () => {
    expect(shouldRenderCanvasGrid(4)).toBe(false);
    expect(shouldRenderCanvasGrid(4.01)).toBe(true);
  });

  it("supports the Figma-compatible 2%–25,600% zoom range", () => {
    expect(MIN_CANVAS_ZOOM).toBe(0.02);
    expect(MAX_CANVAS_ZOOM).toBe(256);
    expect(clampCanvasZoom(1_000)).toBe(256);
    expect(clampCanvasZoom(0.01)).toBe(MIN_CANVAS_ZOOM);
  });
});
