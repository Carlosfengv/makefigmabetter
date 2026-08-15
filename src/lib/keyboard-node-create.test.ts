import { describe, expect, it } from "vitest";
import { createKeyboardToolNode } from "./keyboard-node-create";

describe("createKeyboardToolNode", () => {
  const viewport = { x: 240, y: -90, zoom: 2 };
  const surface = { width: 1200, height: 800 };

  it("centres a default rectangle in the current world viewport", () => {
    const node = createKeyboardToolNode({ tool: "rectangle", viewport, surface });
    expect(node).toMatchObject({ kind: "rectangle", x: -330, y: 30, width: 180, height: 120 });
  });

  it("uses the same Line plus cap mapping as the arrow drawing tool", () => {
    const node = createKeyboardToolNode({ tool: "arrow", viewport, surface });
    expect(node).toMatchObject({ kind: "line", name: "Arrow", x: -320, y: 90, width: 160, height: 0, strokeCapEnd: "arrowLines" });
  });

  it("creates a valid closed VectorPath without entering Pen editing", () => {
    const node = createKeyboardToolNode({ tool: "vector", viewport, surface });
    expect(node).toMatchObject({ kind: "vector", x: -320, y: 30, width: 160, height: 120, vectorPath: { fillRule: "nonZero", subpaths: [{ closed: true }] } });
    expect(node?.vectorPath?.subpaths[0].points).toHaveLength(3);
  });

  it("does not create document nodes for navigation tools or the interactive Pen", () => {
    expect(createKeyboardToolNode({ tool: "select", viewport, surface })).toBeUndefined();
    expect(createKeyboardToolNode({ tool: "hand", viewport, surface })).toBeUndefined();
    expect(createKeyboardToolNode({ tool: "pen", viewport, surface })).toBeUndefined();
  });
});
