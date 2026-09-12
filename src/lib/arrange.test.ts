import { describe, expect, it } from "vitest";
import { resolveArrangeCommand } from "./arrange";
import { createNode } from "./editor-protocol";
import { resolveCoreBatch } from "./transaction-batch";
import { worldVisualBoundsForNode } from "./world-visual-bounds";

const node = (id: string, x: number, y: number, width = 20, height = 20) => ({ ...createNode("rectangle", x, y), id, width, height, strokeWidth: 0 });

describe("resolveArrangeCommand", () => {
  it("aligns rotated render bounds in world space", () => {
    const first = { ...node("a", 0, 0, 40, 20), rotation: 45 };
    const second = node("b", 100, 30, 20, 20);
    const result = resolveArrangeCommand([first, second], { type: "arrange", ids: [first.id, second.id], operation: "align", axis: "x", mode: "min" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patches).toHaveLength(1);
    expect(result.patches[0]).toMatchObject({ id: "b", patch: { x: expect.any(Number) } });
  });

  it("distributes equal edge gaps deterministically", () => {
    const result = resolveArrangeCommand([node("c", 160, 0, 40), node("a", 0, 0, 20), node("b", 80, 0, 30)], { type: "arrange", ids: ["c", "a", "b"], operation: "distribute", axis: "x", mode: "edgeGap" });
    expect(result).toMatchObject({ ok: true, patches: [{ id: "b", patch: { x: 75 } }] });
  });

  it("uses the first selected root as the explicit primary alignment reference", () => {
    const result = resolveArrangeCommand([node("primary", 80, 0, 20), node("other", 10, 0, 30)], { type: "arrange", ids: ["primary", "other"], operation: "align", axis: "x", mode: "min", reference: "primaryNode" });
    expect(result).toMatchObject({ ok: true, patches: [{ id: "other", patch: { x: 80 } }] });
  });

  it("tidies along the dominant axis using the requested gap", () => {
    const result = resolveArrangeCommand([node("a", 10, 0, 20, 20), node("b", 140, 5, 30, 20), node("c", 260, 8, 10, 20)], { type: "arrange", ids: ["a", "b", "c"], operation: "tidyUp", axis: "auto", gap: 12, anchor: "selectionBounds" });
    expect(result).toMatchObject({ ok: true, patches: [{ id: "b", patch: { x: 42 } }, { id: "c", patch: { x: 84 } }] });
  });

  it("uses the vertical axis for auto tidy when selection render bounds are taller than wide", () => {
    const result = resolveArrangeCommand([
      node("a", 4, 10, 20, 20),
      node("b", 7, 140, 20, 30),
      node("c", 9, 260, 20, 10),
    ], { type: "arrange", ids: ["a", "b", "c"], operation: "tidyUp", axis: "auto", gap: 12, anchor: "selectionBounds" });

    expect(result).toMatchObject({ ok: true, patches: [{ id: "b", patch: { y: 42 } }, { id: "c", patch: { y: 84 } }] });
  });

  it("keeps a 100+ layer tidy-up deterministic regardless of selection order", () => {
    const layers = Array.from({ length: 101 }, (_, index) => node(`layer-${String(index).padStart(3, "0")}`, (100 - index) * 37, index % 3, 20, 20));
    const forward = resolveArrangeCommand(layers, { type: "arrange", ids: layers.map((layer) => layer.id), operation: "tidyUp", axis: "x", gap: 12, anchor: "selectionBounds" });
    const reverse = resolveArrangeCommand(layers, { type: "arrange", ids: layers.map((layer) => layer.id).reverse(), operation: "tidyUp", axis: "x", gap: 12, anchor: "selectionBounds" });

    expect(forward.ok).toBe(true);
    expect(reverse).toEqual(forward);
    if (!forward.ok) return;
    expect(forward.updates).toHaveLength(100);
    expect(forward.updates.at(-1)).toMatchObject({ id: "layer-000", patch: { x: 3200 } });
  });

  it("tidies 101 rotated Relative-v1 layers in a clipped Frame as deterministic concrete world-space updates", () => {
    const frame = {
      ...createNode("frame", 80, 60), id: "clip-frame", width: 4_600, height: 360, rotation: 17, clipsContent: true,
      relativeTransform: { a: Math.cos(Math.PI / 12), b: Math.sin(Math.PI / 12), c: -Math.sin(Math.PI / 12), d: Math.cos(Math.PI / 12), e: 80, f: 60 },
    };
    const layers = Array.from({ length: 101 }, (_, index) => ({
      ...node(`nested-${String(index).padStart(3, "0")}`, 0, 0, 20 + index % 4, 16 + index % 3),
      parentId: frame.id,
      rotation: index % 2 ? 9 : -7,
      relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: (100 - index) * 37, f: index % 5 * 11 },
    }));
    const command = { type: "arrange" as const, ids: layers.map((layer) => layer.id), operation: "tidyUp" as const, axis: "x" as const, gap: 12, anchor: "selectionBounds" as const };
    const forward = resolveArrangeCommand([frame, ...layers], command);
    const reverse = resolveArrangeCommand([frame, ...layers], { ...command, ids: [...command.ids].reverse() });

    expect(forward.ok).toBe(true);
    expect(reverse).toEqual(forward);
    if (!forward.ok) return;
    expect(forward.updates).toHaveLength(100);
    expect(forward.updates.every((update) => update.patch.relativeTransform || update.patch.x !== undefined || update.patch.y !== undefined)).toBe(true);

    const applied = resolveCoreBatch([frame, ...layers], forward.updates.map((update) => ({ type: "update" as const, ...update })));
    expect(applied).toBeDefined();
    const ordered = applied!.nextNodes.filter((candidate) => candidate.parentId === frame.id)
      .map((candidate) => ({ id: candidate.id, bounds: worldVisualBoundsForNode(applied!.nextNodes, candidate)! }))
      .sort((left, right) => left.bounds.left - right.bounds.left || left.id.localeCompare(right.id));
    expect(ordered).toHaveLength(101);
    for (let index = 1; index < ordered.length; index += 1) {
      expect(ordered[index]!.bounds.left - ordered[index - 1]!.bounds.right).toBeCloseTo(12, 8);
    }
  });

  it("rejects locked and Auto Layout flow selections atomically", () => {
    const locked = { ...node("locked", 0, 0), locked: true };
    expect(resolveArrangeCommand([locked, node("other", 40, 0)], { type: "arrange", ids: ["locked", "other"], operation: "align", axis: "x", mode: "min" })).toEqual({ ok: false, reason: "locked" });
    const frame = { ...node("frame", 0, 0), kind: "frame" as const, autoLayout: { mode: "horizontal" as const, padding: [0, 0, 0, 0] as [number, number, number, number], itemSpacing: 0, wrap: false, primaryAlignment: "start" as const, counterAlignment: "start" as const, primarySizing: "fixed" as const, counterSizing: "fixed" as const, absolute: false } };
    const child = { ...node("child", 10, 0), parentId: frame.id };
    expect(resolveArrangeCommand([frame, child, node("other", 100, 0)], { type: "arrange", ids: [child.id, "other"], operation: "align", axis: "x", mode: "min" })).toEqual({ ok: false, reason: "auto-layout-flow" });
  });

  it("maps a common flow-child cross-axis alignment to child alignSelf", () => {
    const frame = { ...node("frame", 0, 0, 300, 100), kind: "frame" as const, autoLayout: { mode: "horizontal" as const, padding: [0, 0, 0, 0] as [number, number, number, number], itemSpacing: 0, wrap: false, primaryAlignment: "start" as const, counterAlignment: "start" as const, primarySizing: "fixed" as const, counterSizing: "fixed" as const, absolute: false } };
    const first = { ...node("first", 0, 0), parentId: frame.id };
    const second = { ...node("second", 40, 0), parentId: frame.id };
    const result = resolveArrangeCommand([frame, first, second], { type: "arrange", ids: [first.id, second.id], operation: "align", axis: "y", mode: "max" });
    expect(result).toEqual({ ok: true, patches: [], updates: [
      { id: "first", patch: { autoLayout: expect.objectContaining({ alignSelf: "end" }) } },
      { id: "second", patch: { autoLayout: expect.objectContaining({ alignSelf: "end" }) } },
    ] });
    if (!result.ok) return;
    const core = resolveCoreBatch([frame, first, second], result.updates.map((update) => ({ type: "update" as const, ...update })));
    expect(core?.nextNodes.filter((candidate) => candidate.id !== frame.id)).toEqual([
      expect.objectContaining({ id: "first", autoLayout: expect.objectContaining({ alignSelf: "end" }) }),
      expect.objectContaining({ id: "second", autoLayout: expect.objectContaining({ alignSelf: "end" }) }),
    ]);
    expect(core?.batch).toEqual([
      expect.objectContaining({ type: "update", node: expect.objectContaining({ id: "first", autoLayout: expect.objectContaining({ alignSelf: "end" }) }) }),
      expect.objectContaining({ type: "update", node: expect.objectContaining({ id: "second", autoLayout: expect.objectContaining({ alignSelf: "end" }) }) }),
    ]);
  });

  it("fails closed for inherited locks and cross-page selection", () => {
    const parent = { ...node("parent", 0, 0), kind: "group" as const, locked: true };
    const child = { ...node("child", 20, 0), parentId: parent.id };
    expect(resolveArrangeCommand([parent, child, node("other", 100, 0)], { type: "arrange", ids: [child.id, "other"], operation: "align", axis: "x", mode: "min" })).toEqual({ ok: false, reason: "locked" });
    const first = { ...node("first", 0, 0), pageId: "page-a" };
    const second = { ...node("second", 100, 0), pageId: "page-b" };
    expect(resolveArrangeCommand([first, second], { type: "arrange", ids: [first.id, second.id], operation: "align", axis: "x", mode: "min" })).toEqual({ ok: false, reason: "invalid-selection" });
  });
});
