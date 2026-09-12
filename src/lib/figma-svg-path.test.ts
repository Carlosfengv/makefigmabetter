import { describe, expect, it } from "vitest";
import { parseFigmaSvgPaths } from "./figma-svg-path";

describe("Figma SVG path conversion", () => {
  it("converts relative lines, cubic curves and closures into stable editable handles", () => {
    let id = 1;
    const parsed = parseFigmaSvgPaths([
      { path: "M 0 0 L 20 0 c 10 0 10 20 20 20 l -40 0 z", windingRule: "NONZERO" },
    ], () => `00000000-0000-4000-8000-${(id++).toString().padStart(12, "0")}`);

    expect("path" in parsed).toBe(true);
    if (!("path" in parsed)) return;
    expect(parsed.path).toEqual({
      fillRule: "nonZero",
      subpaths: [{ closed: true, points: [
        { id: "00000000-0000-4000-8000-000000000001", x: 0, y: 0, pointType: "corner" },
        { id: "00000000-0000-4000-8000-000000000002", x: 20, y: 0, handleOut: { x: 10, y: 0 }, pointType: "asymmetric" },
        { id: "00000000-0000-4000-8000-000000000003", x: 40, y: 20, handleIn: { x: -10, y: 0 }, pointType: "asymmetric" },
        { id: "00000000-0000-4000-8000-000000000004", x: 0, y: 20, pointType: "corner" },
      ]}],
    });
  });

  it("turns quadratic geometry into exact cubic handles and keeps even-odd fill", () => {
    let id = 10;
    const parsed = parseFigmaSvgPaths([{ path: "M0 0 Q 30 60 60 0 T 120 0", windingRule: "EVENODD" }], () => `00000000-0000-4000-8000-${(id++).toString().padStart(12, "0")}`);

    expect("path" in parsed).toBe(true);
    if (!("path" in parsed)) return;
    expect(parsed.path.fillRule).toBe("evenOdd");
    expect(parsed.path.subpaths[0]?.points).toEqual([
      expect.objectContaining({ x: 0, y: 0, handleOut: { x: 20, y: 40 }, pointType: "asymmetric" }),
      expect.objectContaining({ x: 60, y: 0, handleIn: { x: -20, y: 40 }, handleOut: { x: 20, y: -40 }, pointType: "asymmetric" }),
      expect.objectContaining({ x: 120, y: 0, handleIn: { x: -20, y: -40 }, pointType: "asymmetric" }),
    ]);
  });

  it("normalizes an explicit duplicate closing endpoint and keeps its incoming cubic handle", () => {
    let id = 30;
    const parsed = parseFigmaSvgPaths([{ path: "M0 0 C10 0 20 0 30 0 C30 10 30 20 30 30 C20 30 -10 10 0 0 Z" }], () => `00000000-0000-4000-8000-${(id++).toString().padStart(12, "0")}`);

    expect("path" in parsed).toBe(true);
    if (!("path" in parsed)) return;
    const subpath = parsed.path.subpaths[0];
    expect(subpath?.closed).toBe(true);
    expect(subpath?.points).toHaveLength(3);
    expect(subpath?.points[0]).toMatchObject({
      x: 0,
      y: 0,
      handleOut: { x: 10, y: 0 },
      handleIn: { x: -10, y: 10 },
      pointType: "asymmetric",
    });
    expect(subpath?.points.at(-1)).toMatchObject({ x: 30, y: 30 });
  });

  it("keeps a distinct final anchor when Z contributes the closing segment", () => {
    let id = 40;
    const parsed = parseFigmaSvgPaths([{ path: "M0 0 L30 0 L30 30 Z" }], () => `00000000-0000-4000-8000-${(id++).toString().padStart(12, "0")}`);

    expect("path" in parsed).toBe(true);
    if (!("path" in parsed)) return;
    expect(parsed.path.subpaths[0]).toMatchObject({ closed: true, points: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }] });
  });

  it("converts SVG elliptical arcs into bounded editable cubic handles", () => {
    let id = 20;
    const parsed = parseFigmaSvgPaths([{ path: "M0 0 A10 10 0 0 1 10 10" }], () => `00000000-0000-4000-8000-${(id++).toString().padStart(12, "0")}`);

    expect("path" in parsed).toBe(true);
    if (!("path" in parsed)) return;
    const points = parsed.path.subpaths[0]?.points ?? [];
    expect(points).toHaveLength(5);
    expect(points[0]).toMatchObject({ x: 0, y: 0, handleOut: { x: expect.closeTo(1.313), y: 0 } });
    expect(points.at(-1)).toMatchObject({ x: 10, y: 10, handleIn: { x: 0, y: expect.closeTo(-1.313) } });
    expect(points.every((point) => point.pointType === "asymmetric" || point.id === points[0]?.id)).toBe(true);
  });

  it("rejects malformed arc flags, malformed commands, mixed winding rules and insufficient paths", () => {
    const ids = () => "00000000-0000-4000-8000-000000000001";
    expect(parseFigmaSvgPaths([{ path: "M0 0 A 10 10 0 2 0 20 0" }], ids)).toEqual(expect.objectContaining({ reason: expect.stringContaining("flags") }));
    expect(parseFigmaSvgPaths([{ path: "M0 0 L" }], ids)).toEqual(expect.objectContaining({ reason: expect.stringContaining("incomplete") }));
    expect(parseFigmaSvgPaths([{ path: "M0 0 L1 0", windingRule: "NONZERO" }, { path: "M0 0 L0 1", windingRule: "EVENODD" }], ids)).toEqual(expect.objectContaining({ reason: expect.stringContaining("Mixed") }));
  });
});
