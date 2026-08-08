import { describe, expect, it } from "vitest";
import { isEffectivelyLocked } from "./hierarchy-lock";
import type { CanvasNode } from "./editor-protocol";

const node = (id: string, parentId?: string, locked = false): CanvasNode => ({
  id,
  parentId,
  name: id,
  kind: "rectangle",
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  rotation: 0,
  fill: "#fff",
  stroke: "transparent",
  strokeWidth: 0,
  radius: 0,
  opacity: 1,
  locked,
});

describe("effective hierarchy lock", () => {
  it("inherits locks and fails closed on a parent cycle", () => {
    expect(isEffectivelyLocked(new Map([["group", node("group", undefined, true)], ["child", node("child", "group")]]), "child")).toBe(true);
    expect(isEffectivelyLocked(new Map([["a", node("a", "b")], ["b", node("b", "a")]]), "a")).toBe(true);
  });
});
