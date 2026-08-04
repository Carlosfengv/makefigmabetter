import { describe, expect, it } from "vitest";
import { createNode, type CanvasNode } from "./editor-protocol";
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

  it("includes text content in the concrete Core payload", () => {
    const text = { ...createNode("text", 10, 20), id: "00000000-0000-4000-8000-000000000001", text: "Before" };
    const resolved = resolveCoreBatch([text], [{ type: "update", id: text.id, patch: { text: "After" } }]);

    expect(resolved?.batch).toEqual([
      expect.objectContaining({ type: "update", node: expect.objectContaining({ id: text.id, text: "After" }) }),
    ]);
  });

  it("preserves explicit fractional Inspector coordinates without applying canvas snapping", () => {
    const node = rectangle("00000000-0000-4000-8000-000000000001");
    const resolved = resolveCoreBatch([node], [{ type: "update", id: node.id, patch: { x: -249.25, y: 12.5 } }]);

    expect(resolved?.nextNodes[0]).toMatchObject({ x: -249.25, y: 12.5 });
    expect(resolved?.batch[0]).toMatchObject({ type: "update", node: { x: -249.25, y: 12.5 } });
  });

  it("preserves an explicit wide-gamut color through unrelated Core updates", () => {
    const node = { ...rectangle("00000000-0000-4000-8000-000000000001"), fillColor: { space: "display-p3" as const, components: [0.2, 0.8, 0.4] as [number, number, number], alpha: 1 }, positionId: "00000000000000000000000000000010:00000000000000000000000000000007" };
    const resolved = resolveCoreBatch([node], [{ type: "update", id: node.id, patch: { name: "P3 card" } }]);

    expect(resolved?.batch[0]).toMatchObject({ type: "update", node: { fillColor: node.fillColor, positionId: node.positionId } });
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
