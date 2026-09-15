import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { findTopmostCanvasSelectionCandidate, findTopmostHit, nodeContainsWorldPoint, strokeDashContains } from "./hit-test";

describe("Canvas primitive hit testing", () => {
  it("uses local coordinates for a rotated rectangle", () => {
    const node = { ...createNode("rectangle", 0, 0), width: 100, height: 40, radius: 0, rotation: 90 };

    expect(nodeContainsWorldPoint(node, { x: 50, y: 60 })).toBe(true);
    expect(nodeContainsWorldPoint(node, { x: 95, y: 20 })).toBe(false);
  });

  it("selects a hanging list marker outside Text geometry", () => {
    const text = {
      ...createNode("text", 0, 0), width: 100, height: 40, text: "One",
      textProperties: {
        runs: [{ start: 0, end: 3, fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0 }],
        paragraph: { alignment: "left" as const, paragraphSpacing: 0, listType: "ordered" as const, hangingList: true },
        autoSize: "fixed" as const,
      },
    };

    expect(nodeContainsWorldPoint(text, { x: -20, y: 15 })).toBe(true);
    expect(nodeContainsWorldPoint({ ...text, textProperties: { ...text.textProperties, paragraph: { ...text.textProperties.paragraph, hangingList: false } } }, { x: -20, y: 15 })).toBe(false);

    const shape = { ...text, kind: "shapeWithText" as const, shapeWithTextType: "DIAMOND" as const };
    expect(nodeContainsWorldPoint(shape, { x: -20, y: 15 })).toBe(true);
    expect(nodeContainsWorldPoint(shape, { x: 5, y: 5 })).toBe(false);
  });

  it("does not select transparent corners of ellipses and rounded rectangles", () => {
    const ellipse = { ...createNode("ellipse", 0, 0), width: 100, height: 100 };
    const rounded = { ...createNode("rectangle", 120, 0), width: 100, height: 100, radius: 30 };

    expect(nodeContainsWorldPoint(ellipse, { x: 0, y: 0 })).toBe(false);
    expect(nodeContainsWorldPoint(ellipse, { x: 50, y: 50 })).toBe(true);
    expect(nodeContainsWorldPoint(rounded, { x: 120, y: 0 })).toBe(false);
    expect(nodeContainsWorldPoint(rounded, { x: 150, y: 10 })).toBe(true);
  });

  it("uses each persisted corner radius when hit-testing rectangles and Sections", () => {
    const rectangle = { ...createNode("rectangle", 0, 0), width: 100, height: 80, radius: 0, cornerRadii: [30, 0, 20, 0] as [number, number, number, number] };
    const section = { ...createNode("section", 120, 0), width: 100, height: 80, radius: 0, cornerRadii: [0, 24, 0, 0] as [number, number, number, number] };

    expect(nodeContainsWorldPoint(rectangle, { x: 0, y: 0 })).toBe(false);
    expect(nodeContainsWorldPoint(rectangle, { x: 99, y: 0 })).toBe(true);
    expect(nodeContainsWorldPoint(section, { x: 220, y: 0 })).toBe(false);
    expect(nodeContainsWorldPoint(section, { x: 120, y: 0 })).toBe(true);
  });

  it("uses the continuous-corner curve for smoothed corners", () => {
    const circular = { ...createNode("rectangle", 0, 0), width: 100, height: 80, radius: 30 };
    const smoothed = { ...circular, cornerSmoothing: 1 };

    expect(nodeContainsWorldPoint(circular, { x: 5, y: 5 })).toBe(false);
    expect(nodeContainsWorldPoint(smoothed, { x: 5, y: 5 })).toBe(true);
  });

  it("uses stroke distance for zero-height rotated lines", () => {
    const line = { ...createNode("line", 0, 0), width: 100, height: 0, rotation: 90, strokeWidth: 2 };

    expect(nodeContainsWorldPoint(line, { x: 0, y: 50 })).toBe(true);
    expect(nodeContainsWorldPoint(line, { x: 12, y: 50 })).toBe(false);
  });

  it("extends a Line hit target to cover its arrowhead", () => {
    const arrow = { ...createNode("line", 0, 0), width: 100, height: 0, strokeWidth: 2, strokeCapEnd: "arrowLines" as const };

    expect(nodeContainsWorldPoint(arrow, { x: 96, y: 8 })).toBe(true);
  });

  it("hits visible round and square cap extents but not the Canvas Butt fallback for asymmetric dashes", () => {
    const round = { ...createNode("line", 0, 0), width: 100, height: 0, strokeWidth: 10, strokeCapStart: "round" as const };
    const square = { ...createNode("line", 0, 0), width: 100, height: 0, strokeWidth: 10, strokeCapEnd: "square" as const };
    const asymmetricDash = { ...round, strokeDashPattern: [8, 4], strokeCapEnd: "square" as const };

    expect(nodeContainsWorldPoint(round, { x: -4, y: 0 })).toBe(true);
    expect(nodeContainsWorldPoint(square, { x: 104, y: 4 })).toBe(true);
    expect(nodeContainsWorldPoint(asymmetricDash, { x: -4, y: 0 })).toBe(false);
  });

  it("does not hit-test through a dashed Line gap and normalizes odd patterns", () => {
    const dashed = { ...createNode("line", 0, 0), width: 100, height: 0, strokeWidth: 2, strokeDashPattern: [10, 10] };

    expect(nodeContainsWorldPoint(dashed, { x: 5, y: 0 })).toBe(true);
    expect(nodeContainsWorldPoint(dashed, { x: 15, y: 0 })).toBe(false);
    expect(strokeDashContains(45, [10, 10, 10])).toBe(true);
    expect(strokeDashContains(15, [10, 10, 10])).toBe(false);
  });

  it("does not hit the cap outside an unpainted terminal dash gap", () => {
    const dashedSquare = { ...createNode("line", 0, 0), width: 94, height: 0, strokeWidth: 10, strokeDashPattern: [8, 4], strokeCapStart: "square" as const, strokeCapEnd: "square" as const };
    expect(nodeContainsWorldPoint(dashedSquare, { x: -4, y: 0 })).toBe(true);
    expect(nodeContainsWorldPoint(dashedSquare, { x: 96, y: 0 })).toBe(false);
  });

  it("includes Center and Outside stroke render bounds for Rectangle selection", () => {
    const rectangle = { ...createNode("rectangle", 0, 0), width: 100, height: 60, radius: 0, strokeWidth: 8, strokeAlign: "outside" as const };
    expect(nodeContainsWorldPoint(rectangle, { x: -6, y: 30 })).toBe(true);
    expect(nodeContainsWorldPoint({ ...rectangle, strokeAlign: "center" }, { x: -3, y: 30 })).toBe(true);
    expect(nodeContainsWorldPoint({ ...rectangle, strokeAlign: "inside" }, { x: -1, y: 30 })).toBe(false);
  });

  it("expands explicit Rectangle corner radii with a uniform aligned Stroke", () => {
    const rectangle = {
      ...createNode("rectangle", 0, 0), width: 100, height: 60, radius: 0,
      cornerRadii: [20, 5, 30, 10] as [number, number, number, number],
      strokeWidth: 8, strokeAlign: "outside" as const,
    };
    // The visual top-left corner stays centred at (20, 20), while its outer
    // radius grows from 20 to 28. This point lies on that expanded contour.
    expect(nodeContainsWorldPoint(rectangle, { x: -7.9, y: 20 })).toBe(true);
  });

  it("includes Center and Outside Stroke render bounds for full Ellipse selection", () => {
    const ellipse = { ...createNode("ellipse", 0, 0), width: 100, height: 60, strokeWidth: 8, strokeAlign: "outside" as const };
    expect(nodeContainsWorldPoint(ellipse, { x: -7, y: 30 })).toBe(true);
    expect(nodeContainsWorldPoint({ ...ellipse, strokeAlign: "center" }, { x: -3, y: 30 })).toBe(true);
    expect(nodeContainsWorldPoint({ ...ellipse, strokeAlign: "inside" }, { x: -1, y: 30 })).toBe(false);
  });

  it("uses donut radius and arc sweep for Ellipse hit testing", () => {
    const arc = { ...createNode("ellipse", 0, 0), width: 100, height: 100, arcData: { startingAngle: 0, endingAngle: 180, innerRadius: .4 } };
    expect(nodeContainsWorldPoint(arc, { x: 90, y: 50 })).toBe(true);
    expect(nodeContainsWorldPoint(arc, { x: 50, y: 50 })).toBe(false);
    expect(nodeContainsWorldPoint(arc, { x: 10, y: 50 })).toBe(true);
    expect(nodeContainsWorldPoint(arc, { x: 50, y: 10 })).toBe(false);
  });

  it("selects a Vector on its filled contour boundary", () => {
    const vector = {
      ...createNode("vector", 20, 30), width: 100, height: 80,
      vectorPath: {
        fillRule: "nonZero" as const,
        subpaths: [{ closed: true, points: [
          { id: "00000000-0000-0000-0000-000000000051", x: 0, y: 0, pointType: "corner" as const },
          { id: "00000000-0000-0000-0000-000000000052", x: 100, y: 0, pointType: "corner" as const },
          { id: "00000000-0000-0000-0000-000000000053", x: 100, y: 80, pointType: "corner" as const },
          { id: "00000000-0000-0000-0000-000000000054", x: 0, y: 80, pointType: "corner" as const },
        ] }],
      },
    };

    expect(nodeContainsWorldPoint(vector, { x: 70, y: 30 })).toBe(true);
    expect(nodeContainsWorldPoint(vector, { x: 70, y: 29.99 })).toBe(false);
  });

  it("selects a Group through its derived bounds", () => {
    const group = { ...createNode("group", 10, 20), width: 80, height: 40 };

    expect(nodeContainsWorldPoint(group, { x: 50, y: 40 })).toBe(true);
    expect(nodeContainsWorldPoint(group, { x: 5, y: 40 })).toBe(false);
  });

  it("prioritizes a visible child over an overlapping Group bounds hit", () => {
    const child = { ...createNode("ellipse", 20, 20), id: "child", width: 30, height: 30 };
    const group = { ...createNode("group", 0, 0), id: "group", width: 100, height: 100 };
    expect(findTopmostHit([child, group], { x: 35, y: 35 })?.id).toBe(child.id);
    expect(findTopmostHit([child, group], { x: 80, y: 80 })?.id).toBe(group.id);
  });

  it("respects layer order, visibility and locks", () => {
    const back = { ...createNode("rectangle", 0, 0), id: "back", width: 100, height: 100 };
    const locked = { ...createNode("rectangle", 0, 0), id: "locked", width: 100, height: 100, locked: true };
    const top = { ...createNode("rectangle", 0, 0), id: "top", width: 100, height: 100 };

    expect(findTopmostHit([back, locked, top], { x: 20, y: 20 })?.id).toBe("top");
    expect(findTopmostHit([back, { ...top, visible: false }], { x: 20, y: 20 })?.id).toBe("back");
  });

  it("passes canvas clicks through non-painted Slice export regions", () => {
    const painted = { ...createNode("rectangle", 0, 0), id: "painted", width: 100, height: 100 };
    const slice = { ...createNode("slice", 0, 0), id: "slice", width: 100, height: 100 };

    expect(findTopmostCanvasSelectionCandidate([slice, painted])?.id).toBe("painted");
    expect(findTopmostCanvasSelectionCandidate([slice])).toBeUndefined();
  });
});
