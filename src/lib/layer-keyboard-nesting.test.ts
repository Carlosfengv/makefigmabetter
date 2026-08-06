import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { layerKeyboardNestingTarget } from "./layer-keyboard-nesting";

const position = (value: number) => `${value.toString(16).padStart(32, "0")}:00000000000000000000000000000007`;

describe("Layer keyboard nesting", () => {
  it("indents into the immediately preceding visible container sibling", () => {
    const back = { ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000001", positionId: position(1) };
    const current = { ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000002", positionId: position(2) };
    const frontFrame = { ...createNode("frame", 0, 0), id: "00000000-0000-4000-8000-000000000003", positionId: position(3) };

    expect(layerKeyboardNestingTarget([back, current, frontFrame], current.id, "indent")).toEqual({ id: current.id, parentId: frontFrame.id });
    expect(layerKeyboardNestingTarget([back, current], current.id, "indent")).toBeUndefined();
  });

  it("outdents one hierarchy level and leaves root layers unchanged", () => {
    const frame = { ...createNode("frame", 0, 0), id: "00000000-0000-4000-8000-000000000001" };
    const group = { ...createNode("group", 0, 0), id: "00000000-0000-4000-8000-000000000002", parentId: frame.id };
    const child = { ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000003", parentId: group.id };

    expect(layerKeyboardNestingTarget([frame, group, child], child.id, "outdent")).toEqual({ id: child.id, parentId: frame.id });
    expect(layerKeyboardNestingTarget([frame, group, child], frame.id, "outdent")).toBeUndefined();
  });
});
