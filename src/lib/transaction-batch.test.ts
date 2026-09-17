import { describe, expect, it } from "vitest";
import { createNode, type CanvasNode } from "./editor-protocol";
import { transformPoint, translateNodeWorldPatch, worldTransformForNode } from "./scene-transform";
import { autoLayoutProjectionNormalizationPatches, captureClipboard, normalizeAutoLayoutProjection, resolveCoreBatch, resolveFlattenBooleanBatch, resolveFlattenNodeBatch, resolveFlattenNodesBatch, resolveLineOutlineStrokeBatch, resolveOutlineStrokeBatch, resolveParametricShapeToVectorBatch, resolvePasteBatch } from "./transaction-batch";
import { createPhase2ProfessionalCompositeFixture } from "./phase2-professional-composite-fixture";
import fixture from "../../fixtures/documents/phase2-common-nodes.fixture.json";

function rectangle(id: string): CanvasNode {
  return { ...createNode("rectangle", 10, 20), id };
}

describe("Core transaction batch resolution", () => {
  it("persists and clears component property references through extension-backed updates", () => {
    const node = { ...rectangle("00000000-0000-4000-8000-000000000205"), componentPropertyReferences: { visible: "Enabled" } };
    const stored = resolveCoreBatch([node], [{ type: "update", id: node.id, patch: { componentPropertyReferences: { visible: "Active" } } }]);
    expect(stored?.batch.map((entry) => entry.type)).toEqual(["setExtensions", "update"]);
    expect(new TextDecoder().decode(Uint8Array.from((stored?.batch[0] as Extract<NonNullable<typeof stored>["batch"][number], { type: "setExtensions" }>).extensions["figma.component-property-references.v1"]!))).toContain("Active");

    const cleared = resolveCoreBatch(stored!.nextNodes, [{ type: "update", id: node.id, patch: { componentPropertyReferences: undefined } }]);
    expect(cleared?.nextNodes[0].componentPropertyReferences).toBeUndefined();
    expect((cleared?.batch[0] as Extract<NonNullable<typeof cleared>["batch"][number], { type: "setExtensions" }>).extensions["figma.component-property-references.v1"]).toBeUndefined();
  });

  it("preserves resizeWithoutConstraints as a Core transport flag", () => {
    const frame = { ...createNode("frame", 0, 0), id: "00000000-0000-4000-8000-000000000091" };
    const resolved = resolveCoreBatch([frame], [{ type: "resizeWithoutConstraints", id: frame.id, patch: { width: 320, height: 180 } }]);

    expect(resolved?.nextNodes[0]).toMatchObject({ width: 320, height: 180 });
    expect(resolved?.batch).toEqual([
      expect.objectContaining({ type: "update", ignoreConstraints: true, node: expect.objectContaining({ id: frame.id, width: 320, height: 180 }) }),
    ]);
  });

  it("accepts a Core-derived direct split of a professional-fixture Vector segment", () => {
    const fixture = createPhase2ProfessionalCompositeFixture();
    const vector = fixture.nodes.find((node) => node.name === "Outline stroke result");
    const afterPointId = vector?.vectorPath?.subpaths[0]?.points[0]?.id;
    expect(vector?.vectorPath).toBeDefined();
    expect(afterPointId).toBeDefined();

    const resolved = resolveCoreBatch(fixture.nodes, [{
      type: "splitVectorSegment",
      id: vector!.id,
      subpathIndex: 0,
      afterPointId: afterPointId!,
      t: .5,
      pointId: "00000000-0000-4000-8000-000000003099",
    }]);

    expect(resolved?.batch).toEqual([expect.objectContaining({ type: "splitVectorSegment", id: vector!.id, afterPointId, t: .5 })]);
    expect(resolved?.nextNodes.find((node) => node.id === vector!.id)?.vectorPath?.subpaths[0]?.points).toHaveLength(5);
  });

  it("connects two open Vector subpaths as one replayable batch command", () => {
    const vector = {
      ...createNode("vector", 0, 0),
      id: "00000000-0000-4000-8000-000000000001",
      vectorPath: {
        fillRule: "nonZero" as const,
        subpaths: [
          { closed: false, points: [
            { id: "00000000-0000-4000-8000-000000000011", x: 0, y: 0, pointType: "corner" as const },
            { id: "00000000-0000-4000-8000-000000000012", x: 10, y: 0, pointType: "corner" as const },
          ] },
          { closed: false, points: [
            { id: "00000000-0000-4000-8000-000000000013", x: 20, y: 0, pointType: "corner" as const },
            { id: "00000000-0000-4000-8000-000000000014", x: 30, y: 0, pointType: "corner" as const },
          ] },
        ],
      },
    };
    const resolved = resolveCoreBatch([vector], [{
      type: "connectVectorEndpoints",
      id: vector.id,
      firstSubpathIndex: 0,
      firstPointId: "00000000-0000-4000-8000-000000000012",
      secondSubpathIndex: 1,
      secondPointId: "00000000-0000-4000-8000-000000000013",
    }]);

    expect(resolved?.batch).toEqual([expect.objectContaining({ type: "connectVectorEndpoints", id: vector.id })]);
    expect(resolved?.nextNodes[0].vectorPath?.subpaths).toHaveLength(1);
    expect(resolved?.nextNodes[0].vectorPath?.subpaths[0].points.map((point) => point.id)).toEqual([
      "00000000-0000-4000-8000-000000000011",
      "00000000-0000-4000-8000-000000000012",
      "00000000-0000-4000-8000-000000000013",
      "00000000-0000-4000-8000-000000000014",
    ]);
  });

  it("keeps Slice geometry editable while retaining its non-painting defaults", () => {
    const slice = { ...createNode("slice", 10, 20), id: "00000000-0000-4000-8000-000000000001" };
    const resolved = resolveCoreBatch([slice], [{ type: "update", id: slice.id, patch: { x: 40, y: 60, width: 480, height: 270, rotation: 15 } }]);

    expect(resolved?.nextNodes).toEqual([expect.objectContaining({ kind: "slice", x: 40, y: 60, width: 480, height: 270, rotation: 15, fill: "transparent", stroke: "transparent", strokeWidth: 0 })]);
    expect(resolved?.batch[0]).toMatchObject({ type: "update", node: { kind: "slice", strokeWidth: 0 } });
  });

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

  it("keeps the one-entry Effect Stack synchronized with a later Drop Shadow inspector edit", () => {
    const first = rectangle("00000000-0000-4000-8000-000000000001");
    const original = { offsetX: 0, offsetY: 4, blurRadius: 8, spread: 0, color: { space: "srgb" as const, components: [0, 0, 0] as [number, number, number], alpha: .25 }, visible: true };
    const updated = { ...original, blurRadius: 16 };
    const projected = { ...first, dropShadow: original, effectStack: [{ dropShadow: original }] };

    const resolved = resolveCoreBatch([projected], [{ type: "update", id: first.id, patch: { dropShadow: updated } }]);

    expect(resolved?.batch[0]).toMatchObject({ type: "update", node: { dropShadow: updated, effectStack: [{ dropShadow: updated }] } });
  });

  it("preserves a reordered Effect Stack and projects its first effect for legacy readers", () => {
    const first = rectangle("00000000-0000-4000-8000-000000000001");
    const early = { offsetX: -6, offsetY: 2, blurRadius: 4, spread: 0, color: { space: "srgb" as const, components: [0, 0, 0] as [number, number, number], alpha: .2 }, visible: true };
    const late = { offsetX: 8, offsetY: 12, blurRadius: 16, spread: 3, color: { space: "srgb" as const, components: [1, 1, 1] as [number, number, number], alpha: .4 }, visible: true };
    const projected = { ...first, dropShadow: early, effectStack: [{ dropShadow: early }, { dropShadow: late }] };

    const resolved = resolveCoreBatch([projected], [{ type: "update", id: first.id, patch: { effectStack: [{ dropShadow: late }, { dropShadow: early }], dropShadow: late } }]);

    expect(resolved?.batch[0]).toMatchObject({ type: "update", node: { dropShadow: late, effectStack: [{ dropShadow: late }, { dropShadow: early }] } });
  });

  it("does not renormalize Group geometry for an Effect Stack-only edit", () => {
    const group = { ...createNode("group", 0, 0), id: "00000000-0000-4000-8000-000000000010", width: 200, height: 120, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } };
    const child = { ...rectangle("00000000-0000-4000-8000-000000000011"), parentId: group.id, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 20, f: 20 } };
    const shadow = { offsetX: 0, offsetY: 4, blurRadius: 12, spread: 0, color: { space: "srgb" as const, components: [0, 0, 0] as [number, number, number], alpha: .25 }, visible: true };

    const resolved = resolveCoreBatch([group, child], [{ type: "update", id: child.id, patch: { dropShadow: shadow, effectStack: [{ dropShadow: shadow }] } }]);

    expect(resolved?.batch).toHaveLength(1);
    expect(resolved?.affectedGroupIds).toEqual([]);
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

  it("keeps TextPath geometry editable without exposing its immutable base path", () => {
    const source = createPhase2ProfessionalCompositeFixture().nodes.find((node) => node.kind === "textPath");
    const textPath = source ?? {
      ...createNode("textPath", 10, 20),
      id: "00000000-0000-4000-8000-000000000099",
      vectorPath: { fillRule: "nonZero" as const, subpaths: [{ closed: false, points: [
        { id: "00000000-0000-4000-8000-00000000009a", x: 0, y: 20, pointType: "corner" as const },
        { id: "00000000-0000-4000-8000-00000000009b", x: 100, y: 20, pointType: "corner" as const },
      ] }] },
    };
    const resolved = resolveCoreBatch([textPath], [{ type: "update", id: textPath.id, patch: { rotation: 28 } }]);

    expect(resolved?.nextNodes[0]).toMatchObject({ kind: "textPath", rotation: 28, vectorPath: textPath.vectorPath });
    expect(resolved?.batch).toEqual([expect.objectContaining({ type: "update", node: expect.objectContaining({ kind: "textPath", rotation: 28, vectorPath: textPath.vectorPath }) })]);
    expect(resolveCoreBatch([textPath], [{ type: "update", id: textPath.id, patch: { vectorPath: structuredClone(textPath.vectorPath) } }])).toBeUndefined();
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

    expect(resolved?.batch.map((entry) => entry.type)).toEqual(["reparent", "update"]);
    expect(resolved?.batch[0]).toMatchObject({ type: "reparent", parentIds: [{ id: child.id, parentId: newParent.id }] });
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

  it("hands a reparented child’s position to an active Auto Layout Frame", () => {
    const frame = {
      ...createNode("frame", 0, 0), id: "00000000-0000-4000-8000-000000000001",
      autoLayout: { mode: "horizontal" as const, padding: [0, 0, 0, 0] as [number, number, number, number], itemSpacing: 8, wrap: false, primaryAlignment: "start" as const, counterAlignment: "start" as const, primarySizing: "fixed" as const, counterSizing: "fixed" as const, absolute: false },
    };
    const child = { ...rectangle("00000000-0000-4000-8000-000000000002"), x: 120, y: 80 };
    const resolved = resolveCoreBatch([frame, child], [{ type: "reparent", ids: [child.id], parentId: frame.id }]);

    expect(resolved?.batch.map((entry) => entry.type)).toEqual(["reparent"]);
    expect(resolved?.nextNodes.find((node) => node.id === child.id)).toMatchObject({ parentId: frame.id, relativeTransform: undefined, rotation: 0 });
  });

  it("clears a legacy child matrix before reparenting into active Auto Layout", () => {
    const frame = {
      ...createNode("frame", 0, 0), id: "00000000-0000-4000-8000-000000000011",
      autoLayout: { mode: "horizontal" as const, padding: [0, 0, 0, 0] as [number, number, number, number], itemSpacing: 8, wrap: false, primaryAlignment: "start" as const, counterAlignment: "start" as const, primarySizing: "fixed" as const, counterSizing: "fixed" as const, absolute: false },
    };
    const child = { ...rectangle("00000000-0000-4000-8000-000000000012"), width: 80, height: 40, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 120, f: 80 } };
    const resolved = resolveCoreBatch([frame, child], [{ type: "reparent", ids: [child.id], parentId: frame.id }]);

    expect(resolved?.batch.map((entry) => entry.type)).toEqual(["update", "reparent"]);
    expect((resolved?.batch[0] as { type: "update"; node: { relativeTransform?: unknown; width: number; height: number } }).node).toMatchObject({ relativeTransform: undefined, width: 80, height: 40 });
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

  it("duplicates a flow child in its Auto Layout parent without carrying a legacy transform", () => {
    const frame = {
      ...createNode("frame", 0, 0), id: "00000000-0000-4000-8000-000000000081",
      autoLayout: { mode: "horizontal" as const, padding: [0, 0, 0, 0] as [number, number, number, number], itemSpacing: 8, wrap: false, primaryAlignment: "start" as const, counterAlignment: "start" as const, primarySizing: "fixed" as const, counterSizing: "fixed" as const, absolute: false },
    };
    const child = { ...rectangle("00000000-0000-4000-8000-000000000082"), parentId: frame.id, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 12, f: 8 } };
    const copyId = "00000000-0000-4000-8000-000000000083";

    const resolved = resolveCoreBatch([frame, child], [{ type: "duplicate", ids: [child.id] }], () => copyId);

    expect(resolved?.createdIds).toEqual([copyId]);
    expect(resolved?.nextNodes.find((node) => node.id === copyId)).toMatchObject({ parentId: frame.id, name: "Rectangle copy", relativeTransform: undefined });
    expect(resolved?.batch).toEqual([expect.objectContaining({ type: "create", node: expect.objectContaining({ id: copyId, parentId: frame.id, relativeTransform: undefined }) })]);
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
      { type: "reparent", parentIds: [{ id: first.id, parentId: groupId, positionId: first.positionId }, { id: second.id, parentId: groupId, positionId: second.positionId }] },
      expect.objectContaining({ type: "update", node: expect.objectContaining({ id: first.id, parentId: groupId, x: 0, y: 0, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } }) }),
      expect.objectContaining({ type: "update", node: expect.objectContaining({ id: second.id, parentId: groupId, x: 70, y: 30, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 70, f: 30 } }) }),
    ]);
    expect(resolved?.nextNodes.find((node) => node.id === first.id)).toMatchObject({ parentId: groupId, x: 0, y: 0, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } });
    expect(transformPoint(worldTransformForNode(resolved!.nextNodes, first.id)!, { x: 0, y: 0 })).toEqual({ x: 10, y: 20 });
    expect(transformPoint(worldTransformForNode(resolved!.nextNodes, second.id)!, { x: 0, y: 0 })).toEqual({ x: 80, y: 50 });
  });

  it("creates a non-empty ComponentSet and reparents only Component roots", () => {
    const first = {
      ...createNode("component", 10, 20),
      id: "00000000-0000-4000-8000-000000000201",
      pageId: "page",
      positionId: "20000000000000000000000000000000:00000000000040008000000000000201",
      name: "State=Default",
    };
    const second = {
      ...createNode("component", 80, 50),
      id: "00000000-0000-4000-8000-000000000202",
      pageId: "page",
      positionId: "40000000000000000000000000000000:00000000000040008000000000000202",
      name: "State=Hover",
    };
    const componentSetId = "00000000-0000-4000-8000-000000000203";
    const metadata = {
      key: componentSetId,
      remote: false,
      description: "",
      descriptionMarkdown: "",
      documentationLinks: [],
      componentPropertyDefinitions: { State: { type: "VARIANT" as const, defaultValue: "Default", variantOptions: ["Default", "Hover"] } },
      variantGroupProperties: { State: { values: ["Default", "Hover"] } },
    };
    const resolved = resolveCoreBatch([first, second], [{
      type: "componentSet",
      ids: [first.id, second.id],
      id: componentSetId,
      pageId: "page",
      metadata,
      patch: { name: "Button" },
    }]);

    expect(resolved?.createdIds).toEqual([componentSetId]);
    expect(resolved?.batch).toEqual([
      expect.objectContaining({
        type: "create",
        node: expect.objectContaining({
          id: componentSetId,
          kind: "componentSet",
          name: "Button",
          extensions: expect.objectContaining({ "figma.component-set.metadata.v1": expect.any(Array) }),
        }),
      }),
      expect.objectContaining({
        type: "reparent",
        parentIds: expect.arrayContaining([
          expect.objectContaining({ id: first.id, parentId: componentSetId }),
          expect.objectContaining({ id: second.id, parentId: componentSetId }),
        ]),
      }),
      expect.objectContaining({ type: "update", node: expect.objectContaining({ id: first.id, parentId: componentSetId, x: 0, y: 0 }) }),
      expect.objectContaining({ type: "update", node: expect.objectContaining({ id: second.id, parentId: componentSetId, x: 70, y: 30 }) }),
    ]);
    expect(resolved?.nextNodes.find((node) => node.id === componentSetId)).toMatchObject({ kind: "componentSet", componentSetMetadata: metadata });

    const rectangleNode = {
      ...rectangle("00000000-0000-4000-8000-000000000204"),
      pageId: "page",
      positionId: "60000000000000000000000000000000:00000000000040008000000000000204",
    };
    expect(resolveCoreBatch([first, rectangleNode], [{
      type: "componentSet",
      ids: [first.id, rectangleNode.id],
      id: componentSetId,
      pageId: "page",
      metadata,
    }])).toBeUndefined();
  });

  it("wraps a multi-selection in a hugging Auto Layout Frame with flow children", () => {
    const first = { ...rectangle("00000000-0000-4000-8000-000000000091"), x: 10, y: 20, width: 40, height: 30, positionId: "00000000000000000000000000000091:00000000000000000000000000000000" };
    const second = { ...rectangle("00000000-0000-4000-8000-000000000092"), x: 80, y: 50, width: 20, height: 20, positionId: "00000000000000000000000000000092:00000000000000000000000000000000" };
    const frameId = "00000000-0000-4000-8000-000000000093";
    const autoLayout = { mode: "vertical" as const, padding: [0, 0, 0, 0] as [number, number, number, number], itemSpacing: 0, wrap: false, primaryAlignment: "start" as const, counterAlignment: "start" as const, primarySizing: "hug" as const, counterSizing: "hug" as const, absolute: false };

    const resolved = resolveCoreBatch([first, second], [{ type: "group", ids: [first.id, second.id], autoLayout }], () => frameId);

    expect(resolved?.createdIds).toEqual([frameId]);
    expect(resolved?.selectionIds).toEqual([frameId]);
    expect(resolved?.nextNodes.find((node) => node.id === frameId)).toMatchObject({ kind: "frame", autoLayout });
    expect(resolved?.nextNodes.filter((node) => node.parentId === frameId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, relativeTransform: undefined }),
      expect.objectContaining({ id: second.id, relativeTransform: undefined }),
    ]));
    expect(resolved?.batch.map((entry) => entry.type)).toEqual(["create", "reparent", "update", "update", "update"]);
    expect(resolved?.batch[0]).toEqual(expect.objectContaining({ type: "create", node: expect.objectContaining({ id: frameId, kind: "frame", autoLayout: undefined }) }));
    expect(resolved?.batch.at(-1)).toEqual(expect.objectContaining({ type: "update", node: expect.objectContaining({ id: frameId, kind: "frame", autoLayout }) }));
  });

  it("wraps mixed-size fixture layers, including a zero-height Line, in Auto Layout", () => {
    const source = fixture.nodes as CanvasNode[];
    const ellipse = source.find((node) => node.name === "Outside Ellipse")!;
    const line = source.find((node) => node.name === "Independent-cap Arrow")!;
    const autoLayout = { mode: "vertical" as const, padding: [0, 0, 0, 0] as [number, number, number, number], itemSpacing: 0, wrap: false, primaryAlignment: "start" as const, counterAlignment: "start" as const, primarySizing: "hug" as const, counterSizing: "hug" as const, absolute: false };

    const resolved = resolveCoreBatch(source, [{ type: "group", ids: [ellipse.id, line.id], autoLayout }], () => "00000000-0000-4000-8000-000000000099");

    expect(resolved).toBeDefined();
    expect(resolved?.batch).toHaveLength(8);
    expect(resolved?.batch[0]).toEqual(expect.objectContaining({ type: "create", node: expect.objectContaining({ kind: "frame", relativeTransform: undefined }) }));
    expect(resolved?.batch.at(-1)).toEqual(expect.objectContaining({ type: "update", node: expect.objectContaining({ autoLayout, relativeTransform: undefined }) }));
  });

  it("wraps two selected roots in an ordered live Boolean transaction", () => {
    const first = { ...rectangle("00000000-0000-4000-8000-000000000041"), x: 10, y: 20, width: 40, height: 30, positionId: "00000000000000000000000000000041:00000000000000000000000000000000" };
    const second = { ...rectangle("00000000-0000-4000-8000-000000000042"), x: 80, y: 50, width: 20, height: 20, positionId: "00000000000000000000000000000042:00000000000000000000000000000000" };
    const booleanId = "00000000-0000-4000-8000-000000000043";
    const resolved = resolveCoreBatch([first, second], [{ type: "boolean", ids: [first.id, second.id], operation: "subtract" }], () => booleanId);

    expect(resolved?.createdIds).toEqual([booleanId]);
    expect(resolved?.selectionIds).toEqual([booleanId]);
    expect(resolved?.batch).toEqual([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: booleanId, kind: "booleanOperation", booleanOperation: "subtract", x: 10, y: 20, width: 90, height: 50 }) }),
      { type: "reparent", parentIds: [{ id: first.id, parentId: booleanId, positionId: first.positionId }, { id: second.id, parentId: booleanId, positionId: second.positionId }] },
      expect.objectContaining({ type: "update", node: expect.objectContaining({ id: first.id, parentId: booleanId }) }),
      expect.objectContaining({ type: "update", node: expect.objectContaining({ id: second.id, parentId: booleanId }) }),
    ]);
    expect(resolveCoreBatch([first], [{ type: "boolean", ids: [first.id], operation: "union" }], () => booleanId)).toBeUndefined();
  });

  it("honors Runtime-forced Boolean identity, direct parent and insertion index", () => {
    const frame = { ...createNode("frame", 100, 50), id: "00000000-0000-4000-8000-000000000101", pageId: "page", positionId: "10000000000000000000000000000000:00000000000040008000000000000101" };
    const before = { ...createNode("vector", 0, 0), id: "00000000-0000-4000-8000-000000000102", pageId: "page", parentId: frame.id, positionId: "10000000000000000000000000000000:00000000000040008000000000000102" };
    const first = { ...createNode("vector", 20, 30), id: "00000000-0000-4000-8000-000000000103", pageId: "page", parentId: frame.id, positionId: "20000000000000000000000000000000:00000000000040008000000000000103" };
    const second = { ...createNode("vector", 80, 30), id: "00000000-0000-4000-8000-000000000104", pageId: "page", parentId: frame.id, positionId: "30000000000000000000000000000000:00000000000040008000000000000104" };
    const id = "00000000-0000-4000-8000-000000000105";
    const resolved = resolveCoreBatch([frame, before, first, second], [{
      type: "boolean", ids: [first.id, second.id], operation: "union", id, parentId: frame.id, index: 0,
    }], () => "unexpected");

    expect(resolved?.createdIds).toEqual([id]);
    expect(resolved?.nextNodes.find((node) => node.id === id)).toMatchObject({ kind: "booleanOperation", parentId: frame.id });
    expect(resolved?.nextNodes.filter((node) => node.parentId === frame.id).sort((left, right) => left.positionId!.localeCompare(right.positionId))[0]?.id).toBe(id);
    expect(resolveCoreBatch([frame, before, first, second], [{ type: "boolean", ids: [first.id, second.id], operation: "union", id, pageId: "other-page" }])).toBeUndefined();
  });

  it("rejects wrapping every operand inside the same Boolean parent", () => {
    const outer = { ...createNode("booleanOperation", 0, 0), id: "00000000-0000-4000-8000-000000000106", pageId: "page", booleanOperation: "union" as const };
    const first = { ...createNode("vector", 0, 0), id: "00000000-0000-4000-8000-000000000107", pageId: "page", parentId: outer.id };
    const second = { ...createNode("vector", 40, 0), id: "00000000-0000-4000-8000-000000000108", pageId: "page", parentId: outer.id };

    expect(resolveCoreBatch([outer, first, second], [{
      type: "boolean",
      ids: [first.id, second.id],
      operation: "intersect",
      parentId: outer.id,
    }])).toBeUndefined();
  });

  it("wraps same-page Vector roots from different Frames at the requested parent without world drift", () => {
    const firstFrame = { ...createNode("frame", 100, 50), id: "00000000-0000-4000-8000-000000000111", pageId: "page", width: 200, height: 180, positionId: "10000000000000000000000000000000:00000000000040008000000000000111" };
    const secondFrame = { ...createNode("frame", 360, 80), id: "00000000-0000-4000-8000-000000000112", pageId: "page", width: 200, height: 180, positionId: "20000000000000000000000000000000:00000000000040008000000000000112" };
    const first = { ...createNode("vector", 20, 30), id: "00000000-0000-4000-8000-000000000113", pageId: "page", parentId: firstFrame.id, positionId: "10000000000000000000000000000000:00000000000040008000000000000113" };
    const firstSibling = { ...createNode("vector", 80, 90), id: "00000000-0000-4000-8000-000000000114", pageId: "page", parentId: firstFrame.id, positionId: "20000000000000000000000000000000:00000000000040008000000000000114" };
    const second = { ...createNode("vector", 10, 20), id: "00000000-0000-4000-8000-000000000115", pageId: "page", parentId: secondFrame.id, positionId: "10000000000000000000000000000000:00000000000040008000000000000115" };
    const secondSibling = { ...createNode("vector", 70, 60), id: "00000000-0000-4000-8000-000000000116", pageId: "page", parentId: secondFrame.id, positionId: "20000000000000000000000000000000:00000000000040008000000000000116" };
    const booleanId = "00000000-0000-4000-8000-000000000117";
    const source = [firstFrame, secondFrame, first, firstSibling, second, secondSibling];
    const before = [first, second].map((node) => worldTransformForNode(source, node.id)!);

    const resolved = resolveCoreBatch(source, [{
      type: "boolean",
      ids: [second.id, first.id],
      operation: "subtract",
      id: booleanId,
      pageId: "page",
      index: 1,
    }])!;

    expect(resolved.nextNodes.find((node) => node.id === booleanId)).toMatchObject({ parentId: undefined, booleanOperation: "subtract" });
    expect(resolved.batch.find((entry) => entry.type === "reparent")).toEqual({
      type: "reparent",
      parentIds: [
        expect.objectContaining({ id: first.id, parentId: booleanId }),
        expect.objectContaining({ id: second.id, parentId: booleanId }),
      ],
    });
    expect(resolved.nextNodes.filter((node) => node.parentId === firstFrame.id)).toEqual([expect.objectContaining({ id: firstSibling.id })]);
    expect(resolved.nextNodes.filter((node) => node.parentId === secondFrame.id)).toEqual([expect.objectContaining({ id: secondSibling.id })]);
    [first, second].forEach((node, index) => {
      const after = worldTransformForNode(resolved.nextNodes, node.id)!;
      expect(transformPoint(after, { x: 0, y: 0 }).x).toBeCloseTo(transformPoint(before[index]!, { x: 0, y: 0 }).x, 10);
      expect(transformPoint(after, { x: 0, y: 0 }).y).toBeCloseTo(transformPoint(before[index]!, { x: 0, y: 0 }).y, 10);
    });
  });

  it("flattens a live Vector Boolean in one create-delete-reposition Core batch", () => {
    const boolean = { ...createNode("booleanOperation", 10, 20), id: "00000000-0000-4000-8000-000000000041", name: "Cutout", width: 90, height: 50, positionId: "00000000000000000000000000000041:00000000000000000000000000000000" };
    const first = { ...createNode("vector", 0, 0), id: "00000000-0000-4000-8000-000000000042", parentId: boolean.id, positionId: "00000000000000000000000000000042:00000000000000000000000000000000", fill: "#cc3366" };
    const second = { ...createNode("vector", 10, 0), id: "00000000-0000-4000-8000-000000000043", parentId: boolean.id, positionId: "00000000000000000000000000000043:00000000000000000000000000000000" };
    const ids = ["00000000-0000-4000-8000-000000000044", "00000000-0000-4000-8000-000000000045", "00000000-0000-4000-8000-000000000046", "00000000-0000-4000-8000-000000000047"];
    const resolved = resolveFlattenBooleanBatch([boolean, first, second], boolean.id, {
      subpaths: [{ closed: true, points: [{ x: 0, y: 0 }, { x: 90, y: 0 }, { x: 90, y: 50 }]}],
    }, () => ids.shift()!);

    expect(resolved?.replacement).toMatchObject({ id: "00000000-0000-4000-8000-000000000044", kind: "vector", name: "Cutout flattened", parentId: undefined, x: 10, y: 20, width: 90, height: 50, fill: "#cc3366", vectorPath: { fillRule: "nonZero", subpaths: [{ closed: true, points: [{ id: "00000000-0000-4000-8000-000000000045", x: 0, y: 0, pointType: "corner" }, { id: "00000000-0000-4000-8000-000000000046", x: 90, y: 0, pointType: "corner" }, { id: "00000000-0000-4000-8000-000000000047", x: 90, y: 50, pointType: "corner" }]}] } });
    expect(resolved?.batch).toEqual([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: "00000000-0000-4000-8000-000000000044", kind: "vector" }) }),
      { type: "delete", ids: [first.id, second.id] },
      { type: "delete", ids: [boolean.id] },
      { type: "reposition", positionIds: [{ id: "00000000-0000-4000-8000-000000000044", positionId: boolean.positionId }] },
    ]);
  });

  it("flattens a live Boolean into an alternate same-page parent and index without world drift", () => {
    const target = { ...createNode("frame", 300, 200), id: "00000000-0000-4000-8000-000000000121", width: 240, height: 180, positionId: "10000000000000000000000000000000:00000000000040008000000000000121" };
    const targetChild = { ...createNode("vector", 20, 20), id: "00000000-0000-4000-8000-000000000122", parentId: target.id, positionId: "20000000000000000000000000000000:00000000000040008000000000000122" };
    const boolean = { ...createNode("booleanOperation", 100, 80), id: "00000000-0000-4000-8000-000000000123", width: 90, height: 50, positionId: "30000000000000000000000000000000:00000000000040008000000000000123" };
    const first = { ...createNode("vector", 0, 0), id: "00000000-0000-4000-8000-000000000124", parentId: boolean.id, positionId: "10000000000000000000000000000000:00000000000040008000000000000124" };
    const second = { ...createNode("vector", 10, 0), id: "00000000-0000-4000-8000-000000000125", parentId: boolean.id, positionId: "20000000000000000000000000000000:00000000000040008000000000000125" };
    const replacementId = "00000000-0000-4000-8000-000000000126";
    const source = [target, targetChild, boolean, first, second];
    const before = transformPoint(worldTransformForNode(source, boolean.id)!, { x: 0, y: 0 });
    const resolved = resolveFlattenBooleanBatch(source, boolean.id, {
      subpaths: [{ closed: true, points: [{ x: 0, y: 0 }, { x: 90, y: 0 }, { x: 90, y: 50 }] }],
    }, () => "00000000-0000-4000-8000-000000000127", replacementId, { parentId: target.id, index: 0 })!;

    expect(resolved.replacement).toMatchObject({ id: replacementId, parentId: target.id, x: -200, y: -120 });
    expect(resolved.batch.at(-1)).toMatchObject({ type: "reposition", positionIds: [{ id: replacementId, positionId: expect.any(String) }] });
    const projected = [...source.filter((node) => ![boolean.id, first.id, second.id].includes(node.id)), { ...resolved.replacement, positionId: (resolved.batch.at(-1) as { positionIds: [{ positionId: string }] }).positionIds[0].positionId }];
    const after = transformPoint(worldTransformForNode(projected, replacementId)!, { x: 0, y: 0 });
    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.y).toBeCloseTo(before.y, 10);
  });

  it("keeps a forced Runtime flatten ID for an empty Rust Boolean result", () => {
    const boolean = { ...createNode("booleanOperation", 10, 20), id: "00000000-0000-4000-8000-000000000111", width: 90, height: 50 };
    const first = { ...createNode("vector", 0, 0), id: "00000000-0000-4000-8000-000000000112", parentId: boolean.id };
    const second = { ...createNode("vector", 10, 0), id: "00000000-0000-4000-8000-000000000113", parentId: boolean.id };
    const forcedId = "00000000-0000-4000-8000-000000000114";
    const resolved = resolveFlattenBooleanBatch([boolean, first, second], boolean.id, { subpaths: [] }, () => "00000000-0000-4000-8000-000000000115", forcedId);

    expect(resolved?.replacement).toMatchObject({ id: forcedId, vectorPath: { subpaths: [] } });
    expect(resolved?.batch[0]).toEqual(expect.objectContaining({ type: "create", node: expect.objectContaining({ id: forcedId }) }));
  });

  it("flattens one parametric leaf into an atomic Vector replacement", () => {
    const rectangle = {
      ...createNode("rectangle", 10, 20),
      id: "00000000-0000-4000-8000-000000000131",
      name: "Card",
      width: 90,
      height: 50,
      radius: 8,
      isMask: false,
      positionId: "00000000000000000000000000000131:00000000000000000000000000000000",
    };
    const replacementId = "00000000-0000-4000-8000-000000000132";
    const vectorPath = { fillRule: "nonZero" as const, subpaths: [{ closed: true, points: [
      { id: "p1", x: 0, y: 0, pointType: "corner" as const },
      { id: "p2", x: 90, y: 0, pointType: "corner" as const },
      { id: "p3", x: 90, y: 50, pointType: "corner" as const },
      { id: "p4", x: 0, y: 50, pointType: "corner" as const },
    ] }] };
    const resolved = resolveFlattenNodeBatch([rectangle], rectangle.id, vectorPath, () => replacementId, replacementId);

    expect(resolved?.replacement).toMatchObject({
      id: replacementId,
      kind: "vector",
      name: "Card flattened",
      x: 10,
      y: 20,
      width: 90,
      height: 50,
      radius: 0,
      vectorPath,
    });
    expect(resolved?.batch).toEqual([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: replacementId, kind: "vector", vectorPath }) }),
      { type: "delete", ids: [rectangle.id] },
      { type: "reposition", positionIds: [{ id: replacementId, positionId: rectangle.positionId }] },
    ]);
  });

  it("flattens several leaves into one atomic aggregate Vector replacement", () => {
    const target = { ...createNode("frame", 50, 20), id: "00000000-0000-4000-8000-000000000141", width: 400, height: 200 };
    const first = { ...createNode("rectangle", 120, 80), id: "00000000-0000-4000-8000-000000000142", width: 40, height: 20, fill: "#3366cc", strokeWidth: 0 };
    const second = { ...createNode("ellipse", 310, 120), id: "00000000-0000-4000-8000-000000000143", width: 40, height: 20, fill: "#3366cc", strokeWidth: 0 };
    const targetChild = { ...createNode("vector", 0, 0), id: "00000000-0000-4000-8000-000000000144", parentId: target.id };
    const replacementId = "00000000-0000-4000-8000-000000000145";
    const vectorPath = { fillRule: "nonZero" as const, subpaths: [
      { closed: true, points: [{ id: "p1", x: 0, y: 0, pointType: "corner" as const }, { id: "p2", x: 40, y: 0, pointType: "corner" as const }, { id: "p3", x: 40, y: 20, pointType: "corner" as const }] },
      { closed: true, points: [{ id: "p4", x: 190, y: 40, pointType: "corner" as const }, { id: "p5", x: 230, y: 40, pointType: "corner" as const }, { id: "p6", x: 230, y: 60, pointType: "corner" as const }] },
    ] };
    const regionExtension = { "figma.runtime.vector-network.v1": [1, 2, 3] };
    const fillStack = { layers: [{ visible: true, opacity: 1, blendMode: "normal" as const, paint: { css: "#3366cc" } }] };
    const resolved = resolveFlattenNodesBatch(
      [target, first, second, targetChild],
      [first.id, second.id],
      vectorPath,
      () => replacementId,
      replacementId,
      { parentId: target.id, index: 0 },
      { fillStack, extensions: regionExtension },
    );

    expect(resolved?.replacement).toMatchObject({ id: replacementId, kind: "vector", name: "Flattened", parentId: target.id, x: 70, y: 60, width: 230, height: 60, vectorPath, fillStack, extensions: regionExtension });
    expect(resolved?.batch).toEqual([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: replacementId, kind: "vector", vectorPath }) }),
      { type: "delete", ids: [first.id, second.id] },
      { type: "reposition", positionIds: [{ id: replacementId, positionId: expect.any(String) }] },
    ]);
  });

  it("outlines a Vector Stroke as one same-ID Vector update", () => {
    const vector = { ...createNode("vector", 10, 20), id: "00000000-0000-4000-8000-000000000051", name: "Curve", stroke: "#cc3366", strokeWidth: 6, strokeCapStart: "round" as const, strokeCapEnd: "round" as const };
    const ids = ["00000000-0000-4000-8000-000000000052", "00000000-0000-4000-8000-000000000053", "00000000-0000-4000-8000-000000000054"];
    const resolved = resolveOutlineStrokeBatch([vector], vector.id, {
      subpaths: [{ closed: true, points: [{ x: -3, y: -3 }, { x: 163, y: -3 }, { x: 80, y: 123 }]}],
    }, () => ids.shift()!);

    expect(resolved?.outlined).toMatchObject({ id: vector.id, kind: "vector", name: "Curve outlined", fill: "#cc3366", stroke: "transparent", strokeWidth: 0, strokeCapStart: "none", strokeCapEnd: "none", vectorPath: { fillRule: "nonZero", subpaths: [{ closed: true, points: [{ id: "00000000-0000-4000-8000-000000000052", x: -3, y: -3, pointType: "corner" }, { id: "00000000-0000-4000-8000-000000000053", x: 163, y: -3, pointType: "corner" }, { id: "00000000-0000-4000-8000-000000000054", x: 80, y: 123, pointType: "corner" }]}] } });
    expect(resolved?.batch).toEqual([expect.objectContaining({ type: "update", node: expect.objectContaining({ id: vector.id, strokeWidth: 0, fill: "#cc3366" }) })]);
    expect(resolveOutlineStrokeBatch([{ ...vector, strokeDashPattern: [4, 2] }], vector.id, { subpaths: [{ closed: true, points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 2 }]}] })).toBeUndefined();
  });

  it("outlines a Line through an atomic Vector replacement while preserving its world endpoint", () => {
    const line = { ...createNode("line", 10, 20), id: "00000000-0000-4000-8000-000000000056", name: "Divider", width: 120, height: 0, rotation: 30, stroke: "#cc3366", strokeWidth: 6, strokeCapStart: "round" as const, strokeCapEnd: "round" as const, positionId: "00000000000000000000000000000056:00000000000000000000000000000000" };
    const ids = ["00000000-0000-4000-8000-000000000057", "00000000-0000-4000-8000-000000000058", "00000000-0000-4000-8000-000000000059", "00000000-0000-4000-8000-00000000005a", "00000000-0000-4000-8000-00000000005b"];
    const resolved = resolveLineOutlineStrokeBatch([line], line.id, {
      subpaths: [{ closed: true, points: [{ x: -3, y: 0 }, { x: 0, y: -3 }, { x: 120, y: -3 }, { x: 123, y: 0 }]}],
    }, () => ids.shift()!);

    expect(resolved?.outlined).toMatchObject({ id: "00000000-0000-4000-8000-000000000057", kind: "vector", name: "Divider outlined", width: 126, height: 3, fill: "#cc3366", stroke: "transparent", strokeWidth: 0, vectorPath: { subpaths: [expect.objectContaining({ closed: true, points: expect.arrayContaining([expect.objectContaining({ id: "00000000-0000-4000-8000-000000000058", x: -3, y: 0 })]) })] } });
    expect(resolved?.outlined.relativeTransform).toMatchObject({ a: Math.cos(Math.PI / 6), d: Math.cos(Math.PI / 6), e: 10, f: 20 });
    expect(resolved?.outlined.relativeTransform?.b).toBeCloseTo(.5);
    expect(resolved?.outlined.relativeTransform?.c).toBeCloseTo(-.5);
    expect(resolved?.batch).toEqual([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: "00000000-0000-4000-8000-000000000057", kind: "vector" }) }),
      { type: "delete", ids: [line.id] },
      { type: "reposition", positionIds: [{ id: "00000000-0000-4000-8000-000000000057", positionId: line.positionId }] },
    ]);
    expect(resolveLineOutlineStrokeBatch([{ ...line, strokeDashPattern: [4, 2] }], line.id, { subpaths: [{ closed: true, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]}] })).toBeUndefined();
  });

  it("converts a Polygon to a closed Vector in one create-delete-reposition Core batch", () => {
    const polygon = { ...createNode("polygon", 10, 20), id: "00000000-0000-4000-8000-000000000061", name: "Badge", width: 90, height: 50, positionId: "00000000000000000000000000000061:00000000000000000000000000000000", parametricShape: { kind: "polygon" as const, pointCount: 3 } };
    const ids = ["00000000-0000-4000-8000-000000000062", "00000000-0000-4000-8000-000000000063", "00000000-0000-4000-8000-000000000064", "00000000-0000-4000-8000-000000000065"];
    const resolved = resolveParametricShapeToVectorBatch([polygon], polygon.id, [{ x: 45, y: 0 }, { x: 90, y: 50 }, { x: 0, y: 50 }], () => ids.shift()!);

    expect(resolved?.replacement).toMatchObject({ id: "00000000-0000-4000-8000-000000000062", kind: "vector", name: "Badge vector", x: 10, y: 20, width: 90, height: 50, parametricShape: undefined, vectorPath: { fillRule: "nonZero", subpaths: [{ closed: true, points: [{ id: "00000000-0000-4000-8000-000000000063", x: 45, y: 0, pointType: "corner" }, { id: "00000000-0000-4000-8000-000000000064", x: 90, y: 50, pointType: "corner" }, { id: "00000000-0000-4000-8000-000000000065", x: 0, y: 50, pointType: "corner" }]}] } });
    expect(resolved?.batch).toEqual([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: "00000000-0000-4000-8000-000000000062", kind: "vector" }) }),
      { type: "delete", ids: [polygon.id] },
      { type: "reposition", positionIds: [{ id: "00000000-0000-4000-8000-000000000062", positionId: polygon.positionId }] },
    ]);
    expect(resolveParametricShapeToVectorBatch([polygon], polygon.id, [{ x: 0, y: 0 }, { x: 1, y: 0 }])).toBeUndefined();
  });

  it("keeps mask identity through Boolean, Line and parametric Vector replacements", () => {
    const target = { ...rectangle("00000000-0000-4000-8000-000000000070"), positionId: "00000000000000000000000000000070:00000000000000000000000000000000" };
    const boolean = { ...createNode("booleanOperation", 0, 0), id: "00000000-0000-4000-8000-000000000071", isMask: true, positionId: "00000000000000000000000000000061:00000000000000000000000000000000" };
    const first = { ...createNode("vector", 0, 0), id: "00000000-0000-4000-8000-000000000072", parentId: boolean.id, vectorPath: { fillRule: "nonZero" as const, subpaths: [{ closed: true, points: [{ id: "00000000-0000-4000-8000-000000000073", x: 0, y: 0, pointType: "corner" as const }, { id: "00000000-0000-4000-8000-000000000074", x: 1, y: 0, pointType: "corner" as const }, { id: "00000000-0000-4000-8000-000000000075", x: 0, y: 1, pointType: "corner" as const }] }] } };
    const second = { ...first, id: "00000000-0000-4000-8000-000000000076" };
    const flattened = resolveFlattenBooleanBatch([boolean, first, second, target], boolean.id, { subpaths: [{ closed: true, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }]}] }, (() => { let id = 80; return () => `00000000-0000-4000-8000-${(id++).toString().padStart(12, "0")}`; })());
    expect(flattened?.replacement.isMask).toBe(true);
    expect(flattened?.batch.at(-1)).toEqual({ type: "setMask", id: flattened?.replacement.id, enabled: true });

    const line = { ...createNode("line", 0, 0), id: "00000000-0000-4000-8000-000000000090", isMask: true, width: 10, strokeWidth: 2, positionId: "00000000000000000000000000000060:00000000000000000000000000000000" };
    const outlined = resolveLineOutlineStrokeBatch([line, target], line.id, { subpaths: [{ closed: true, points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 2 }]}] }, (() => { let id = 91; return () => `00000000-0000-4000-8000-${(id++).toString().padStart(12, "0")}`; })());
    expect(outlined?.batch.at(-1)).toEqual({ type: "setMask", id: outlined?.outlined.id, enabled: true });

    const polygon = { ...createNode("polygon", 0, 0), id: "00000000-0000-4000-8000-000000000095", isMask: true, positionId: "00000000000000000000000000000065:00000000000000000000000000000000", parametricShape: { kind: "polygon" as const, pointCount: 3 } };
    const vector = resolveParametricShapeToVectorBatch([polygon, target], polygon.id, [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 2 }], (() => { let id = 96; return () => `00000000-0000-4000-8000-${(id++).toString().padStart(12, "0")}`; })());
    expect(vector?.batch.at(-1)).toEqual({ type: "setMask", id: vector?.replacement.id, enabled: true });
  });

  it("admits a Group mask only when its descendant subtree can provide alpha", () => {
    const mask = { ...createNode("group", 0, 0), id: "00000000-0000-4000-8000-000000000101", positionId: "00000000000000000000000000000101:00000000000000000000000000000000" };
    const child = { ...rectangle("00000000-0000-4000-8000-000000000102"), parentId: mask.id };
    const target = { ...rectangle("00000000-0000-4000-8000-000000000103"), positionId: "00000000000000000000000000000103:00000000000000000000000000000000" };

    expect(resolveCoreBatch([mask, target], [{ type: "setMask", id: mask.id, enabled: true }])).toBeUndefined();
    expect(resolveCoreBatch([mask, child, target], [{ type: "setMask", id: mask.id, enabled: true }])).toMatchObject({
      nextNodes: expect.arrayContaining([expect.objectContaining({ id: mask.id, isMask: true })]),
      batch: [{ type: "setMask", id: mask.id, enabled: true }],
    });
  });

  it("admits a TransformGroup mask only when it owns a source subtree", () => {
    const modifier = [{ type: "REPEAT" as const, repeatType: "LINEAR" as const, count: 1, unitType: "PIXELS" as const, offset: 40, axis: "VERTICAL" as const }];
    const mask = { ...createNode("transformGroup", 0, 0), id: "00000000-0000-4000-8000-000000000105", transformModifiers: modifier, positionId: "00000000000000000000000000000105:00000000000000000000000000000000" };
    const child = { ...rectangle("00000000-0000-4000-8000-000000000106"), parentId: mask.id };
    const target = { ...rectangle("00000000-0000-4000-8000-000000000107"), positionId: "00000000000000000000000000000107:00000000000000000000000000000000" };

    expect(resolveCoreBatch([mask, target], [{ type: "setMask", id: mask.id, enabled: true }])).toBeUndefined();
    expect(resolveCoreBatch([mask, child, target], [{ type: "setMask", id: mask.id, enabled: true }])).toMatchObject({
      nextNodes: expect.arrayContaining([expect.objectContaining({ id: mask.id, isMask: true })]),
      batch: [{ type: "setMask", id: mask.id, enabled: true }],
    });
  });

  it("admits a live Vector Boolean mask and rejects operands without canonical paths", () => {
    const boolean = { ...createNode("booleanOperation", 0, 0), id: "00000000-0000-4000-8000-000000000111", positionId: "00000000000000000000000000000111:00000000000000000000000000000000" };
    const first = { ...createNode("vector", 0, 0), id: "00000000-0000-4000-8000-000000000112", parentId: boolean.id };
    const second = { ...createNode("vector", 10, 10), id: "00000000-0000-4000-8000-000000000113", parentId: boolean.id };
    const target = { ...rectangle("00000000-0000-4000-8000-000000000114"), positionId: "00000000000000000000000000000114:00000000000000000000000000000000" };

    expect(resolveCoreBatch([boolean, first, second, target], [{ type: "setMask", id: boolean.id, enabled: true }])).toMatchObject({
      nextNodes: expect.arrayContaining([expect.objectContaining({ id: boolean.id, isMask: true })]),
      batch: [{ type: "setMask", id: boolean.id, enabled: true }],
    });
    expect(resolveCoreBatch([boolean, first, { ...second, vectorPath: undefined }, target], [{ type: "setMask", id: boolean.id, enabled: true }])).toBeUndefined();
    expect(resolveCoreBatch([{ ...boolean, isMask: true }, first, { ...second, vectorPath: undefined }, target], [{ type: "setMask", id: boolean.id, enabled: false }])).toMatchObject({
      nextNodes: expect.arrayContaining([expect.objectContaining({ id: boolean.id, isMask: false })]),
    });
  });

  it("wraps a single selected layer and makes the wrapper the resolved selection", () => {
    const child = { ...rectangle("00000000-0000-4000-8000-000000000001"), x: 25, y: 40, width: 48, height: 24 };
    const groupId = "00000000-0000-4000-8000-000000000003";
    const before = worldTransformForNode([child], child.id)!;
    const resolved = resolveCoreBatch([child], [{ type: "group", ids: [child.id] }], () => groupId);

    expect(resolved?.selectionIds).toEqual([groupId]);
    expect(resolved?.affectedGroupIds).toEqual([groupId]);
    expect(resolved?.nextNodes.find((node) => node.id === groupId)).toMatchObject({ kind: "group", width: 48, height: 24 });
    const after = worldTransformForNode(resolved!.nextNodes, child.id)!;
    for (const point of [{ x: 0, y: 0 }, { x: child.width, y: 0 }, { x: child.width, y: child.height }, { x: 0, y: child.height }]) {
      expect(transformPoint(after, point)).toEqual(transformPoint(before, point));
    }
  });

  it("wraps a single child in a rotated Frame without visual drift", () => {
    const frame = { ...createNode("frame", 100, 50), id: "00000000-0000-4000-8000-000000000010", width: 300, height: 200, rotation: 30 };
    const child = { ...rectangle("00000000-0000-4000-8000-000000000011"), parentId: frame.id, width: 48, height: 24, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 30, f: 40 } };
    const before = worldTransformForNode([frame, child], child.id)!;
    const groupId = "00000000-0000-4000-8000-000000000012";
    const resolved = resolveCoreBatch([frame, child], [{ type: "group", ids: [child.id] }], () => groupId)!;
    const after = worldTransformForNode(resolved.nextNodes, child.id)!;

    expect(resolved.nextNodes.find((node) => node.id === groupId)?.relativeTransform).toBeDefined();
    for (const point of [{ x: 0, y: 0 }, { x: child.width, y: 0 }, { x: child.width, y: child.height }, { x: 0, y: child.height }]) {
      expect(transformPoint(after, point).x).toBeCloseTo(transformPoint(before, point).x, 10);
      expect(transformPoint(after, point).y).toBeCloseTo(transformPoint(before, point).y, 10);
    }
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
      { type: "reparent", parentIds: [expect.objectContaining({ id: child.id, parentId: undefined, positionId: expect.any(String) })] },
      expect.objectContaining({ type: "update", node: expect.objectContaining({ id: child.id, parentId: undefined, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 } }) }),
    ]);
    expect(resolved?.nextNodes).toEqual([expect.objectContaining({ id: child.id, parentId: undefined, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 } })]);
    expect(resolved?.selectionIds).toEqual([child.id]);
  });

  it("moves a grouped child after grouping — the pointer drag commits its new relativeTransform", () => {
    // Regression: after group, the child is Relative-v1, so its world position is
    // derived from relativeTransform and ignores x/y. A move must yield a fresh
    // relativeTransform, not an x/y patch, or the child appears frozen.
    const first = { ...rectangle("00000000-0000-4000-8000-000000000001"), x: 10, y: 20, width: 40, height: 30, positionId: "00000000000000000000000000000001:00000000000000000000000000000000" };
    const second = { ...rectangle("00000000-0000-4000-8000-000000000002"), x: 80, y: 50, width: 20, height: 20, positionId: "00000000000000000000000000000002:00000000000000000000000000000000" };
    const groupId = "00000000-0000-4000-8000-000000000003";
    const grouped = resolveCoreBatch([first, second], [{ type: "group", ids: [first.id, second.id] }], () => groupId);
    const scene = grouped!.nextNodes;
    expect(scene.find((node) => node.id === first.id)).toMatchObject({ relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } });

    const patch = translateNodeWorldPatch(scene, first.id, 15, -5)!;
    expect(patch.relativeTransform).toBeDefined();
    const moved = resolveCoreBatch(scene, [{ type: "update", id: first.id, patch }]);
    expect(moved).toBeDefined();
    // The child's world origin actually shifts by the drag delta.
    expect(transformPoint(worldTransformForNode(moved!.nextNodes, first.id)!, { x: 0, y: 0 })).toEqual({ x: 25, y: 15 });
  });

  it("atomically re-normalizes affected Relative-v1 Group bounds after a child edit", () => {
    const group = { ...createNode("group", 100, 50), id: "00000000-0000-4000-8000-000000000001", width: 200, height: 120, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 100, f: 50 } };
    const first = { ...rectangle("00000000-0000-4000-8000-000000000002"), parentId: group.id, width: 40, height: 20, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 30, f: 25 } };
    const second = { ...rectangle("00000000-0000-4000-8000-000000000003"), parentId: group.id, width: 30, height: 30, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 110, f: 75 } };
    const source = [group, first, second];
    const movedPatch = translateNodeWorldPatch(source, first.id, -20, -20)!;
    const movedOnly = source.map((node) => node.id === first.id ? { ...node, ...movedPatch } : node);
    const beforeWorld = [first, second].map((node) => worldTransformForNode(movedOnly, node.id)!);
    const resolved = resolveCoreBatch(source, [{ type: "update", id: first.id, patch: movedPatch }])!;

    expect(resolved.affectedGroupIds).toEqual([group.id]);
    // The child is emitted exactly once in its final re-based form; the parent
    // still precedes every child in the atomic Core batch.
    expect(resolved.batch.map((entry) => entry.type)).toEqual(["update", "update", "update"]);
    expect(resolved.batch.map((entry) => entry.type === "update" ? entry.node.id : undefined)).toEqual([group.id, first.id, second.id]);
    expect(resolved.nextNodes.find((node) => node.id === group.id)).toMatchObject({ width: 130, height: 100 });
    for (const [index, node] of [first, second].entries()) {
      const after = worldTransformForNode(resolved.nextNodes, node.id)!;
      for (const point of [{ x: 0, y: 0 }, { x: node.width, y: node.height }]) {
        expect(transformPoint(after, point)).toEqual(transformPoint(beforeWorld[index], point));
      }
    }
  });

  it("moves a former child after ungrouping — its committed relativeTransform still translates", () => {
    // Regression: ungroup leaves each former child Relative-v1 relative to the old
    // Group's parent, so a subsequent move must also update relativeTransform.
    const group = { ...createNode("group", 0, 0), id: "00000000-0000-4000-8000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000" };
    const child = { ...rectangle("00000000-0000-4000-8000-000000000002"), parentId: group.id, positionId: "00000000000000000000000000000002:00000000000000000000000000000000" };
    const ungrouped = resolveCoreBatch([group, child], [{ type: "ungroup", id: group.id }]);
    const scene = ungrouped!.nextNodes;
    expect(scene.find((node) => node.id === child.id)).toMatchObject({ parentId: undefined, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 } });

    const patch = translateNodeWorldPatch(scene, child.id, 30, 40)!;
    expect(patch.relativeTransform).toBeDefined();
    const moved = resolveCoreBatch(scene, [{ type: "update", id: child.id, patch }]);
    expect(moved).toBeDefined();
    expect(transformPoint(worldTransformForNode(moved!.nextNodes, child.id)!, { x: 0, y: 0 })).toEqual({ x: 40, y: 60 });
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

describe("clipboard capture and paste resolution", () => {
  const frameId = "00000000-0000-4000-8000-000000000011";
  const innerId = "00000000-0000-4000-8000-000000000012";
  const imageId = "00000000-0000-4000-8000-000000000013";
  const siblingId = "00000000-0000-4000-8000-000000000014";

  function subtreeDocument(): CanvasNode[] {
    const frame = { ...createNode("frame", 10, 20), id: frameId, positionId: "00000000000000000000000000000001:00000000000000000000000000000000" };
    const inner = { ...createNode("group", 15, 25), id: innerId, parentId: frame.id, positionId: "00000000000000000000000000000002:00000000000000000000000000000000" };
    const image = { ...createNode("image", 5, 5), id: imageId, parentId: inner.id, assetId: "asset-a", positionId: "00000000000000000000000000000003:00000000000000000000000000000000" };
    const sibling = { ...createNode("rectangle", 200, 40), id: siblingId, positionId: "00000000000000000000000000000004:00000000000000000000000000000000" };
    return [frame, inner, image, sibling];
  }

  it("captures a full subtree by value and lists image asset references without bytes", () => {
    const clipboard = captureClipboard(subtreeDocument(), [frameId], 19);
    expect(clipboard?.schemaVersion).toBe(19);
    expect(clipboard?.rootIds).toEqual([frameId]);
    expect(clipboard?.nodes.map((node) => node.id)).toEqual([frameId, innerId, imageId]);
    expect(clipboard?.assetIds).toEqual(["asset-a"]);
    // A captured node must be a detached clone, never a live document reference.
    expect(clipboard?.nodes[0]).not.toBe(subtreeDocument()[0]);
  });

  it("collapses an ancestor+descendant selection to the single owning root", () => {
    const clipboard = captureClipboard(subtreeDocument(), [frameId, imageId], 19);
    expect(clipboard?.rootIds).toEqual([frameId]);
    expect(clipboard?.nodes).toHaveLength(3);
  });

  it("returns nothing for empty, repeated, or missing selections", () => {
    const document = subtreeDocument();
    expect(captureClipboard(document, [], 19)).toBeUndefined();
    expect(captureClipboard(document, [frameId, frameId], 19)).toBeUndefined();
    expect(captureClipboard(document, ["00000000-0000-4000-8000-000000000099"], 19)).toBeUndefined();
  });

  it("pastes a captured subtree under the page root with fresh IDs and offset roots", () => {
    const clipboard = captureClipboard(subtreeDocument(), [frameId], 19)!;
    const ids = ["00000000-0000-4000-8000-000000000021", "00000000-0000-4000-8000-000000000022", "00000000-0000-4000-8000-000000000023"];
    const resolved = resolvePasteBatch([], clipboard, {}, new Set(["asset-a"]), () => ids.shift()!);

    expect(resolved?.createdIds).toEqual(["00000000-0000-4000-8000-000000000021"]);
    expect(resolved?.batch.map((entry) => (entry as { node: { id: string; parentId?: string; kind: string } }).node)).toEqual([
      expect.objectContaining({ id: "00000000-0000-4000-8000-000000000021", kind: "frame", parentId: undefined, x: 34, y: 44 }),
      expect.objectContaining({ id: "00000000-0000-4000-8000-000000000022", kind: "group", parentId: "00000000-0000-4000-8000-000000000021" }),
      expect.objectContaining({ id: "00000000-0000-4000-8000-000000000023", kind: "image", parentId: "00000000-0000-4000-8000-000000000022" }),
    ]);
  });

  it("re-homes pasted roots onto the target container while remapping internal parents", () => {
    const clipboard = captureClipboard(subtreeDocument(), [frameId], 19)!;
    const target = { ...createNode("frame", 400, 400), id: "00000000-0000-4000-8000-000000000031" };
    const ids = ["00000000-0000-4000-8000-000000000041", "00000000-0000-4000-8000-000000000042", "00000000-0000-4000-8000-000000000043"];
    const resolved = resolvePasteBatch([target], clipboard, { parentId: target.id }, new Set(["asset-a"]), () => ids.shift()!);

    expect(resolved?.batch[0]).toMatchObject({ node: { parentId: target.id } });
    expect(resolved?.batch[1]).toMatchObject({ node: { parentId: "00000000-0000-4000-8000-000000000041" } });
    expect(resolved?.batch[2]).toMatchObject({ node: { parentId: "00000000-0000-4000-8000-000000000042" } });
  });

  it("re-homes an entire pasted subtree onto an explicitly different page", () => {
    const sourcePageId = "00000000-0000-4000-8000-000000000001";
    const targetPageId = "00000000-0000-4000-8000-000000000002";
    const source = subtreeDocument().map((node) => ({ ...node, pageId: sourcePageId }));
    const clipboard = captureClipboard(source, [frameId], 19)!;
    const ids = ["00000000-0000-4000-8000-000000000051", "00000000-0000-4000-8000-000000000052", "00000000-0000-4000-8000-000000000053"];
    const resolved = resolvePasteBatch([], clipboard, { pageId: targetPageId }, new Set(["asset-a"]), () => ids.shift()!);

    expect(resolved?.nextNodes).toEqual([
      expect.objectContaining({ id: "00000000-0000-4000-8000-000000000051", pageId: targetPageId, parentId: undefined }),
      expect.objectContaining({ id: "00000000-0000-4000-8000-000000000052", pageId: targetPageId, parentId: "00000000-0000-4000-8000-000000000051" }),
      expect.objectContaining({ id: "00000000-0000-4000-8000-000000000053", pageId: targetPageId, parentId: "00000000-0000-4000-8000-000000000052" }),
    ]);
  });

  it("rejects a cross-document paste whose image asset is missing from the target index (P0-1)", () => {
    const clipboard = captureClipboard(subtreeDocument(), [frameId], 19)!;
    expect(resolvePasteBatch([], clipboard, {}, new Set())).toBeUndefined();
    expect(resolvePasteBatch([], clipboard, {}, new Set(["other-asset"]))).toBeUndefined();
  });

  it("rejects an external asset reference whose target content hash differs", () => {
    const clipboard = { ...captureClipboard(subtreeDocument(), [frameId], 19)!, assetContentHashes: { "asset-a": "a".repeat(64) } };
    expect(resolvePasteBatch([], clipboard, {}, new Set(["asset-a"]), undefined, 19, new Map([["asset-a", "b".repeat(64)]]))).toBeUndefined();
    let sequence = 90;
    expect(resolvePasteBatch([], clipboard, {}, new Set(["asset-a"]), () => `00000000-0000-4000-8000-${(sequence++).toString().padStart(12, "0")}`, 19, new Map([["asset-a", "a".repeat(64)]]))).toBeDefined();
  });

  it("rejects a paste target that is missing or cannot own children", () => {
    const clipboard = captureClipboard(subtreeDocument(), [frameId], 19)!;
    expect(resolvePasteBatch([], clipboard, { parentId: "missing" }, new Set(["asset-a"]))).toBeUndefined();
    const leaf = rectangle("00000000-0000-4000-8000-000000000099");
    expect(resolvePasteBatch([leaf], clipboard, { parentId: leaf.id }, new Set(["asset-a"]))).toBeUndefined();
  });

  it("pastes an asset-free subtree into any document regardless of the asset index", () => {
    const rect = { ...createNode("rectangle", 10, 20), id: siblingId, positionId: "00000000000000000000000000000001:00000000000000000000000000000000" };
    const clipboard = captureClipboard([rect], [siblingId], 19)!;
    expect(clipboard.assetIds).toEqual([]);
    const pasteId = "00000000-0000-4000-8000-000000000051";
    const resolved = resolvePasteBatch([], clipboard, {}, new Set(), () => pasteId);
    expect(resolved?.createdIds).toEqual([pasteId]);
  });

  it("defers a pasted alpha mask until its following pasted target exists", () => {
    const mask = { ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000056", isMask: true, positionId: "00000000000000000000000000000056:00000000000000000000000000000000" };
    const target = { ...createNode("rectangle", 20, 0), id: "00000000-0000-4000-8000-000000000057", positionId: "00000000000000000000000000000057:00000000000000000000000000000000" };
    const clipboard = captureClipboard([mask, target], [mask.id, target.id], 19)!;
    const resolved = resolvePasteBatch([], clipboard, {}, new Set(), (() => { let id = 58; return () => `00000000-0000-4000-8000-${(id++).toString().padStart(12, "0")}`; })());

    expect(resolved?.batch.map((entry) => entry.type)).toEqual(["create", "create", "setMask"]);
    expect(resolved?.batch.at(-1)).toMatchObject({ type: "setMask", enabled: true });
  });

  it("captures and pastes Polygon, Star, Vector and Slice nodes", () => {
    const kinds = ["polygon", "star", "vector", "slice"] as const;
    const source = kinds.map((kind, index) => ({
      ...createNode(kind, index * 20, index * 20),
      id: `00000000-0000-4000-8000-${(index + 61).toString().padStart(12, "0")}`,
    }));
    const clipboard = captureClipboard(source, source.map((node) => node.id), 19)!;
    let sequence = 70;
    const resolved = resolvePasteBatch([], clipboard, {}, new Set(), () => `00000000-0000-4000-8000-${(sequence++).toString().padStart(12, "0")}`);

    expect(resolved?.batch.map((entry) => (entry as { node: { kind: string } }).node.kind)).toEqual(kinds);
    expect(resolved?.createdIds).toHaveLength(kinds.length);
  });

  it("converts Auto Layout flow descendants from Relative-v1 to reflowable geometry", () => {
    const parent = {
      ...createNode("frame", 100, 100),
      id: "00000000-0000-4000-8000-000000000081",
      autoLayout: { mode: "vertical" as const, padding: [8, 8, 8, 8] as [number, number, number, number], itemSpacing: 8, wrap: false, primaryAlignment: "start" as const, counterAlignment: "start" as const, primarySizing: "fixed" as const, counterSizing: "fixed" as const, absolute: false },
    };
    const flow = { ...createNode("rectangle", 8, 8), id: "00000000-0000-4000-8000-000000000082", name: "Flow child", parentId: parent.id, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 8, f: 8 } };
    const absolute = { ...createNode("rectangle", 20, 20), id: "00000000-0000-4000-8000-000000000083", name: "Absolute child", parentId: parent.id, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 20, f: 20 }, autoLayout: { mode: "none" as const, padding: [0, 0, 0, 0] as [number, number, number, number], itemSpacing: 0, wrap: false, primaryAlignment: "start" as const, counterAlignment: "start" as const, primarySizing: "fixed" as const, counterSizing: "fixed" as const, absolute: true } };
    const clipboard = captureClipboard([parent, flow, absolute], [parent.id], 19)!;
    let sequence = 84;
    const resolved = resolvePasteBatch([], clipboard, {}, new Set(), () => `00000000-0000-4000-8000-${(sequence++).toString().padStart(12, "0")}`)!;
    const pastedFlow = resolved.nextNodes.find((node) => node.name === flow.name);
    const pastedAbsolute = resolved.nextNodes.find((node) => node.name === absolute.name);

    expect(pastedFlow?.relativeTransform).toBeUndefined();
    expect(pastedAbsolute?.relativeTransform).toEqual(absolute.relativeTransform);
  });

  it("converts a pasted root to reflowable geometry when the destination is an Auto Layout frame", () => {
    const destination = {
      ...createNode("frame", 100, 100),
      id: "00000000-0000-4000-8000-000000000086",
      autoLayout: { mode: "vertical" as const, padding: [8, 8, 8, 8] as [number, number, number, number], itemSpacing: 8, wrap: false, primaryAlignment: "start" as const, counterAlignment: "start" as const, primarySizing: "fixed" as const, counterSizing: "fixed" as const, absolute: false },
    };
    const source = { ...createNode("frame", 20, 20), id: "00000000-0000-4000-8000-000000000087", relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 20, f: 20 } };
    const clipboard = captureClipboard([destination, source], [source.id], 19)!;
    const resolved = resolvePasteBatch([destination, source], clipboard, { parentId: destination.id }, new Set(), () => "00000000-0000-4000-8000-000000000088")!;

    expect(resolved.nextNodes.at(-1)?.relativeTransform).toBeUndefined();
  });

  it("materializes legacy Relative-v1 matrices for Auto Layout frames and their flow children", () => {
    const layout = { ...createNode("frame", 10, 20), id: "00000000-0000-4000-8000-000000000089", autoLayout: { mode: "vertical" as const, padding: [0, 0, 0, 0] as [number, number, number, number], itemSpacing: 0, wrap: false, primaryAlignment: "start" as const, counterAlignment: "start" as const, primarySizing: "fixed" as const, counterSizing: "fixed" as const, absolute: false }, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 } };
    const flow = { ...createNode("rectangle", 4, 5), id: "00000000-0000-4000-8000-000000000090", parentId: layout.id, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 4, f: 5 } };
    const absolute = { ...flow, id: "00000000-0000-4000-8000-000000000094", autoLayout: { ...layout.autoLayout, mode: "none" as const, absolute: true } };
    const ordinary = { ...createNode("rectangle", 30, 40), id: "00000000-0000-4000-8000-000000000095", relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 30, f: 40 } };
    const normalized = normalizeAutoLayoutProjection([layout, flow, absolute, ordinary]);

    expect(normalized.map((node) => node.relativeTransform)).toEqual([undefined, undefined, absolute.relativeTransform, ordinary.relativeTransform]);
    expect(normalized[0]).toMatchObject({ x: 10, y: 20 });
    expect(normalized[1]).toMatchObject({ x: 14, y: 25 });
    expect(worldTransformForNode(normalized, flow.id)).toMatchObject({ e: 14, f: 25 });

    expect(autoLayoutProjectionNormalizationPatches([layout, flow, absolute, ordinary])).toEqual([
      { id: layout.id, patch: { relativeTransform: undefined } },
      { id: flow.id, patch: { x: 14, y: 25, relativeTransform: undefined } },
    ]);
  });

  it("re-homes a Relative-v1 pasted root against its destination rather than its source parent", () => {
    const sourceParent = { ...createNode("frame", 100, 200), id: "00000000-0000-4000-8000-000000000091" };
    const child = { ...createNode("frame", 20, 30), id: "00000000-0000-4000-8000-000000000092", parentId: sourceParent.id, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 20, f: 30 } };
    const clipboard = captureClipboard([sourceParent, child], [child.id], 19)!;
    const resolved = resolvePasteBatch([sourceParent, child], clipboard, {}, new Set(), () => "00000000-0000-4000-8000-000000000093")!;
    const pasted = resolved.nextNodes.at(-1)!;

    expect(pasted.relativeTransform).toBeUndefined();
    expect(pasted).toMatchObject({ x: 44, y: 54 });
  });

  it("captures and pastes all six node kinds and a nested container subtree with distinct fresh IDs", () => {
    const frame = { ...createNode("frame", 0, 0), id: "00000000-0000-4000-8000-000000000101", positionId: "00000000000000000000000000000101:00000000000000000000000000000000" };
    const rect = { ...createNode("rectangle", 5, 5), id: "00000000-0000-4000-8000-000000000102", parentId: frame.id, positionId: "00000000000000000000000000000102:00000000000000000000000000000000" };
    const ellipse = { ...createNode("ellipse", 6, 6), id: "00000000-0000-4000-8000-000000000103", parentId: frame.id, positionId: "00000000000000000000000000000103:00000000000000000000000000000000" };
    const line = { ...createNode("line", 7, 7), id: "00000000-0000-4000-8000-000000000104", parentId: frame.id, positionId: "00000000000000000000000000000104:00000000000000000000000000000000" };
    const text = { ...createNode("text", 8, 8), id: "00000000-0000-4000-8000-000000000105", parentId: frame.id, text: "Hi", positionId: "00000000000000000000000000000105:00000000000000000000000000000000" };
    const image = { ...createNode("image", 9, 9), id: "00000000-0000-4000-8000-000000000106", parentId: frame.id, assetId: "asset-z", positionId: "00000000000000000000000000000106:00000000000000000000000000000000" };
    const document = [frame, rect, ellipse, line, text, image];

    const clipboard = captureClipboard(document, [frame.id], 19)!;
    expect(clipboard.nodes.map((node) => node.kind)).toEqual(["frame", "rectangle", "ellipse", "line", "text", "image"]);
    expect(clipboard.assetIds).toEqual(["asset-z"]);

    let seq = 0;
    const resolved = resolvePasteBatch(document, clipboard, { parentId: frame.id }, new Set(["asset-z"]), () => `00000000-0000-4000-8000-0000000002${(seq++).toString().padStart(2, "0")}`);
    const created = resolved!.batch.map((entry) => (entry as { node: { id: string; kind: string; parentId?: string } }).node);
    expect(created.map((node) => node.kind)).toEqual(["frame", "rectangle", "ellipse", "line", "text", "image"]);
    // Every pasted node receives a fresh ID distinct from the source document.
    expect(created.every((node) => !document.some((original) => original.id === node.id))).toBe(true);
    expect(new Set(created.map((node) => node.id)).size).toBe(6);
    // Only the root is reported for post-paste selection; descendants re-nest under the remapped root.
    expect(resolved!.createdIds).toEqual([created[0].id]);
    expect(created.slice(1).every((node) => node.parentId === created[0].id)).toBe(true);
  });
});
