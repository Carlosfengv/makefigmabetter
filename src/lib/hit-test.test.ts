import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { findTopmostHit, nodeContainsWorldPoint } from "./hit-test";

describe("Canvas primitive hit testing", () => {
  it("uses local coordinates for a rotated rectangle", () => {
    const node = { ...createNode("rectangle", 0, 0), width: 100, height: 40, radius: 0, rotation: 90 };

    expect(nodeContainsWorldPoint(node, { x: 50, y: 60 })).toBe(true);
    expect(nodeContainsWorldPoint(node, { x: 95, y: 20 })).toBe(false);
  });

  it("does not select transparent corners of ellipses and rounded rectangles", () => {
    const ellipse = { ...createNode("ellipse", 0, 0), width: 100, height: 100 };
    const rounded = { ...createNode("rectangle", 120, 0), width: 100, height: 100, radius: 30 };

    expect(nodeContainsWorldPoint(ellipse, { x: 0, y: 0 })).toBe(false);
    expect(nodeContainsWorldPoint(ellipse, { x: 50, y: 50 })).toBe(true);
    expect(nodeContainsWorldPoint(rounded, { x: 120, y: 0 })).toBe(false);
    expect(nodeContainsWorldPoint(rounded, { x: 150, y: 10 })).toBe(true);
  });

  it("respects layer order, visibility and locks", () => {
    const back = { ...createNode("rectangle", 0, 0), id: "back", width: 100, height: 100 };
    const locked = { ...createNode("rectangle", 0, 0), id: "locked", width: 100, height: 100, locked: true };
    const top = { ...createNode("rectangle", 0, 0), id: "top", width: 100, height: 100 };

    expect(findTopmostHit([back, locked, top], { x: 20, y: 20 })?.id).toBe("top");
    expect(findTopmostHit([back, { ...top, visible: false }], { x: 20, y: 20 })?.id).toBe("back");
  });
});
