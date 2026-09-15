import { describe, expect, it } from "vitest";
import type { CanvasNode } from "./editor-protocol";
import { resolveTextPathVectorPath } from "./text-path-conversion";

function source(kind: CanvasNode["kind"], patch: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: `source-${kind}`,
    name: kind,
    kind,
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    rotation: 0,
    fill: "#fff",
    stroke: "transparent",
    strokeWidth: 0,
    radius: 0,
    opacity: 1,
    ...patch,
  };
}

function pointIds(path: NonNullable<ReturnType<typeof resolveTextPathVectorPath>>): string[] {
  return path.subpaths.flatMap((subpath) => subpath.points.map((point) => point.id));
}

describe("TextPath geometry resolution", () => {
  it("clones canonical Vector geometry without allocating replacement point IDs", () => {
    const vectorPath = {
      fillRule: "nonZero" as const,
      subpaths: [{ closed: false, points: [
        { id: "a", x: 0, y: 0, pointType: "corner" as const },
        { id: "b", x: 100, y: 80, pointType: "corner" as const },
      ] }],
    };
    let allocations = 0;
    const resolved = resolveTextPathVectorPath(source("vector", { vectorPath }), () => `new-${++allocations}`)!;

    expect(resolved).toEqual(vectorPath);
    expect(resolved).not.toBe(vectorPath);
    expect(resolved.subpaths[0]).not.toBe(vectorPath.subpaths[0]);
    expect(allocations).toBe(0);
  });

  it("materializes Line and rounded Rectangle sources with bounded, unique points", () => {
    let nextId = 0;
    const createPointId = () => `point-${++nextId}`;
    const line = resolveTextPathVectorPath(source("line", { width: 160, height: 0 }), createPointId)!;
    const rectangle = resolveTextPathVectorPath(source("rectangle", { width: 120, height: 80, cornerRadii: [12, 24, 36, 0] }), createPointId)!;

    expect(line.subpaths).toEqual([{ closed: false, points: [
      { id: "point-1", x: 0, y: 0, pointType: "corner" },
      { id: "point-2", x: 160, y: 0, pointType: "corner" },
    ] }]);
    expect(rectangle.subpaths[0]?.closed).toBe(true);
    expect(rectangle.subpaths[0]?.points.length).toBeGreaterThanOrEqual(4);
    expect(new Set(pointIds(rectangle)).size).toBe(pointIds(rectangle).length);
    for (const point of rectangle.subpaths[0]!.points) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(120);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(80);
    }
  });

  it("uses two oppositely wound contours for a full ellipse ring", () => {
    let nextId = 0;
    const path = resolveTextPathVectorPath(source("ellipse", {
      width: 200,
      height: 100,
      arcData: { startingAngle: 0, endingAngle: 360, innerRadius: .5 },
    }), () => `ellipse-${++nextId}`)!;

    expect(path.fillRule).toBe("evenOdd");
    expect(path.subpaths).toHaveLength(2);
    expect(path.subpaths.every((subpath) => subpath.closed && subpath.points.length === 4)).toBe(true);
    expect(new Set(pointIds(path)).size).toBe(8);
    expect(path.subpaths[0]!.points[0]).toMatchObject({ x: 200, y: 50 });
    expect(path.subpaths[1]!.points[0]!.x).toBeCloseTo(150);
    expect(path.subpaths[1]!.points[0]!.y).toBeCloseTo(50);
  });

  it("materializes Polygon and Star paths from their parametric source", () => {
    let nextId = 0;
    const createPointId = () => `parametric-${++nextId}`;
    const polygon = resolveTextPathVectorPath(source("polygon", { parametricShape: { kind: "polygon", pointCount: 6 } }), createPointId)!;
    const star = resolveTextPathVectorPath(source("star", { parametricShape: { kind: "star", pointCount: 5, innerRadius: .4 } }), createPointId)!;

    expect(polygon.subpaths[0]).toMatchObject({ closed: true, points: expect.any(Array) });
    expect(polygon.subpaths[0]!.points).toHaveLength(6);
    expect(star.subpaths[0]!.points).toHaveLength(10);
    expect(new Set([...pointIds(polygon), ...pointIds(star)]).size).toBe(16);
  });
});
