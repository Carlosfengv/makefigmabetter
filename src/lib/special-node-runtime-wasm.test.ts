import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_ID } from "./document-bootstrap";
import { createNode, type CanvasNode } from "./editor-protocol";
import { replaceRuntimeTextRangeWithStyles } from "../runtime/runtime-text";
import { resolveCoreBatch } from "./transaction-batch";
import { canvasNodeFromWasmProjection } from "./wasm-projection-node";

type WasmRuntime = typeof import("../wasm/generated/editor_wasm");
let runtime: Promise<WasmRuntime> | undefined;

async function loadRuntime() {
  runtime ??= import("../wasm/generated/editor_wasm").then(async (wasm) => {
    await wasm.default({ module_or_path: await readFile(new URL("../wasm/generated/editor_wasm_bg.wasm", import.meta.url)) });
    return wasm;
  });
  return runtime;
}

const id = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const positionId = (value: number) => `${(0x80000000000000000000000000000000n + BigInt(value)).toString(16)}:${id(value).replaceAll("-", "")}`;

describe("W12 special-node generated WASM transactions", () => {
  it("persists an empty ShapeWithText insertion style through confirmed edit, undo, and redo", async () => {
    const wasm = await loadRuntime();
    const engine = new wasm.DocumentEngine();
    const baseStyle = { fontSize: 22, fontWeight: 650, italic: true, letterSpacing: 1.25, color: { space: "srgb" as const, components: [1, 0, 0] as [number, number, number], alpha: 1 } };
    const properties = {
      runs: [],
      baseStyle,
      paragraph: { alignment: "center" as const, lineHeight: 26, paragraphSpacing: 3 },
      autoSize: "fixed" as const,
    };
    const shape = {
      ...createNode("shapeWithText", 20, 20),
      id: id(390),
      pageId: DEFAULT_PAGE_ID,
      positionId: positionId(390),
      text: "",
      textProperties: properties,
    };
    const created = resolveCoreBatch([], [{ type: "create", node: shape }]);
    expect(engine.apply_transaction_json(id(391), 0n, JSON.stringify(created!.batch))).toBe(1n);
    const projection = () => {
      const raw = JSON.parse(engine.snapshot_json()) as { nodes: Parameters<typeof canvasNodeFromWasmProjection>[0][] };
      return raw.nodes.map(canvasNodeFromWasmProjection) as CanvasNode[];
    };
    expect(projection().find((node) => node.id === shape.id)?.textProperties).toMatchObject(properties);

    const inserted = replaceRuntimeTextRangeWithStyles("", properties, 0, 0, "Hi");
    const updated = resolveCoreBatch(projection(), [{
      type: "update",
      id: shape.id,
      patch: { text: inserted.characters, textProperties: inserted.textProperties },
    }]);
    expect(engine.apply_transaction_json(id(392), 1n, JSON.stringify(updated!.batch))).toBe(2n);
    expect(projection().find((node) => node.id === shape.id)).toMatchObject({
      text: "Hi",
      textProperties: {
        baseStyle,
        runs: [{ start: 0, end: 2, ...baseStyle }],
      },
    });

    expect(engine.undo()).toBe(3n);
    expect(projection().find((node) => node.id === shape.id)).toMatchObject({ text: "", textProperties: properties });
    expect(engine.redo()).toBe(4n);
    expect(projection().find((node) => node.id === shape.id)).toMatchObject({ text: "Hi", textProperties: { baseStyle } });
  });

  it("applies confirmed ShapeWithText and TextPath plain-text edits without replaying immutable path state", async () => {
    const wasm = await loadRuntime();
    const engine = new wasm.DocumentEngine();
    const shape = { ...createNode("shapeWithText", 20, 20), id: id(401), pageId: DEFAULT_PAGE_ID, positionId: positionId(401), text: "Before" };
    const textPath = { ...createNode("textPath", 280, 20), id: id(402), pageId: DEFAULT_PAGE_ID, positionId: positionId(402), text: "Before" };
    const created = resolveCoreBatch([], [{ type: "create", node: shape }, { type: "create", node: textPath }]);
    expect(engine.apply_transaction_json(id(403), 0n, JSON.stringify(created!.batch))).toBe(1n);
    const beforeRaw = JSON.parse(engine.snapshot_json()) as { nodes: Parameters<typeof canvasNodeFromWasmProjection>[0][] };
    const beforePath = beforeRaw.nodes.map(canvasNodeFromWasmProjection).find((node) => node.id === textPath.id)?.vectorPath;

    const updated = resolveCoreBatch([shape, textPath], [
      { type: "update", id: shape.id, patch: { text: "Approved" } },
      { type: "update", id: textPath.id, patch: { text: "Curved review" } },
    ]);
    expect(updated?.batch).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "update", plainTextOnly: true, node: expect.objectContaining({ id: shape.id }) }),
      expect.objectContaining({ type: "update", plainTextOnly: true, node: expect.objectContaining({ id: textPath.id }) }),
    ]));
    expect(engine.apply_transaction_json(id(404), 1n, JSON.stringify(updated!.batch))).toBe(2n);

    const raw = JSON.parse(engine.snapshot_json()) as { nodes: Parameters<typeof canvasNodeFromWasmProjection>[0][] };
    const nodes = raw.nodes.map(canvasNodeFromWasmProjection) as CanvasNode[];
    expect(nodes.find((node) => node.id === shape.id)?.text).toBe("Approved");
    expect(nodes.find((node) => node.id === textPath.id)?.text).toBe("Curved review");
    expect(nodes.find((node) => node.id === textPath.id)?.vectorPath).toEqual(beforePath);

    const textProperties = {
      runs: [{ start: 0, end: 8, fontSize: 18, fontWeight: 650, italic: false, letterSpacing: 1.5 }],
      paragraph: { alignment: "center" as const, lineHeight: 24, paragraphSpacing: 4 },
      autoSize: "fixed" as const,
    };
    const styled = resolveCoreBatch(nodes, [{ type: "update", id: shape.id, patch: { textProperties } }]);
    expect(styled?.batch).toEqual([
      expect.objectContaining({ type: "update", plainTextOnly: true, node: expect.objectContaining({ id: shape.id, textProperties }) }),
    ]);
    expect(engine.apply_transaction_json(id(405), 2n, JSON.stringify(styled!.batch))).toBe(3n);
    const styledNodes = (JSON.parse(engine.snapshot_json()) as { nodes: Parameters<typeof canvasNodeFromWasmProjection>[0][] }).nodes.map(canvasNodeFromWasmProjection);
    expect(styledNodes.find((node) => node.id === shape.id)?.textProperties).toMatchObject(textProperties);
    expect(engine.undo()).toBe(4n);
    const undoneNodes = (JSON.parse(engine.snapshot_json()) as { nodes: Parameters<typeof canvasNodeFromWasmProjection>[0][] }).nodes.map(canvasNodeFromWasmProjection);
    expect(undoneNodes.find((node) => node.id === shape.id)?.textProperties ?? undefined).toBeUndefined();
  });

  it("creates, edits, and undoes targeted linear and radial Repeat TransformGroups", async () => {
    const wasm = await loadRuntime();
    const engine = new wasm.DocumentEngine();
    const existing = [
      { ...createNode("connector", 40, 60), id: id(408), pageId: DEFAULT_PAGE_ID, positionId: positionId(0) },
      { ...createNode("shapeWithText", 340, 40), id: id(409), pageId: DEFAULT_PAGE_ID, positionId: positionId(1) },
      { ...createNode("vector", 620, 80), id: id(410), pageId: DEFAULT_PAGE_ID, positionId: positionId(2) },
    ];
    const seeded = resolveCoreBatch([], existing.map((node) => ({ type: "create" as const, node })));
    expect(engine.apply_transaction_json(id(407), 0n, JSON.stringify(seeded!.batch))).toBe(1n);
    const projection = () => {
      const raw = JSON.parse(engine.snapshot_json()) as { nodes: Parameters<typeof canvasNodeFromWasmProjection>[0][] };
      return raw.nodes.map(canvasNodeFromWasmProjection) as CanvasNode[];
    };
    const confirmedExisting = projection();
    const first = { ...createNode("rectangle", 40, 300), id: id(411), pageId: DEFAULT_PAGE_ID, positionId: positionId(411), width: 100, height: 80 };
    const second = { ...createNode("ellipse", 180, 300), id: id(412), pageId: DEFAULT_PAGE_ID, positionId: positionId(412), width: 100, height: 80 };
    const groupId = id(413);
    const horizontal = [{ type: "REPEAT" as const, repeatType: "LINEAR" as const, count: 2, unitType: "PIXELS" as const, offset: 260, axis: "HORIZONTAL" as const }];
    const created = resolveCoreBatch(confirmedExisting, [
      { type: "create", node: first },
      { type: "create", node: second },
      { type: "transformGroup", ids: [first.id, second.id], id: groupId, pageId: DEFAULT_PAGE_ID, index: 3, modifiers: horizontal, patch: { name: "Repeated pair" } },
    ]);
    expect(created).toBeDefined();
    expect(engine.apply_transaction_json(id(414), 1n, JSON.stringify(created!.batch))).toBe(2n);

    expect(projection().find((node) => node.id === groupId)).toMatchObject({ kind: "transformGroup", name: "Repeated pair", transformModifiers: horizontal });
    expect(projection().filter((node) => node.parentId === groupId).map((node) => node.id)).toEqual([first.id, second.id]);

    const vertical = [{ type: "REPEAT" as const, repeatType: "LINEAR" as const, count: 2, unitType: "PIXELS" as const, offset: 180, axis: "VERTICAL" as const }];
    const updated = resolveCoreBatch(projection(), [{ type: "update", id: groupId, patch: { transformModifiers: vertical } }]);
    expect(updated).toBeDefined();
    expect(engine.apply_transaction_json(id(415), 2n, JSON.stringify(updated!.batch))).toBe(3n);
    expect(projection().find((node) => node.id === groupId)?.transformModifiers).toEqual(vertical);
    const radial = [{ type: "REPEAT" as const, repeatType: "RADIAL" as const, count: 3, unitType: "PIXELS" as const, offset: 120 }];
    const radialUpdate = resolveCoreBatch(projection(), [{ type: "update", id: groupId, patch: { transformModifiers: radial } }]);
    expect(radialUpdate).toBeDefined();
    expect(engine.apply_transaction_json(id(416), 3n, JSON.stringify(radialUpdate!.batch))).toBe(4n);
    expect(projection().find((node) => node.id === groupId)?.transformModifiers).toEqual(radial);
    const stacked = [
      { type: "REPEAT" as const, repeatType: "LINEAR" as const, count: 1, unitType: "PIXELS" as const, offset: 100, axis: "HORIZONTAL" as const },
      { type: "REPEAT" as const, repeatType: "LINEAR" as const, count: 1, unitType: "PIXELS" as const, offset: 80, axis: "VERTICAL" as const },
    ];
    const stackedUpdate = resolveCoreBatch(projection(), [{ type: "update", id: groupId, patch: { transformModifiers: stacked } }]);
    expect(stackedUpdate).toBeDefined();
    expect(engine.apply_transaction_json(id(417), 4n, JSON.stringify(stackedUpdate!.batch))).toBe(5n);
    expect(projection().find((node) => node.id === groupId)?.transformModifiers).toEqual(stacked);
    expect(engine.undo()).toBe(6n);
    expect(projection().find((node) => node.id === groupId)?.transformModifiers).toEqual(radial);
    expect(engine.undo()).toBe(7n);
    expect(projection().find((node) => node.id === groupId)?.transformModifiers).toEqual(vertical);
    expect(engine.undo()).toBe(8n);
    expect(projection().find((node) => node.id === groupId)?.transformModifiers).toEqual(horizontal);
    expect(engine.undo()).toBe(9n);
    expect(projection()).toEqual(confirmedExisting);
  });

  it("wraps a confirmed Vector Boolean in a Repeat TransformGroup", async () => {
    const wasm = await loadRuntime();
    const engine = new wasm.DocumentEngine();
    const square = (nodeId: string, x: number, size: number, position: number): CanvasNode => ({
      ...createNode("vector", x, x),
      id: nodeId,
      pageId: DEFAULT_PAGE_ID,
      positionId: positionId(position),
      width: size,
      height: size,
      vectorPath: { fillRule: "nonZero", subpaths: [{ closed: true, points: [
        { id: id(position * 10 + 1), x: 0, y: 0, pointType: "corner" },
        { id: id(position * 10 + 2), x: size, y: 0, pointType: "corner" },
        { id: id(position * 10 + 3), x: size, y: size, pointType: "corner" },
        { id: id(position * 10 + 4), x: 0, y: size, pointType: "corner" },
      ] }] },
    });
    const outer = square(id(501), 40, 80, 501);
    const cutout = square(id(502), 60, 40, 502);
    const booleanId = id(503);
    const createdBoolean = resolveCoreBatch([], [
      { type: "create", node: outer },
      { type: "create", node: cutout },
      { type: "boolean", ids: [outer.id, cutout.id], operation: "subtract", id: booleanId, pageId: DEFAULT_PAGE_ID, index: 0 },
    ]);
    expect(createdBoolean).toBeDefined();
    expect(engine.apply_transaction_json(id(504), 0n, JSON.stringify(createdBoolean!.batch))).toBe(1n);
    const projection = () => {
      const raw = JSON.parse(engine.snapshot_json()) as { nodes: Parameters<typeof canvasNodeFromWasmProjection>[0][] };
      return raw.nodes.map(canvasNodeFromWasmProjection) as CanvasNode[];
    };
    const groupId = id(505);
    const modifier = [{ type: "REPEAT" as const, repeatType: "LINEAR" as const, count: 1, unitType: "PIXELS" as const, offset: 300, axis: "HORIZONTAL" as const }];
    const grouped = resolveCoreBatch(projection(), [
      { type: "transformGroup", ids: [booleanId], id: groupId, pageId: DEFAULT_PAGE_ID, index: 0, modifiers: modifier },
    ]);
    expect(grouped).toBeDefined();
    expect(grouped?.batch.at(-1)).toMatchObject({ type: "reposition", positionIds: [{ id: groupId }] });
    expect(engine.apply_transaction_json(id(506), 1n, JSON.stringify(grouped!.batch))).toBe(2n);
    expect(projection().find((node) => node.id === groupId)).toMatchObject({ kind: "transformGroup", transformModifiers: modifier });
    expect(projection().find((node) => node.id === booleanId)?.parentId).toBe(groupId);
  });
});
