import { describe, expect, it } from "vitest";
import { lineEndpoints, resizeLegacyLineEndpoint } from "./line-endpoint-resize";

describe("line endpoint resize", () => {
  const line = { x: 10, y: 20, width: 100, rotation: 0 };

  it("keeps the opposite endpoint fixed while dragging the end", () => {
    expect(resizeLegacyLineEndpoint(line, "end", { x: 70, y: 100 })).toEqual({ x: 10, y: 20, width: 100, rotation: 53.13010235415598 });
  });

  it("keeps the end fixed while dragging the start", () => {
    const resized = resizeLegacyLineEndpoint(line, "start", { x: 30, y: 40 });
    expect(resized).toEqual({ x: 30, y: 40, width: Math.hypot(80, -20), rotation: Math.atan2(-20, 80) * 180 / Math.PI });
    expect(lineEndpoints(resized).end.x).toBeCloseTo(110);
    expect(lineEndpoints(resized).end.y).toBeCloseTo(20);
  });

  it("clamps a short end drag away from the fixed start endpoint", () => {
    const resized = resizeLegacyLineEndpoint(line, "end", { x: 12, y: 20 });
    expect(resized.width).toBe(4);
    expect(lineEndpoints(resized).start).toEqual({ x: 10, y: 20 });
    expect(lineEndpoints(resized).end).toEqual({ x: 14, y: 20 });
  });

  it("clamps a zero-length start drag along the pre-drag direction while keeping the end fixed", () => {
    const resized = resizeLegacyLineEndpoint(line, "start", { x: 110, y: 20 });
    expect(resized.width).toBe(4);
    expect(lineEndpoints(resized).start).toEqual({ x: 106, y: 20 });
    expect(lineEndpoints(resized).end).toEqual({ x: 110, y: 20 });
  });

  it("flips the Line basis when a dragged endpoint crosses the opposite endpoint", () => {
    const resized = resizeLegacyLineEndpoint(line, "start", { x: 130, y: 20 });

    expect(resized).toEqual({ x: 130, y: 20, width: 20, rotation: 180 });
    expect(lineEndpoints(resized).end.x).toBeCloseTo(110);
    expect(lineEndpoints(resized).end.y).toBeCloseTo(20);
  });
});
