import { describe, expect, it } from "vitest";
import { decorativeCapContains, decorativeCapMesh, decorativeCapSize, isDecorativeCap } from "./decorative-cap-mesh";

// These golden values are the same ones asserted by the Rust source of truth in
// `crates/editor-core/src/geometry.rs`
// (`decorative_arrow_meshes_point_outward_and_size_from_stroke_width` etc.) and
// by the WASM boundary test `exposes_decorative_endpoint_cap_meshes_at_the_wasm_boundary`.
// Keeping them in lockstep is what makes Canvas, hit test and SVG one geometry source.

describe("decorativeCapMesh", () => {
  it("classifies only the five decorative caps", () => {
    expect(isDecorativeCap("arrowLines")).toBe(true);
    expect(isDecorativeCap("circleFilled")).toBe(true);
    expect(isDecorativeCap("round")).toBe(false);
    expect(isDecorativeCap("square")).toBe(false);
    expect(isDecorativeCap(undefined)).toBe(false);
  });

  it("uses the Canvas size rule size = max(8, width·4)", () => {
    expect(decorativeCapSize(1)).toBe(8);
    expect(decorativeCapSize(3)).toBe(12);
    expect(decorativeCapSize(4)).toBe(16);
  });

  it("places the end arrowhead tip at the endpoint and base one size beyond (matches Rust golden)", () => {
    const mesh = decorativeCapMesh("arrowEquilateral", 100, 1, 3);
    expect(mesh.bounds).toBeDefined();
    expect(mesh.bounds!.minX).toBeCloseTo(100, 9);
    expect(mesh.bounds!.maxX).toBeCloseTo(112, 9);
    const half = 12 * Math.sqrt(3) / 4;
    expect(mesh.bounds!.maxY).toBeCloseTo(half, 9);
    expect(mesh.bounds!.minY).toBeCloseTo(-half, 9);
    expect(decorativeCapContains("arrowEquilateral", 100, 1, 3, { x: 101, y: 0 })).toBe(true);
  });

  it("mirrors the start arrowhead along -x (matches Rust golden)", () => {
    const mesh = decorativeCapMesh("triangleFilled", 0, -1, 3);
    expect(mesh.bounds!.minX).toBeCloseTo(-12, 9);
    expect(mesh.bounds!.maxX).toBeCloseTo(0, 9);
  });

  it("spans the diamond and dot to the full marker size (matches Rust golden)", () => {
    const diamond = decorativeCapMesh("diamondFilled", 50, 1, 4);
    expect(diamond.bounds!.maxX).toBeCloseTo(66, 9);
    expect(diamond.bounds!.minX).toBeCloseTo(50, 9);
    expect(diamond.bounds!.maxY).toBeCloseTo(8, 9);
    expect(diamond.bounds!.minY).toBeCloseTo(-8, 9);
    expect(decorativeCapContains("diamondFilled", 50, 1, 4, { x: 58, y: 0 })).toBe(true);

    const dot = decorativeCapMesh("circleFilled", 20, 1, 4);
    expect(dot.bounds!.minX).toBeCloseTo(-8 + 20, 9);
    expect(dot.bounds!.maxX).toBeCloseTo(8 + 20, 9);
    expect(decorativeCapContains("circleFilled", 20, 1, 4, { x: 20, y: 7 })).toBe(true);
    expect(decorativeCapContains("circleFilled", 20, 1, 4, { x: 20, y: 9 })).toBe(false);
  });

  it("draws arrowLines barbs backward from the tip as thin quads (matches Rust golden)", () => {
    const mesh = decorativeCapMesh("arrowLines", 100, 1, 2);
    expect(mesh.triangles.length).toBeGreaterThan(0);
    expect(mesh.bounds!.maxX).toBeLessThanOrEqual(100 + 1 + 1e-6);
    expect(mesh.bounds!.minX).toBeLessThan(100 - 4);
  });
});
