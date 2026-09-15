import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/documents/phase2-common-nodes.fixture.json";
import { createNode, type CanvasNode } from "./editor-protocol";
import { selectionGeometryPatches } from "./selection-geometry-edit";
import { transformGroupRepeatWorldBounds } from "./transform-group-repeat";

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

  it("scales Repeat source and derived occurrences through the canonical wrapper", () => {
    const repeat = {
      ...createNode("transformGroup", 20, 30),
      id: "repeat",
      width: 100,
      height: 80,
      transformModifiers: [
        { type: "REPEAT" as const, count: 1, unitType: "RELATIVE" as const, offset: 1, repeatType: "LINEAR" as const, axis: "HORIZONTAL" as const },
        { type: "REPEAT" as const, count: 1, unitType: "PIXELS" as const, offset: 80, repeatType: "LINEAR" as const, axis: "VERTICAL" as const },
      ],
    };
    const source = {
      ...createNode("rectangle", 0, 0),
      id: "source",
      parentId: repeat.id,
      width: 20,
      height: 10,
      relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    };
    const sibling = { ...createNode("rectangle", 300, 30), id: "sibling", width: 20, height: 20 };
    const nodes = [repeat, source, sibling];
    const before = selectionGeometryPatches(nodes, [repeat.id, sibling.id], {})!;
    const result = selectionGeometryPatches(nodes, [repeat.id, sibling.id], {
      width: before.selection.bounds.width * 2,
      height: before.selection.bounds.height / 2,
    })!;

    const repeatPatch = result.patches.get(repeat.id)!;
    expect(repeatPatch).toMatchObject({ width: 100, height: 80, relativeTransform: expect.objectContaining({ a: 2, d: .5 }) });
    expect(result.patches.has(source.id)).toBe(false);
    const resized = nodes.map((node) => ({ ...node, ...result.patches.get(node.id) }));
    const repeatBounds = transformGroupRepeatWorldBounds(resized, resized[0]!)!;
    const originalRepeatBounds = transformGroupRepeatWorldBounds(nodes, repeat)!;
    expect(repeatBounds).toEqual({
      left: before.selection.bounds.x + (originalRepeatBounds.left - before.selection.bounds.x) * 2,
      top: before.selection.bounds.y + (originalRepeatBounds.top - before.selection.bounds.y) * .5,
      right: before.selection.bounds.x + (originalRepeatBounds.right - before.selection.bounds.x) * 2,
      bottom: before.selection.bounds.y + (originalRepeatBounds.bottom - before.selection.bounds.y) * .5,
    });
  });

  it("edits one Repeat visual envelope through only its canonical wrapper", () => {
    const repeat = {
      ...createNode("transformGroup", 20, 30),
      id: "repeat",
      width: 100,
      height: 80,
      transformModifiers: [{
        type: "REPEAT" as const,
        count: 2,
        unitType: "RELATIVE" as const,
        offset: 1.5,
        repeatType: "LINEAR" as const,
        axis: "HORIZONTAL" as const,
      }],
    };
    const source = {
      ...createNode("rectangle", 0, 0),
      id: "source",
      parentId: repeat.id,
      width: 20,
      height: 10,
      relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    };
    const nodes = [repeat, source];
    const before = selectionGeometryPatches(nodes, [repeat.id], {})!;
    const result = selectionGeometryPatches(nodes, [repeat.id], {
      x: before.selection.bounds.x + 10,
      width: before.selection.bounds.width * 1.5,
      height: before.selection.bounds.height / 2,
    })!;

    expect(result.selection.bounds).toEqual({ x: 20, y: 30, width: 320, height: 80 });
    expect(result.selection.ids).toEqual([repeat.id]);
    expect(result.patches.has(source.id)).toBe(false);
    expect(result.patches.get(repeat.id)).toMatchObject({
      width: 100,
      height: 80,
      relativeTransform: expect.objectContaining({ a: 1.5, d: .5, e: 30, f: 30 }),
    });
    const resized = nodes.map((node) => ({ ...node, ...result.patches.get(node.id) }));
    expect(transformGroupRepeatWorldBounds(resized, resized[0]!)).toEqual({
      left: 30,
      top: 30,
      right: 510,
      bottom: 70,
    });
  });
});
