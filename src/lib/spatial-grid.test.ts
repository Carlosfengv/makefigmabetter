import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { createSpatialGridIndex } from "./spatial-grid";
import { rotatedNodeBounds } from "./marquee-selection";

describe("Worker spatial grid", () => {
  it("returns only cell candidates in document z-order without duplicates", () => {
    const first = { ...createNode("rectangle", 0, 0), width: 2_000, height: 20 };
    const second = { ...createNode("rectangle", 100, 100), width: 20, height: 20 };
    const outside = { ...createNode("rectangle", 8_000, 8_000), width: 20, height: 20 };
    const index = createSpatialGridIndex([first, second, outside], rotatedNodeBounds, 256);
    expect(index.query({ x: 90, y: 90, width: 80, height: 80 }).map((node) => node.id)).toEqual([first.id, second.id]);
  });

  it("keeps enormous nodes queryable without exploding grid storage", () => {
    const huge = { ...createNode("rectangle", -1_000_000, -1_000_000), width: 2_000_000, height: 2_000_000 };
    const index = createSpatialGridIndex([huge], rotatedNodeBounds);
    expect(index.largeNodeCount).toBe(1);
    expect(index.cellCount).toBe(0);
    expect(index.query({ x: 0, y: 0, width: 1, height: 1 })).toEqual([huge]);
  });
});
