import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { resolveMultiResizeSelection } from "./multi-selection";
import fixture from "../../fixtures/documents/phase2-common-nodes.fixture.json";

describe("resolveMultiResizeSelection", () => {
  it("uses visual Line bounds and a shared world-space selection frame", () => {
    const rectangle = { ...createNode("rectangle", 10, 20), id: "rectangle", width: 30, height: 40 };
    const line = { ...createNode("line", 50, 30), id: "line", width: 40, strokeWidth: 10, strokeCapStart: "round" as const, strokeCapEnd: "round" as const };

    expect(resolveMultiResizeSelection([rectangle, line], ["rectangle", "line"])).toMatchObject({
      ids: ["rectangle", "line"],
      bounds: { x: 10, y: 20, width: 85, height: 40 },
      requiresAffine: false,
    });
  });

  it("uses full Ellipse Center/Outside paint bounds for the shared selection frame", () => {
    const rectangle = { ...createNode("rectangle", 0, 0), id: "rectangle", width: 10, height: 10 };
    const ellipse = { ...createNode("ellipse", 20, 0), id: "ellipse", width: 100, height: 60, strokeWidth: 8, strokeAlign: "outside" as const };

    expect(resolveMultiResizeSelection([rectangle, ellipse], [rectangle.id, ellipse.id])).toMatchObject({
      bounds: { x: 0, y: -8, width: 128, height: 76 },
    });
  });

  it("expands a selected Group to its editable descendants in parent-first order", () => {
    const group = { ...createNode("group", 0, 0), id: "group", width: 80, height: 40 };
    const frame = { ...createNode("frame", 0, 0), id: "frame", parentId: group.id, width: 80, height: 40 };
    const child = { ...createNode("rectangle", 10, 10), id: "child", parentId: frame.id, width: 20, height: 10 };

    expect(resolveMultiResizeSelection([group, frame, child], [group.id])).toMatchObject({
      ids: ["frame", "child"],
      bounds: { x: 0, y: 0, width: 80, height: 40 },
      requiresAffine: true,
    });
  });

  it("derives Group bounds from children instead of stale compatibility geometry", () => {
    // The Group record can briefly retain its pre-resize scalar bounds while
    // its children already have their committed matrices. Canvas hover must use
    // this same child-derived envelope as Group selection.
    const group = { ...createNode("group", 0, 0), id: "group", width: 40, height: 20 };
    const first = { ...createNode("rectangle", 100, 50), id: "first", parentId: group.id, width: 30, height: 20 };
    const second = { ...createNode("ellipse", 180, 90), id: "second", parentId: group.id, width: 40, height: 30 };

    expect(resolveMultiResizeSelection([group, first, second], [group.id])?.bounds).toEqual({
      x: 100, y: 50, width: 120, height: 70,
    });
  });

  it("resolves the rotated Fixture Card and Ellipse selected together", () => {
    const nodes = fixture.nodes as unknown as ReturnType<typeof createNode>[];
    expect(resolveMultiResizeSelection(nodes, [
      "00000000-0000-4000-8000-000000002004",
      "00000000-0000-4000-8000-000000002005",
    ])).toMatchObject({
      ids: [
        "00000000-0000-4000-8000-000000002004",
        "00000000-0000-4000-8000-000000002005",
      ],
      requiresAffine: true,
    });
  });
});
