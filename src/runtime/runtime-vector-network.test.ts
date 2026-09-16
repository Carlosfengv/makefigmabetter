import { describe, expect, it } from "vitest";
import type { DocumentVectorPath } from "../lib/editor-protocol";
import { canonicalVectorPathFromRuntimeNetwork, extensionsWithRuntimeVectorNetwork, runtimeVectorNetworkFromCanonical, runtimeVectorNetworkFromExtension } from "./runtime-vector-network";

describe("Runtime VectorNetwork adapter", () => {
  it("round-trips independent open cubic chains and closed regions", () => {
    const path: DocumentVectorPath = {
      fillRule: "evenOdd",
      subpaths: [
        {
          closed: false,
          points: [
            { id: "a", x: 0, y: 0, handleOut: { x: 15, y: 5 }, pointType: "asymmetric" },
            { id: "b", x: 40, y: 20, handleIn: { x: -10, y: 0 }, pointType: "mirrored" },
          ],
        },
        {
          closed: true,
          points: [
            { id: "c", x: 60, y: 0, pointType: "corner" },
            { id: "d", x: 100, y: 0, pointType: "corner" },
            { id: "e", x: 80, y: 40, pointType: "corner" },
          ],
        },
      ],
    };

    const network = runtimeVectorNetworkFromCanonical(path, "round", "arrowEquilateral");
    expect(network).toEqual({
      vertices: [
        { x: 0, y: 0, strokeCap: "ROUND", handleMirroring: "ANGLE" },
        { x: 40, y: 20, strokeCap: "ARROW_EQUILATERAL", handleMirroring: "ANGLE_AND_LENGTH" },
        { x: 60, y: 0, handleMirroring: "NONE" },
        { x: 100, y: 0, handleMirroring: "NONE" },
        { x: 80, y: 40, handleMirroring: "NONE" },
      ],
      segments: [
        { start: 0, end: 1, tangentStart: { x: 15, y: 5 }, tangentEnd: { x: -10, y: 0 } },
        { start: 2, end: 3 },
        { start: 3, end: 4 },
        { start: 4, end: 2 },
      ],
      regions: [{ windingRule: "EVENODD", loops: [[1, 2, 3]] }],
    });

    let sequence = 0;
    const converted = canonicalVectorPathFromRuntimeNetwork(network, () => `p-${sequence++}`, {
      strokeCapStart: "none",
      strokeCapEnd: "none",
      strokeJoin: "miter",
    });
    expect(converted).toMatchObject({
      strokeCapStart: "round",
      strokeCapEnd: "arrowEquilateral",
      path: {
        fillRule: "evenOdd",
        subpaths: [
          { closed: false, points: [{ x: 0, y: 0, handleOut: { x: 15, y: 5 }, pointType: "asymmetric" }, { x: 40, y: 20, handleIn: { x: -10, y: 0 }, pointType: "mirrored" }] },
          { closed: true, points: [{ x: 60, y: 0 }, { x: 100, y: 0 }, { x: 80, y: 40 }] },
        ],
      },
    });
  });

  it("accepts endpoint-specific caps and one uniform per-vertex join", () => {
    let sequence = 0;
    const converted = canonicalVectorPathFromRuntimeNetwork({
      vertices: [
        { x: 0, y: 0, strokeCap: "SQUARE", strokeJoin: "ROUND" },
        { x: 20, y: 0, strokeJoin: "ROUND" },
        { x: 40, y: 0, strokeCap: "TRIANGLE_FILLED", strokeJoin: "ROUND" },
      ],
      segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }],
    }, () => `p-${sequence++}`, { strokeCapStart: "none", strokeCapEnd: "none", strokeJoin: "miter" });

    expect(converted).toMatchObject({ strokeCapStart: "square", strokeCapEnd: "triangleFilled", strokeJoin: "round" });
  });

  it("materializes a bounded open branch while preserving exact topology in an extension", () => {
    let sequence = 0;
    const network = {
      vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
      segments: [{ start: 0, end: 1 }, { start: 0, end: 2, tangentStart: { x: 2, y: 1 } }],
    } as const;
    const converted = canonicalVectorPathFromRuntimeNetwork(network, () => `branch-${sequence++}`, {
      strokeCapStart: "none",
      strokeCapEnd: "none",
      strokeJoin: "miter",
    });
    expect(converted).toMatchObject({
      network,
      path: {
        fillRule: "nonZero",
        subpaths: [
          { closed: false, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
          { closed: false, points: [{ x: 0, y: 0, handleOut: { x: 2, y: 1 } }, { x: 10, y: 10 }] },
        ],
      },
    });
    if ("reason" in converted) throw new Error(converted.reason);
    const extensions = extensionsWithRuntimeVectorNetwork({ keep: [7] }, converted.network, converted.path);
    expect(runtimeVectorNetworkFromExtension(extensions, converted.path)).toEqual(network);
    expect(runtimeVectorNetworkFromExtension(extensions, { ...converted.path, fillRule: "evenOdd" })).toBeUndefined();
    expect(extensionsWithRuntimeVectorNetwork(extensions, undefined)).toEqual({ keep: [7] });
  });

  it("rejects network details that neither VectorPath nor the bounded branch extension can render", () => {
    const defaults = { strokeCapStart: "none" as const, strokeCapEnd: "none" as const, strokeJoin: "miter" as const };
    const allocate = () => "point";
    expect(canonicalVectorPathFromRuntimeNetwork({
      vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
      segments: [{ start: 0, end: 1 }, { start: 0, end: 2 }],
      regions: [{ windingRule: "NONZERO", loops: [[0, 1]] }],
    }, allocate, defaults)).toMatchObject({ reason: expect.stringContaining("regions") });
    expect(canonicalVectorPathFromRuntimeNetwork({
      vertices: [{ x: 0, y: 0, strokeCap: "ROUND" }, { x: 10, y: 0 }, { x: 10, y: 10 }],
      segments: [{ start: 0, end: 1 }, { start: 0, end: 2 }],
    }, allocate, defaults)).toMatchObject({ reason: expect.stringContaining("NONE endpoint caps") });
    expect(canonicalVectorPathFromRuntimeNetwork({
      vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }],
      segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 0 }],
      regions: [{ windingRule: "NONZERO", loops: [[0, 1, 2]], fills: [] }],
    }, allocate, defaults)).toMatchObject({ reason: expect.stringContaining("region-local") });
    expect(canonicalVectorPathFromRuntimeNetwork({
      vertices: [{ x: 0, y: 0, cornerRadius: 2 }],
      segments: [],
    }, allocate, defaults)).toMatchObject({ reason: expect.stringContaining("corner radii") });
    expect(canonicalVectorPathFromRuntimeNetwork({
      vertices: [{ x: 0, y: 0, strokeCap: "ROUND" }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }],
      segments: [{ start: 0, end: 1 }, { start: 2, end: 3 }],
    }, allocate, defaults)).toMatchObject({ reason: expect.stringContaining("shared start cap") });
    expect(canonicalVectorPathFromRuntimeNetwork({
      vertices: [{ x: 0, y: 0, strokeJoin: "ROUND" }, { x: 10, y: 0 }],
      segments: [{ start: 0, end: 1 }],
    }, allocate, defaults)).toMatchObject({ reason: expect.stringContaining("mixed per-vertex") });
  });
});
