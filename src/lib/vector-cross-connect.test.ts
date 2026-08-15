import { describe, expect, it } from "vitest";
import { createNode, type CanvasNode } from "./editor-protocol";
import { joinCrossVectorEndpoints } from "./vector-cross-connect";

const pageId = "00000000-0000-0000-0000-000000000001";
const point = (id: string, x: number, y: number, patch: Record<string, unknown> = {}) => ({ id, x, y, pointType: "corner" as const, ...patch });
const vector = (id: string, x: number, points: ReturnType<typeof point>[]): CanvasNode => ({
  ...createNode("vector", x, 0), id, pageId, width: 100, height: 100,
  vectorPath: { fillRule: "nonZero", subpaths: [{ closed: false, points }] },
});

describe("cross-Vector endpoint connection", () => {
  it("merges an equally positioned source endpoint into the target and preserves the target PointId", () => {
    const target = vector("target", 0, [point("a", 0, 0), point("b", 20, 0)]);
    const source = vector("source", 20, [point("c", 0, 0), point("d", 20, 0)]);

    const result = joinCrossVectorEndpoints([target, source], target, { subpathIndex: 0, pointId: "b" }, source, { subpathIndex: 0, pointId: "c" });

    expect(result?.targetPath.subpaths[0]?.points.map((candidate) => candidate.id)).toEqual(["a", "b", "d"]);
    expect(result?.targetPath.subpaths[0]?.points.map((candidate) => [candidate.x, candidate.y])).toEqual([[0, 0], [20, 0], [40, 0]]);
    expect(result?.sourcePath).toBeUndefined();
  });

  it("reverses the source endpoint and maps its outgoing tangent into target-local space", () => {
    const target = vector("target", 0, [point("a", 0, 0), point("b", 20, 0)]);
    const source = vector("source", 20, [
      point("far", 20, 0),
      point("join", 0, 0, { handleIn: { x: -4, y: 6 }, pointType: "asymmetric" }),
    ]);

    const result = joinCrossVectorEndpoints([target, source], target, { subpathIndex: 0, pointId: "b" }, source, { subpathIndex: 0, pointId: "join" });
    const joined = result?.targetPath.subpaths[0]?.points[1];

    expect(result?.targetPath.subpaths[0]?.points.map((candidate) => candidate.id)).toEqual(["a", "b", "far"]);
    expect(joined).toMatchObject({ id: "b", handleOut: { x: -4, y: 6 }, pointType: "asymmetric" });
  });

  it("maps a Relative-v1 rotated source and its handle through shared world space", () => {
    const frame = { ...createNode("frame", 100, 100), id: "frame", pageId, width: 200, height: 200 };
    const target = {
      ...vector("target", 0, [point("a", 0, 0), point("b", 20, 0)]), parentId: frame.id,
      relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    };
    const source = {
      ...vector("source", 0, [point("join", 0, 0, { handleOut: { x: 5, y: 0 }, pointType: "asymmetric" }), point("far", 0, 20)]), parentId: frame.id,
      relativeTransform: { a: 0, b: 1, c: -1, d: 0, e: 20, f: 0 },
    };

    const result = joinCrossVectorEndpoints([frame, target, source], target, { subpathIndex: 0, pointId: "b" }, source, { subpathIndex: 0, pointId: "join" });
    const joined = result?.targetPath.subpaths[0]?.points[1];

    expect(joined).toMatchObject({ id: "b", handleOut: { x: 0, y: 5 }, pointType: "asymmetric" });
    expect(result?.targetPath.subpaths[0]?.points.at(-1)).toMatchObject({ id: "far", x: 0, y: 0 });
  });

  it("retains unrelated source subpaths instead of deleting their layer", () => {
    const target = vector("target", 0, [point("a", 0, 0), point("b", 20, 0)]);
    const source = { ...vector("source", 20, [point("c", 0, 0), point("d", 20, 0)]), vectorPath: {
      fillRule: "nonZero" as const,
      subpaths: [
        { closed: false, points: [point("c", 0, 0), point("d", 20, 0)] },
        { closed: false, points: [point("e", 40, 0), point("f", 60, 0)] },
      ],
    } };

    const result = joinCrossVectorEndpoints([target, source], target, { subpathIndex: 0, pointId: "b" }, source, { subpathIndex: 0, pointId: "c" });

    expect(result?.targetPath.subpaths[0]?.points.map((candidate) => candidate.id)).toEqual(["a", "b", "d"]);
    expect(result?.sourcePath?.subpaths).toHaveLength(1);
    expect(result?.sourcePath?.subpaths[0]?.points.map((candidate) => candidate.id)).toEqual(["e", "f"]);
  });
});
