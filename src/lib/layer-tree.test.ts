import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { layerTreeRows } from "./layer-tree";

const node = (id: string, kind: ReturnType<typeof createNode>["kind"], parentId?: string) => ({ ...createNode(kind, 0, 0), id, parentId });

describe("layer tree rows", () => {
  it("retains a collapsed container while hiding every descendant", () => {
    const frame = node("frame", "frame");
    const group = node("group", "group", frame.id);
    const rectangle = node("rectangle", "rectangle", group.id);
    const root = node("root", "section");

    expect(layerTreeRows([frame, group, rectangle, root], new Set([frame.id])).map((row) => [row.node.id, row.depth, row.hasChildren, row.collapsed])).toEqual([
      [frame.id, 0, true, true], [root.id, 0, false, false],
    ]);
  });

  it("keeps corrupt cyclic records inspectable once", () => {
    const first = node("first", "group", "second");
    const second = node("second", "frame", first.id);

    expect(layerTreeRows([first, second]).map((row) => row.node.id)).toEqual([first.id, second.id]);
  });
});
