import { describe, expect, it } from "vitest";
import type { DocumentPaintStack, DocumentVectorPath } from "../lib/editor-protocol";
import { canonicalVectorPathFromRuntimeNetwork, extensionsWithRuntimeVectorNetwork, runtimeVectorNetworkFromCanonical, runtimeVectorNetworkFromExtension, vectorNetworkMixedStrokeMeshFromExtension, vectorNetworkRegionPaintPlansFromExtension, vectorNetworkStrokeMeshContains } from "./runtime-vector-network";

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
    const network = {
      vertices: [
        { x: 0, y: 0, strokeCap: "SQUARE", strokeJoin: "ROUND" },
        { x: 20, y: 0, strokeJoin: "ROUND" },
        { x: 40, y: 0, strokeCap: "TRIANGLE_FILLED", strokeJoin: "ROUND" },
      ],
      segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }],
    } as const;
    const converted = canonicalVectorPathFromRuntimeNetwork(network, () => `p-${sequence++}`, { strokeCapStart: "none", strokeCapEnd: "none", strokeJoin: "miter" });

    expect(converted).toMatchObject({ strokeCapStart: "square", strokeCapEnd: "triangleFilled", strokeJoin: "round", network });
    if ("reason" in converted) throw new Error(converted.reason);
    const extensions = extensionsWithRuntimeVectorNetwork({}, converted.network, converted.path);
    expect(runtimeVectorNetworkFromExtension(extensions, converted.path)).toEqual(network);
  });

  it("materializes non-overlapping straight corner radii and preserves the authored network", () => {
    let sequence = 0;
    const network = {
      vertices: [
        { x: 0, y: 0, cornerRadius: 10 },
        { x: 40, y: 0, cornerRadius: 10 },
        { x: 40, y: 40, cornerRadius: 10 },
        { x: 0, y: 40, cornerRadius: 10 },
      ],
      segments: [
        { start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 0 },
      ],
      regions: [{ windingRule: "NONZERO" as const, loops: [[0, 1, 2, 3]] }],
    };
    const converted = canonicalVectorPathFromRuntimeNetwork(network, () => `rounded-${sequence++}`, {
      strokeCapStart: "none", strokeCapEnd: "none", strokeJoin: "miter",
    });
    if ("reason" in converted) throw new Error(converted.reason);

    expect(converted.network).toEqual(network);
    expect(converted.path.subpaths[0]).toMatchObject({
      closed: true,
      points: [
        { x: 0, y: 10, handleOut: { x: 0, y: expect.closeTo(-5.5228474983) } },
        { x: 10, y: 0, handleIn: { x: expect.closeTo(-5.5228474983), y: 0 } },
        { x: 30, y: 0 },
        { x: 40, y: 10 },
        { x: 40, y: 30 },
        { x: 30, y: 40 },
        { x: 10, y: 40 },
        { x: 0, y: 30 },
      ],
    });
    const extensions = extensionsWithRuntimeVectorNetwork({}, converted.network, converted.path);
    expect(runtimeVectorNetworkFromExtension(extensions, converted.path)).toEqual(network);

    const overlapping = canonicalVectorPathFromRuntimeNetwork({
      vertices: [{ x: 0, y: 0 }, { x: 10, y: 0, cornerRadius: 20 }, { x: 10, y: 10 }],
      segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }],
    }, () => "overlap", { strokeCapStart: "none", strokeCapEnd: "none", strokeJoin: "miter" });
    expect(overlapping).toMatchObject({ reason: expect.stringContaining("overlap") });
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

  it("materializes one globally styled filled loop plus open branch edges", () => {
    let sequence = 0;
    const network = {
      vertices: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 20 }, { x: -10, y: 10 }],
      segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 0 }, { start: 0, end: 3 }],
      regions: [{ windingRule: "EVENODD" as const, loops: [[0, 1, 2]] }],
    };
    const converted = canonicalVectorPathFromRuntimeNetwork(network, () => `filled-${sequence++}`, {
      strokeCapStart: "none",
      strokeCapEnd: "none",
      strokeJoin: "round",
    });

    expect(converted).toMatchObject({
      network,
      strokeJoin: "round",
      path: {
        fillRule: "evenOdd",
        subpaths: [
          { closed: true, points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 20 }] },
          { closed: false, points: [{ x: 0, y: 0 }, { x: -10, y: 10 }] },
        ],
      },
    });
  });

  it("materializes multiple regions with independent winding rules", () => {
    let sequence = 0;
    const network = {
      vertices: [
        { x: 20, y: 20 },
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 0, y: 40 },
        { x: 40, y: 40 },
      ],
      segments: [
        { start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 0 },
        { start: 0, end: 3 }, { start: 3, end: 4 }, { start: 4, end: 0 },
      ],
      regions: [
        { windingRule: "NONZERO" as const, loops: [[0, 1, 2]] },
        { windingRule: "EVENODD" as const, loops: [[3, 4, 5]] },
      ],
    };
    const converted = canonicalVectorPathFromRuntimeNetwork(network, () => `multi-${sequence++}`, {
      strokeCapStart: "none",
      strokeCapEnd: "none",
      strokeJoin: "round",
    });

    expect(converted).toMatchObject({
      network,
      path: {
        fillRule: "nonZero",
        subpaths: [
          { closed: true, points: [{ x: 20, y: 20 }, { x: 0, y: 0 }, { x: 40, y: 0 }] },
          { closed: true, points: [{ x: 20, y: 20 }, { x: 0, y: 40 }, { x: 40, y: 40 }] },
        ],
      },
      regionPaths: [
        { fillRule: "nonZero", subpaths: [{ closed: true }] },
        { fillRule: "evenOdd", subpaths: [{ closed: true }] },
      ],
    });
  });

  it("persists bounded region PaintStacks separately from exact shared topology", () => {
    let sequence = 0;
    const network = {
      vertices: [
        { x: 20, y: 20 }, { x: 0, y: 0 }, { x: 40, y: 0 },
        { x: 0, y: 40 }, { x: 40, y: 40 },
      ],
      segments: [
        { start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 0 },
        { start: 0, end: 3 }, { start: 3, end: 4 }, { start: 4, end: 0 },
      ],
      regions: [
        { windingRule: "NONZERO" as const, loops: [[0, 1, 2]], fills: [{ type: "SOLID" as const, color: { r: 1, g: 0, b: 0 }, opacity: .5 }] },
        { windingRule: "NONZERO" as const, loops: [[3, 4, 5]], fills: [] },
      ],
    };
    const converted = canonicalVectorPathFromRuntimeNetwork(network, () => `region-${sequence++}`, {
      strokeCapStart: "none", strokeCapEnd: "none", strokeJoin: "miter",
    });
    if ("reason" in converted) throw new Error(converted.reason);
    const red: DocumentPaintStack = { layers: [{
      visible: true,
      opacity: .5,
      blendMode: "normal",
      paint: { css: "#ff0000", color: { space: "srgb", components: [1, 0, 0], alpha: 1 } },
    }] };
    const extensions = extensionsWithRuntimeVectorNetwork({}, network, converted.path, [
      { hasExplicitFills: true, fillStack: red },
      { hasExplicitFills: true, fillStack: { layers: [] } },
    ]);

    expect(runtimeVectorNetworkFromExtension(extensions, converted.path)?.regions).toEqual([
      expect.objectContaining({ fills: [expect.objectContaining({ type: "SOLID", opacity: .5 })] }),
      expect.objectContaining({ fills: [] }),
    ]);
    const plans = vectorNetworkRegionPaintPlansFromExtension(extensions, converted.path);
    expect(plans).toHaveLength(2);
    expect(plans?.[0]).toMatchObject({ path: { subpaths: [{ closed: true }] }, fillStack: { layers: [{ opacity: .5 }] } });
    expect(plans?.[1]).toMatchObject({ path: { subpaths: [{ closed: true }] }, fillStack: { layers: [] } });
  });

  it("keeps a region style link while rendering its resolved PaintStack", () => {
    let sequence = 0;
    const network = {
      vertices: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 0, y: 20 }],
      segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 0 }],
      regions: [{ windingRule: "NONZERO" as const, loops: [[0, 1, 2]], fillStyleId: "paint-style-blue" }],
    };
    const converted = canonicalVectorPathFromRuntimeNetwork(network, () => `style-${sequence++}`, {
      strokeCapStart: "none", strokeCapEnd: "none", strokeJoin: "miter",
    });
    if ("reason" in converted) throw new Error(converted.reason);
    const blue: DocumentPaintStack = { layers: [{
      visible: true,
      opacity: 1,
      blendMode: "normal",
      paint: { css: "#0000ff", color: { space: "srgb", components: [0, 0, 1], alpha: 1 } },
    }] };
    const extensions = extensionsWithRuntimeVectorNetwork({}, network, converted.path, [
      { hasExplicitFills: false, fillStack: blue },
    ]);

    expect(runtimeVectorNetworkFromExtension(extensions, converted.path)?.regions?.[0]).toEqual({
      windingRule: "NONZERO",
      loops: [[0, 1, 2]],
      fillStyleId: "paint-style-blue",
    });
    expect(vectorNetworkRegionPaintPlansFromExtension(extensions, converted.path)?.[0]?.fillStack).toMatchObject({
      layers: [{ paint: { css: "#0000ffff" } }],
    });
  });

  it("materializes mixed active joins as one shared straight-network stroke mesh", () => {
    let sequence = 0;
    const network = {
      vertices: [
        { x: 0, y: 0 },
        { x: 20, y: 0, strokeJoin: "ROUND" as const },
        { x: 20, y: 20, strokeJoin: "BEVEL" as const },
        { x: 40, y: 20 },
        { x: 40, y: 40 },
      ],
      segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 4 }],
    };
    const converted = canonicalVectorPathFromRuntimeNetwork(network, () => `mixed-${sequence++}`, {
      strokeCapStart: "none", strokeCapEnd: "none", strokeJoin: "miter",
    });
    if ("reason" in converted) throw new Error(converted.reason);
    expect(converted.network).toEqual(network);
    expect(converted.strokeJoin).toBeUndefined();
    const extensions = extensionsWithRuntimeVectorNetwork({}, converted.network, converted.path);
    const mesh = vectorNetworkMixedStrokeMeshFromExtension(extensions, converted.path, {
      strokeWidth: 4,
      strokeCapStart: "none",
      strokeCapEnd: "none",
      strokeJoin: "miter",
      strokeMiterLimit: 10,
    });

    expect(mesh?.bounds).toEqual({ min: { x: 0, y: -2 }, max: { x: 42, y: 40 } });
    expect(mesh?.triangles.length).toBeGreaterThan(20);
    expect(mesh && vectorNetworkStrokeMeshContains(mesh, { x: 21, y: -1 })).toBe(true);
    expect(mesh && vectorNetworkStrokeMeshContains(mesh, { x: 18.25, y: 21.75 })).toBe(false);
    expect(mesh && vectorNetworkStrokeMeshContains(mesh, { x: 41.5, y: 18.5 })).toBe(true);

    expect(canonicalVectorPathFromRuntimeNetwork({
      ...network,
      segments: [{ start: 0, end: 1 }, { start: 1, end: 2, tangentStart: { x: 1, y: 0 } }, { start: 2, end: 3 }, { start: 3, end: 4 }],
    }, () => "curve", { strokeCapStart: "none", strokeCapEnd: "none", strokeJoin: "miter" }))
      .toMatchObject({ reason: expect.stringContaining("straight") });
  });

  it("rejects network details that neither VectorPath nor the bounded branch extension can render", () => {
    const defaults = { strokeCapStart: "none" as const, strokeCapEnd: "none" as const, strokeJoin: "miter" as const };
    const allocate = () => "point";
    expect(canonicalVectorPathFromRuntimeNetwork({
      vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
      segments: [{ start: 0, end: 1 }, { start: 0, end: 2 }],
      regions: [{ windingRule: "NONZERO", loops: [[0, 1]] }],
    }, allocate, defaults)).toMatchObject({ reason: expect.stringContaining("at least three") });
    expect(canonicalVectorPathFromRuntimeNetwork({
      vertices: [{ x: 0, y: 0, strokeCap: "ROUND" }, { x: 10, y: 0 }, { x: 10, y: 10 }],
      segments: [{ start: 0, end: 1 }, { start: 0, end: 2 }],
    }, allocate, defaults)).toMatchObject({ reason: expect.stringContaining("NONE endpoint caps") });
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
    }, allocate, defaults)).toMatchObject({ network: expect.any(Object) });
  });
});
