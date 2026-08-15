import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { nodeContainsWorldPoint } from "./hit-test";
import { exportPageToSvg } from "./svg-export";
import { vectorPathContains, vectorPathSvgD } from "./vector-path";

describe("canonical VectorPath", () => {
  const path = {
    fillRule: "nonZero" as const,
    subpaths: [{
      closed: true,
      points: [
        { id: "00000000-0000-0000-0000-000000000011", x: 0, y: 0, pointType: "corner" as const, handleOut: { x: 25, y: 0 } },
        { id: "00000000-0000-0000-0000-000000000012", x: 100, y: 0, pointType: "corner" as const, handleIn: { x: -25, y: 0 } },
        { id: "00000000-0000-0000-0000-000000000013", x: 50, y: 100, pointType: "corner" as const },
      ],
    }],
  };

  it("uses relative cubic handles consistently for hit testing and SVG", () => {
    expect(vectorPathSvgD(path)).toContain("C 25 0 75 0 100 0");
    expect(vectorPathContains(path, { x: 50, y: 40 })).toBe(true);
    expect(vectorPathContains(path, { x: 105, y: 50 })).toBe(false);
  });

  it("exports the same canonical path used by exact vector hit testing", () => {
    const node = { ...createNode("vector", 0, 0), id: "00000000-0000-0000-0000-000000000002", pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000002:00000000000000000000000000000000", vectorPath: path };
    expect(nodeContainsWorldPoint(node, { x: 50, y: 40 })).toBe(true);
    const result = exportPageToSvg([node], { pageId: node.pageId, defaultPageId: node.pageId, padding: 0 });
    expect(result.svg).toContain('d="M 0 0 C 25 0 75 0 100 0 L 50 100 L 0 0 Z"');
  });

  it("keeps multi-subpath even-odd holes and open contours consistent in SVG and fill hit testing", () => {
    const multiPath = {
      fillRule: "evenOdd" as const,
      subpaths: [
        { closed: true, points: [
          { id: "00000000-0000-0000-0000-000000000021", x: 0, y: 0, pointType: "corner" as const },
          { id: "00000000-0000-0000-0000-000000000022", x: 160, y: 0, pointType: "corner" as const },
          { id: "00000000-0000-0000-0000-000000000023", x: 160, y: 160, pointType: "corner" as const },
          { id: "00000000-0000-0000-0000-000000000024", x: 0, y: 160, pointType: "corner" as const },
        ] },
        { closed: true, points: [
          { id: "00000000-0000-0000-0000-000000000025", x: 48, y: 48, pointType: "corner" as const },
          { id: "00000000-0000-0000-0000-000000000026", x: 112, y: 48, pointType: "corner" as const },
          { id: "00000000-0000-0000-0000-000000000027", x: 112, y: 112, pointType: "corner" as const },
          { id: "00000000-0000-0000-0000-000000000028", x: 48, y: 112, pointType: "corner" as const },
        ] },
        { closed: false, points: [
          { id: "00000000-0000-0000-0000-000000000029", x: 180, y: 0, pointType: "corner" as const },
          { id: "00000000-0000-0000-0000-00000000002a", x: 220, y: 40, pointType: "corner" as const },
        ] },
      ],
    };

    expect(vectorPathContains(multiPath, { x: 24, y: 80 })).toBe(true);
    expect(vectorPathContains(multiPath, { x: 80, y: 80 })).toBe(false);
    expect(vectorPathSvgD(multiPath)).toBe("M 0 0 L 160 0 L 160 160 L 0 160 L 0 0 Z M 48 48 L 112 48 L 112 112 L 48 112 L 48 48 Z M 180 0 L 220 40");
  });

  it("distinguishes even-odd holes from non-zero contour winding", () => {
    const outer = [
      { id: "00000000-0000-0000-0000-000000000031", x: 0, y: 0, pointType: "corner" as const },
      { id: "00000000-0000-0000-0000-000000000032", x: 160, y: 0, pointType: "corner" as const },
      { id: "00000000-0000-0000-0000-000000000033", x: 160, y: 160, pointType: "corner" as const },
      { id: "00000000-0000-0000-0000-000000000034", x: 0, y: 160, pointType: "corner" as const },
    ];
    const innerSameWinding = [
      { id: "00000000-0000-0000-0000-000000000035", x: 48, y: 48, pointType: "corner" as const },
      { id: "00000000-0000-0000-0000-000000000036", x: 112, y: 48, pointType: "corner" as const },
      { id: "00000000-0000-0000-0000-000000000037", x: 112, y: 112, pointType: "corner" as const },
      { id: "00000000-0000-0000-0000-000000000038", x: 48, y: 112, pointType: "corner" as const },
    ];
    const atCentre = { x: 80, y: 80 };

    expect(vectorPathContains({ fillRule: "evenOdd", subpaths: [{ closed: true, points: outer }, { closed: true, points: innerSameWinding }] }, atCentre)).toBe(false);
    expect(vectorPathContains({ fillRule: "nonZero", subpaths: [{ closed: true, points: outer }, { closed: true, points: innerSameWinding }] }, atCentre)).toBe(true);
    expect(vectorPathContains({ fillRule: "nonZero", subpaths: [{ closed: true, points: outer }, { closed: true, points: [...innerSameWinding].reverse() }] }, atCentre)).toBe(false);
  });

  it("hits a closed contour boundary for both fill rules", () => {
    const square = {
      subpaths: [{ closed: true, points: [
        { id: "00000000-0000-0000-0000-000000000041", x: 0, y: 0, pointType: "corner" as const },
        { id: "00000000-0000-0000-0000-000000000042", x: 100, y: 0, pointType: "corner" as const },
        { id: "00000000-0000-0000-0000-000000000043", x: 100, y: 100, pointType: "corner" as const },
        { id: "00000000-0000-0000-0000-000000000044", x: 0, y: 100, pointType: "corner" as const },
      ] }],
    };

    expect(vectorPathContains({ ...square, fillRule: "evenOdd" }, { x: 50, y: 0 })).toBe(true);
    expect(vectorPathContains({ ...square, fillRule: "nonZero" }, { x: 100, y: 50 })).toBe(true);
    expect(vectorPathContains({ ...square, fillRule: "nonZero" }, { x: 100.001, y: 50 })).toBe(false);
  });

  it("does not let a steep cubic's fixed chord expand the filled hit region", () => {
    const steepCurve = {
      fillRule: "nonZero" as const,
      subpaths: [{ closed: true, points: [
        { id: "00000000-0000-0000-0000-000000000061", x: 0, y: 0, pointType: "corner" as const, handleOut: { x: 0, y: 10_000 } },
        { id: "00000000-0000-0000-0000-000000000062", x: 100, y: 0, pointType: "corner" as const, handleIn: { x: 0, y: 10_000 } },
        { id: "00000000-0000-0000-0000-000000000063", x: 100, y: 11_000, pointType: "corner" as const },
        { id: "00000000-0000-0000-0000-000000000064", x: 0, y: 11_000, pointType: "corner" as const },
      ] }],
    };

    // Near t=1/24 the true curve is around y=1,198. A fixed 12-step chord
    // incorrectly places its edge around y=598, selecting this outside point.
    expect(vectorPathContains(steepCurve, { x: .499, y: 1_000 })).toBe(false);
    expect(vectorPathContains(steepCurve, { x: .499, y: 1_400 })).toBe(true);
  });

  it("safely rejects fallback hit testing when adaptive flattening exceeds the Core point budget", () => {
    const overBudgetCurve = {
      fillRule: "nonZero" as const,
      subpaths: [{ closed: true, points: [
        { id: "00000000-0000-0000-0000-000000000071", x: 0, y: 0, pointType: "corner" as const, handleOut: { x: 0, y: 1e12 } },
        { id: "00000000-0000-0000-0000-000000000072", x: 100, y: 0, pointType: "corner" as const, handleIn: { x: 0, y: 1e12 } },
        { id: "00000000-0000-0000-0000-000000000073", x: 100, y: 1e12, pointType: "corner" as const },
        { id: "00000000-0000-0000-0000-000000000074", x: 0, y: 1e12, pointType: "corner" as const },
      ] }],
    };

    expect(vectorPathContains(overBudgetCurve, { x: 50, y: 1 })).toBe(false);
  });
});
