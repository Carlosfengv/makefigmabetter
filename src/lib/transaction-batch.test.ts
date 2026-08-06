import { describe, expect, it } from "vitest";
import { createNode, type CanvasNode } from "./editor-protocol";
import { transformPoint, worldTransformForNode } from "./scene-transform";
import { resolveCoreBatch } from "./transaction-batch";

function rectangle(id: string): CanvasNode {
  return { ...createNode("rectangle", 10, 20), id };
}

describe("Core transaction batch resolution", () => {
  it("resolves sequential partial edits to concrete Core values", () => {
    const first = rectangle("00000000-0000-4000-8000-000000000001");
    const second = rectangle("00000000-0000-4000-8000-000000000002");
    const created = rectangle("00000000-0000-4000-8000-000000000003");

    const resolved = resolveCoreBatch([first, second], [
      { type: "update", id: first.id, patch: { name: "Hero", x: 48, stroke: "#000000" } },
      { type: "create", node: created },
      { type: "delete", ids: [second.id] },
    ]);

    expect(resolved?.batch).toEqual([
      expect.objectContaining({ type: "update", node: expect.objectContaining({ id: first.id, name: "Hero", x: 48, stroke: "#000000", strokeWidth: first.strokeWidth, cornerRadius: first.radius }) }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: created.id }) }),
      { type: "delete", ids: [second.id] },
    ]);
    expect(resolved?.batch[0]).toMatchObject({ type: "update", node: { text: "" } });
    expect(resolved?.nextNodes).toEqual([
      expect.objectContaining({ id: first.id, name: "Hero", x: 48, stroke: "#000000" }),
      created,
    ]);
  });

  it("resolves a multi-selection visual edit as one all-or-nothing Core batch", () => {
    const first = rectangle("00000000-0000-4000-8000-000000000001");
    const second = { ...rectangle("00000000-0000-4000-8000-000000000002"), visible: false, locked: true };
    const resolved = resolveCoreBatch([first, second], [
      { type: "update", id: first.id, patch: { opacity: .4, visible: true, locked: false } },
      { type: "update", id: second.id, patch: { opacity: .4, visible: true, locked: false } },
    ]);

    expect(resolved?.batch).toHaveLength(2);
    expect(resolved?.nextNodes).toEqual([
      expect.objectContaining({ id: first.id, opacity: .4, visible: true, locked: false }),
      expect.objectContaining({ id: second.id, opacity: .4, visible: true, locked: false }),
    ]);
  });

  it("keeps an axis-aligned Frame resize and its sibling selection update in one Core batch", () => {
    const frame = { ...createNode("frame", 0, 0), id: "00000000-0000-4000-8000-000000000001", width: 200, height: 120 };
    const sibling = { ...rectangle("00000000-0000-4000-8000-000000000002"), x: 240, y: 20, width: 40, height: 30 };
    const resolved = resolveCoreBatch([frame, sibling], [
      { type: "update", id: frame.id, patch: { x: 0, y: 0, width: 320, height: 180 } },
      { type: "update", id: sibling.id, patch: { x: 384, y: 30, width: 64, height: 45 } },
    ]);

    expect(resolved?.batch).toHaveLength(2);
    expect(resolved?.batch.map((entry) => entry.type)).toEqual(["update", "update"]);
    expect(resolved?.nextNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: frame.id, width: 320, height: 180 }),
      expect.objectContaining({ id: sibling.id, x: 384, y: 30, width: 64, height: 45 }),
    ]));
  });

  it("lets an explicit multi-selection Solid Paint edit replace only the legacy paint fields", () => {
    const first = rectangle("00000000-0000-4000-8000-000000000001");
    const second = { ...rectangle("00000000-0000-4000-8000-000000000002"), fill: "#f6ad62", stroke: "#b4612d" };
    const patch = { fill: "#112233", fills: undefined, fillGradient: undefined, stroke: "#445566", strokes: undefined, strokeGradient: undefined };
    const resolved = resolveCoreBatch([first, second], [
      { type: "update", id: first.id, patch },
      { type: "update", id: second.id, patch },
    ]);

    expect(resolved?.nextNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, fill: "#112233", stroke: "#445566", fills: undefined, strokes: undefined }),
      expect.objectContaining({ id: second.id, fill: "#112233", stroke: "#445566", fills: undefined, strokes: undefined }),
    ]));
  });

  it("includes text content in the concrete Core payload", () => {
    const text = { ...createNode("text", 10, 20), id: "00000000-0000-4000-8000-000000000001", text: "Before" };
    const resolved = resolveCoreBatch([text], [{ type: "update", id: text.id, patch: { text: "After" } }]);

    expect(resolved?.batch).toEqual([
      expect.objectContaining({ type: "update", node: expect.objectContaining({ id: text.id, text: "After" }) }),
    ]);
  });

  it("keeps Line endpoint decorations in the concrete Core payload", () => {
    const line = { ...createNode("line", 0, 0), id: "00000000-0000-4000-8000-000000000001", width: 120, height: 0 };
    const resolved = resolveCoreBatch([line], [{ type: "update", id: line.id, patch: { strokeCapStart: "diamondFilled", strokeCapEnd: "arrowEquilateral" } }]);

    expect(resolved?.batch).toEqual([expect.objectContaining({ type: "update", node: expect.objectContaining({ strokeCapStart: "diamondFilled", strokeCapEnd: "arrowEquilateral" }) })]);
  });

  it("expands a container delete into a stable child-first Core batch", () => {
    const frame = { ...createNode("frame", 0, 0), id: "00000000-0000-4000-8000-000000000001" };
    const group = { ...createNode("group", 0, 0), id: "00000000-0000-4000-8000-000000000002", parentId: frame.id };
    const child = { ...rectangle("00000000-0000-4000-8000-000000000003"), parentId: group.id };
    const resolved = resolveCoreBatch([frame, group, child], [{ type: "delete", ids: [frame.id] }]);

    expect(resolved?.batch).toEqual([{ type: "delete", ids: [child.id, frame.id] }]);
    expect(resolved?.nextNodes).toEqual([]);
  });

  it("preserves explicit fractional Inspector coordinates without applying canvas snapping", () => {
    const node = rectangle("00000000-0000-4000-8000-000000000001");
    const resolved = resolveCoreBatch([node], [{ type: "update", id: node.id, patch: { x: -249.25, y: 12.5 } }]);

    expect(resolved?.nextNodes[0]).toMatchObject({ x: -249.25, y: 12.5 });
    expect(resolved?.batch[0]).toMatchObject({ type: "update", node: { x: -249.25, y: 12.5 } });
  });

  it("resizes a Section without changing descendants or applying Frame clip semantics", () => {
    const section = { ...createNode("section", 20, 30), id: "00000000-0000-4000-8000-000000000001", width: 640, height: 360 };
    const child = { ...rectangle("00000000-0000-4000-8000-000000000002"), parentId: section.id, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 80, f: 64 } };
    const before = worldTransformForNode([section, child], child.id);
    const resolved = resolveCoreBatch([section, child], [{ type: "update", id: section.id, patch: { width: 720, height: 420 } }]);
    const resized = resolved?.nextNodes.find((node) => node.id === section.id);
    const unchangedChild = resolved?.nextNodes.find((node) => node.id === child.id);

    expect(resized).toMatchObject({ width: 720, height: 420 });
    expect(resized?.clipsContent).toBeUndefined();
    expect(unchangedChild).toEqual(child);
    expect(worldTransformForNode(resolved!.nextNodes, child.id)).toEqual(before);
  });

  it("preserves an explicit wide-gamut color through unrelated Core updates", () => {
    const node = { ...rectangle("00000000-0000-4000-8000-000000000001"), fillColor: { space: "display-p3" as const, components: [0.2, 0.8, 0.4] as [number, number, number], alpha: 1 }, positionId: "00000000000000000000000000000010:00000000000000000000000000000007" };
    const resolved = resolveCoreBatch([node], [{ type: "update", id: node.id, patch: { name: "P3 card" } }]);

    expect(resolved?.batch[0]).toMatchObject({ type: "update", node: { fillColor: node.fillColor, positionId: node.positionId } });
  });

  it("reparents hierarchy roots atomically while preserving world geometry", () => {
    const oldParent = { ...createNode("frame", 100, 40), id: "00000000-0000-4000-8000-000000000001", width: 240, height: 120, rotation: 20 };
    const newParent = { ...createNode("frame", -80, 60), id: "00000000-0000-4000-8000-000000000002", width: 180, height: 100, rotation: -30 };
    const child = { ...rectangle("00000000-0000-4000-8000-000000000003"), parentId: oldParent.id, x: 36, y: 72, width: 80, height: 40, positionId: "00000000000000000000000000000003:00000000000000000000000000000000" };
    const grandchild = { ...rectangle("00000000-0000-4000-8000-000000000004"), parentId: child.id, x: 62, y: 88, width: 20, height: 20 };
    const before = worldTransformForNode([oldParent, newParent, child, grandchild], child.id)!;
    const resolved = resolveCoreBatch([oldParent, newParent, child, grandchild], [{ type: "reparent", ids: [child.id, grandchild.id], parentId: newParent.id }]);

    expect(resolved?.batch.map((entry) => entry.type)).toEqual(["update", "reparent"]);
    expect(resolved?.batch[1]).toMatchObject({ type: "reparent", parentIds: [{ id: child.id, parentId: newParent.id }] });
    const movedChild = resolved!.nextNodes.find((node) => node.id === child.id)!;
    const movedGrandchild = resolved!.nextNodes.find((node) => node.id === grandchild.id)!;
    expect(movedChild).toMatchObject({ parentId: newParent.id, relativeTransform: expect.any(Object) });
    // A selected descendant moves with its root instead of being flattened.
    expect(movedGrandchild.parentId).toBe(child.id);
    const after = worldTransformForNode(resolved!.nextNodes, child.id)!;
    for (const point of [{ x: 0, y: 0 }, { x: child.width, y: child.height }]) {
      expect(transformPoint(after, point).x).toBeCloseTo(transformPoint(before, point).x, 10);
      expect(transformPoint(after, point).y).toBeCloseTo(transformPoint(before, point).y, 10);
    }
  });

  it("rejects reparenting across pages or into a selected descendant", () => {
    const parent = { ...createNode("frame", 0, 0), id: "00000000-0000-4000-8000-000000000001" };
    const child = { ...rectangle("00000000-0000-4000-8000-000000000002"), parentId: parent.id };
    const otherPage = { ...createNode("frame", 0, 0), id: "00000000-0000-4000-8000-000000000003", pageId: "00000000-0000-0000-0000-000000000099" };
    expect(resolveCoreBatch([parent, child], [{ type: "reparent", ids: [parent.id], parentId: child.id }])).toBeUndefined();
    expect(resolveCoreBatch([parent, child, otherPage], [{ type: "reparent", ids: [child.id], parentId: otherPage.id }])).toBeUndefined();
  });

  it("preserves a Canonical linear gradient through unrelated Core updates", () => {
    const gradient = { start: [0, 0] as [number, number], end: [1, 1] as [number, number], stops: [
      { position: 0, color: { space: "srgb" as const, components: [0.1, 0.2, 0.3] as [number, number, number], alpha: 1 } },
      { position: 1, color: { space: "srgb" as const, components: [0.8, 0.5, 0.2] as [number, number, number], alpha: 1 } },
    ] };
    const node = { ...rectangle("00000000-0000-4000-8000-000000000001"), fillGradient: gradient };
    const resolved = resolveCoreBatch([node], [{ type: "update", id: node.id, patch: { name: "Gradient card" } }]);

    expect(resolved?.batch[0]).toMatchObject({ type: "update", node: { fillGradient: gradient } });
  });

  it("preserves a Canonical stroke gradient through unrelated Core updates", () => {
    const gradient = { start: [0, 0] as [number, number], end: [1, 1] as [number, number], stops: [
      { position: 0, color: { space: "srgb" as const, components: [0.1, 0.2, 0.3] as [number, number, number], alpha: 1 } },
      { position: 1, color: { space: "srgb" as const, components: [0.8, 0.5, 0.2] as [number, number, number], alpha: 1 } },
    ] };
    const node = { ...rectangle("00000000-0000-4000-8000-000000000001"), strokeGradient: gradient, strokeWidth: 3 };
    const resolved = resolveCoreBatch([node], [{ type: "update", id: node.id, patch: { name: "Gradient outline" } }]);

    expect(resolved?.batch[0]).toMatchObject({ type: "update", node: { strokeGradient: gradient, strokeWidth: 3 } });
    expect(resolved?.nextNodes[0]).toMatchObject({ strokeGradient: gradient });
  });

  it("resolves duplicate into atomic Core creates while preserving Canonical appearance", () => {
    const gradient = { start: [0, 0] as [number, number], end: [1, 0] as [number, number], stops: [
      { position: 0, color: { space: "srgb" as const, components: [0.1, 0.2, 0.3] as [number, number, number], alpha: 1 } },
      { position: 1, color: { space: "display-p3" as const, components: [0.4, 0.8, 0.6] as [number, number, number], alpha: 0.8 } },
    ] };
    const source = { ...rectangle("00000000-0000-4000-8000-000000000001"), fillGradient: gradient, strokeGradient: gradient, text: "Preserve me" };
    const copyId = "00000000-0000-4000-8000-000000000002";
    const resolved = resolveCoreBatch([source], [{ type: "duplicate", ids: [source.id] }], () => copyId);

    expect(resolved?.createdIds).toEqual([copyId]);
    expect(resolved?.batch).toEqual([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: copyId, name: "Rectangle copy", x: 34, y: 44, fillGradient: gradient, strokeGradient: gradient, text: "Preserve me" }) }),
    ]);
    expect(resolved?.nextNodes).toEqual([source, expect.objectContaining({ id: copyId, x: 34, y: 44 })]);
    expect(resolved?.batch[0]).toMatchObject({ type: "create", node: { positionId: expect.stringMatching(/^[0-9a-f]{32}:[0-9a-f]{32}$/) } });
    expect((resolved?.batch[0] as Extract<NonNullable<typeof resolved>["batch"][number], { type: "create" }>).node.positionId).not.toBe(source.positionId);
  });

  it("duplicates a selected Group as a same-level subtree instead of nesting a new Group inside it", () => {
    const group = { ...createNode("group", 10, 20), id: "00000000-0000-4000-8000-000000000011", positionId: "00000000000000000000000000000001:00000000000000000000000000000000" };
    const inner = { ...createNode("group", 15, 25), id: "00000000-0000-4000-8000-000000000012", parentId: group.id, positionId: "00000000000000000000000000000002:00000000000000000000000000000000" };
    const leaf = { ...rectangle("00000000-0000-4000-8000-000000000013"), parentId: inner.id, positionId: "00000000000000000000000000000003:00000000000000000000000000000000" };
    const ids = ["00000000-0000-4000-8000-000000000021", "00000000-0000-4000-8000-000000000022", "00000000-0000-4000-8000-000000000023"];
    const resolved = resolveCoreBatch([group, inner, leaf], [{ type: "duplicate", ids: [group.id, leaf.id] }], () => ids.shift()!);

    expect(resolved?.createdIds).toEqual(["00000000-0000-4000-8000-000000000021"]);
    expect(resolved?.batch).toEqual([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: "00000000-0000-4000-8000-000000000021", kind: "group", parentId: undefined, name: "Group copy", x: 34, y: 44 }) }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: "00000000-0000-4000-8000-000000000022", kind: "group", parentId: "00000000-0000-4000-8000-000000000021" }) }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: "00000000-0000-4000-8000-000000000023", kind: "rectangle", parentId: "00000000-0000-4000-8000-000000000022", x: 34, y: 44 }) }),
    ]);
    expect(resolved?.nextNodes.filter((node) => node.id.startsWith("00000000-0000-4000-8000-00000000002")).map((node) => node.parentId)).toEqual([undefined, "00000000-0000-4000-8000-000000000021", "00000000-0000-4000-8000-000000000022"]);
  });

  it("groups same-parent layers with derived bounds and preserves child geometry", () => {
    const first = { ...rectangle("00000000-0000-4000-8000-000000000001"), x: 10, y: 20, width: 40, height: 30, positionId: "00000000000000000000000000000001:00000000000000000000000000000000" };
    const second = { ...rectangle("00000000-0000-4000-8000-000000000002"), x: 80, y: 50, width: 20, height: 20, positionId: "00000000000000000000000000000002:00000000000000000000000000000000" };
    const groupId = "00000000-0000-4000-8000-000000000003";
    const resolved = resolveCoreBatch([first, second], [{ type: "group", ids: [first.id, second.id] }], () => groupId);

    expect(resolved?.createdIds).toEqual([groupId]);
    expect(resolved?.batch).toEqual([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: groupId, kind: "group", x: 10, y: 20, width: 90, height: 50 }) }),
      expect.objectContaining({ type: "update", node: expect.objectContaining({ id: first.id, parentId: groupId, x: 0, y: 0, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } }) }),
      expect.objectContaining({ type: "update", node: expect.objectContaining({ id: second.id, parentId: groupId, x: 70, y: 30, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 70, f: 30 } }) }),
      { type: "reparent", parentIds: [{ id: first.id, parentId: groupId, positionId: first.positionId }, { id: second.id, parentId: groupId, positionId: second.positionId }] },
    ]);
    expect(resolved?.nextNodes.find((node) => node.id === first.id)).toMatchObject({ parentId: groupId, x: 0, y: 0, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } });
    expect(transformPoint(worldTransformForNode(resolved!.nextNodes, first.id)!, { x: 0, y: 0 })).toEqual({ x: 10, y: 20 });
    expect(transformPoint(worldTransformForNode(resolved!.nextNodes, second.id)!, { x: 0, y: 0 })).toEqual({ x: 80, y: 50 });
  });

  it("wraps an existing Group and a sibling in a nested Group without moving its descendants", () => {
    const outer = { ...createNode("group", 0, 0), id: "00000000-0000-4000-8000-000000000010", positionId: "00000000000000000000000000000001:00000000000000000000000000000000" };
    const inner = { ...createNode("group", 20, 30), id: "00000000-0000-4000-8000-000000000011", parentId: outer.id, width: 40, height: 20, positionId: "00000000000000000000000000000002:00000000000000000000000000000000" };
    const innerLeaf = { ...rectangle("00000000-0000-4000-8000-000000000012"), parentId: inner.id, x: 20, y: 30, positionId: "00000000000000000000000000000003:00000000000000000000000000000000" };
    const sibling = { ...rectangle("00000000-0000-4000-8000-000000000013"), parentId: outer.id, x: 100, y: 40, positionId: "00000000000000000000000000000004:00000000000000000000000000000000" };
    const wrapperId = "00000000-0000-4000-8000-000000000014";
    const resolved = resolveCoreBatch([outer, inner, innerLeaf, sibling], [{ type: "group", ids: [inner.id, sibling.id] }], () => wrapperId);

    expect(resolved?.createdIds).toEqual([wrapperId]);
    expect(resolved?.nextNodes.find((node) => node.id === wrapperId)).toMatchObject({ kind: "group", parentId: outer.id });
    expect(resolved?.nextNodes.find((node) => node.id === inner.id)).toMatchObject({ parentId: wrapperId });
    expect(resolved?.nextNodes.find((node) => node.id === sibling.id)).toMatchObject({ parentId: wrapperId });
    expect(resolved?.nextNodes.find((node) => node.id === innerLeaf.id)).toMatchObject({ parentId: inner.id });
  });

  it("ungroups only a non-empty Group and moves its children back to the parent", () => {
    const group = { ...createNode("group", 0, 0), id: "00000000-0000-4000-8000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000" };
    const child = { ...rectangle("00000000-0000-4000-8000-000000000002"), parentId: group.id, positionId: "00000000000000000000000000000002:00000000000000000000000000000000" };
    const resolved = resolveCoreBatch([group, child], [{ type: "ungroup", id: group.id }]);

    expect(resolved?.batch).toEqual([
      expect.objectContaining({ type: "update", node: expect.objectContaining({ id: child.id, parentId: undefined, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 } }) }),
      { type: "reparent", parentIds: [{ id: child.id, parentId: undefined, positionId: child.positionId }] },
    ]);
    expect(resolved?.nextNodes).toEqual([expect.objectContaining({ id: child.id, parentId: undefined, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 } })]);
  });

  it("rejects duplicate requests with empty, repeated, missing, or colliding IDs", () => {
    const source = rectangle("00000000-0000-4000-8000-000000000001");
    expect(resolveCoreBatch([source], [{ type: "duplicate", ids: [] }])).toBeUndefined();
    expect(resolveCoreBatch([source], [{ type: "duplicate", ids: [source.id, source.id] }])).toBeUndefined();
    expect(resolveCoreBatch([source], [{ type: "duplicate", ids: ["00000000-0000-4000-8000-000000000099"] }])).toBeUndefined();
    expect(resolveCoreBatch([source], [{ type: "duplicate", ids: [source.id] }], () => source.id)).toBeUndefined();
  });

  it("rejects malformed batches without mutating the source projection", () => {
    const source = [rectangle("00000000-0000-4000-8000-000000000001")];
    const before = structuredClone(source);

    expect(resolveCoreBatch(source, [
      { type: "create", node: rectangle(source[0].id) },
      { type: "update", id: "00000000-0000-4000-8000-000000000099", patch: { x: 4 } },
    ])).toBeUndefined();
    expect(source).toEqual(before);
  });
});
