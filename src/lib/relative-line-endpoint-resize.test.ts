import { describe, expect, it } from "vitest";
import { resizeRelativeLineEndpointFromWorldGesture } from "./relative-line-endpoint-resize";

const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

describe("relative Line endpoint resize", () => {
  it("rotates a Line's local basis while keeping its start endpoint fixed", () => {
    const resized = resizeRelativeLineEndpointFromWorldGesture({ width: 100, relativeTransform: identity }, identity, "end", { x: 60, y: 80 });
    expect(resized?.width).toBe(100);
    expect(resized?.relativeTransform.a).toBeCloseTo(0.6);
    expect(resized?.relativeTransform.b).toBeCloseTo(0.8);
    expect(resized?.relativeTransform.c).toBeCloseTo(-0.8);
    expect(resized?.relativeTransform.d).toBeCloseTo(0.6);
    expect(resized?.relativeTransform.e).toBe(0);
    expect(resized?.relativeTransform.f).toBe(0);
  });

  it("translates then rotates the local basis while keeping the end endpoint fixed", () => {
    const resized = resizeRelativeLineEndpointFromWorldGesture({ width: 100, relativeTransform: identity }, identity, "start", { x: 20, y: 10 });
    expect(resized?.width).toBeCloseTo(Math.hypot(80, -10));
    expect(resized?.relativeTransform.e).toBe(20);
    expect(resized?.relativeTransform.f).toBe(10);
    expect(resized?.relativeTransform.a).toBeCloseTo(80 / Math.hypot(80, -10));
    expect(resized?.relativeTransform.b).toBeCloseTo(-10 / Math.hypot(80, -10));
  });

  it("preserves the opposite world endpoint when the dragged start crosses it", () => {
    const resized = resizeRelativeLineEndpointFromWorldGesture({ width: 100, relativeTransform: identity }, identity, "start", { x: 120, y: 0 });

    expect(resized?.width).toBe(20);
    expect(resized?.relativeTransform.a).toBeCloseTo(-1);
    expect(resized?.relativeTransform.b).toBeCloseTo(0);
    expect(resized?.relativeTransform.c).toBeCloseTo(0);
    expect(resized?.relativeTransform.d).toBeCloseTo(-1);
    expect(resized?.relativeTransform.e).toBe(120);
    expect(resized?.relativeTransform.f).toBe(0);
  });
});
