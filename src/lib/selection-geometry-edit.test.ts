import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/documents/phase2-common-nodes.fixture.json";
import { createNode, type CanvasNode } from "./editor-protocol";
import { selectionGeometryPatches } from "./selection-geometry-edit";

describe("selectionGeometryPatches", () => {
  it("moves rotated relative-v1 Fixture nodes by their collective world X", () => {
    const nodes = fixture.nodes as unknown as CanvasNode[];
    const selected = [
      "00000000-0000-4000-8000-000000002004",
      "00000000-0000-4000-8000-000000002005",
    ];
    const before = selectionGeometryPatches(nodes, selected, {});
    const edited = selectionGeometryPatches(nodes, selected, { x: (before?.selection.bounds.x ?? 0) + 20 });

    expect(edited?.patches.size).toBe(2);
    expect(edited?.patches.get(selected[0])).toMatchObject({ width: 180, height: 128, relativeTransform: expect.any(Object) });
    expect(edited?.patches.get(selected[1])).toMatchObject({ width: 112, height: 112, relativeTransform: expect.any(Object) });
  });

  it("scales unrotated legacy geometry without inventing relative transforms", () => {
    const first = { ...createNode("rectangle", 10, 20), id: "first", width: 20, height: 10 };
    const second = { ...createNode("rectangle", 50, 30), id: "second", width: 10, height: 30 };
    const result = selectionGeometryPatches([first, second], [first.id, second.id], { width: 100 });

    expect(result?.patches.get(first.id)).toEqual({ x: 10, y: 20, width: 40, height: 10 });
    expect(result?.patches.get(second.id)).toEqual({ x: 90, y: 30, width: 20, height: 30 });
  });
});
