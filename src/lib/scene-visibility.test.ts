import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { collectVisibleNodes, viewportWorldBounds } from "./scene-visibility";

describe("scene visibility", () => {
  it("converts a viewport into world bounds with overscan", () => {
    expect(viewportWorldBounds({ x: 10, y: -5, zoom: 2 }, 400, 200, 100)).toEqual({ x: -160, y: -95, width: 300, height: 200 });
  });

  it("keeps z-order and includes rotated edge intersections", () => {
    const first = { ...createNode("rectangle", -10, -10), width: 20, height: 20 };
    const rotated = { ...createNode("rectangle", 50, 0), width: 80, height: 10, rotation: 45 };
    const hidden = { ...createNode("rectangle", 0, 0), visible: false };
    expect(collectVisibleNodes([first, rotated, hidden], { x: -20, y: -20, width: 80, height: 80 }).map((node) => node.id)).toEqual([first.id, rotated.id]);
  });
});
