import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createNode, type CanvasNode, type DocumentAutoLayout } from "./editor-protocol";
import { encodeCoreBatchPayload } from "./protocol-operation-codec";
import { coalesceAdjacentNodeUpdates, resolveCoreBatch } from "./transaction-batch";
import { canvasNodeFromWasmProjection } from "./wasm-projection-node";

type WasmRuntime = typeof import("../wasm/generated/editor_wasm");

let runtime: Promise<WasmRuntime> | undefined;

async function loadRuntime() {
  if (!runtime) {
    runtime = import("../wasm/generated/editor_wasm").then(async (wasm) => {
      await wasm.default({ module_or_path: await readFile(new URL("../wasm/generated/editor_wasm_bg.wasm", import.meta.url)) });
      return wasm;
    });
  }
  return runtime;
}

const nodeId = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const positionId = (value: number) => `${value.toString(16).padStart(32, "0")}:00000000000000000000000000000000`;

const fixedLayout = (overrides: Partial<DocumentAutoLayout> = {}): DocumentAutoLayout => ({
  mode: "none",
  padding: [0, 0, 0, 0],
  itemSpacing: 0,
  wrap: false,
  primaryAlignment: "start",
  counterAlignment: "start",
  primarySizing: "fixed",
  counterSizing: "fixed",
  absolute: false,
  ...overrides,
});

function fixtureNodes(): { nodes: CanvasNode[]; targetId: string; movedId: string; constraintFrameId: string; textId: string } {
  const target = {
    ...createNode("frame", 40, 60),
    id: nodeId(1),
    name: "W12 horizontal wrap baseline",
    width: 240,
    height: 180,
    positionId: positionId(1),
    autoLayout: fixedLayout({
      mode: "horizontal",
      padding: [10, 10, 10, 10],
      itemSpacing: 10,
      trackSpacing: 18,
      trackAlignment: "spaceBetween",
      wrap: true,
      counterAlignment: "baseline",
    }),
  } satisfies CanvasNode;
  const source = {
    ...createNode("frame", 340, 60),
    id: nodeId(2),
    name: "W12 fill nested absolute",
    width: 400,
    height: 200,
    positionId: positionId(2),
    autoLayout: fixedLayout({
      mode: "horizontal",
      padding: [20, 20, 20, 20],
      itemSpacing: 12,
      counterAlignment: "baseline",
    }),
  } satisfies CanvasNode;
  const targetChildren = [30, 50, 40].map((height, index) => ({
    ...createNode("rectangle", 999, 999),
    id: nodeId(3 + index),
    name: `Wrap item ${index + 1}`,
    parentId: target.id,
    positionId: positionId(3 + index),
    width: 100,
    height,
    autoLayout: fixedLayout(),
  } satisfies CanvasNode));
  const nested = {
    ...createNode("frame", 0, 0),
    id: nodeId(6),
    name: "Nested hug frame",
    parentId: source.id,
    positionId: positionId(6),
    width: 100,
    height: 80,
    autoLayout: fixedLayout({
      mode: "vertical",
      padding: [10, 10, 10, 10],
      primarySizing: "hug",
      alignSelf: "start",
    }),
  } satisfies CanvasNode;
  const nestedChild = {
    ...createNode("rectangle", 0, 0),
    id: nodeId(7),
    name: "Nested child",
    parentId: nested.id,
    positionId: positionId(7),
    width: 80,
    height: 30,
    autoLayout: fixedLayout(),
  } satisfies CanvasNode;
  const moved = {
    ...createNode("rectangle", 0, 0),
    id: nodeId(8),
    name: "Bounded fill child",
    parentId: source.id,
    positionId: positionId(8),
    width: 50,
    height: 40,
    autoLayout: fixedLayout({ primarySizing: "fill", minWidth: 120, maxWidth: 180 }),
  } satisfies CanvasNode;
  const absolute = {
    ...createNode("rectangle", 700, 90),
    id: nodeId(9),
    name: "Absolute child",
    parentId: source.id,
    positionId: positionId(9),
    width: 24,
    height: 24,
    autoLayout: fixedLayout({ absolute: true }),
  } satisfies CanvasNode;
  const constraintFrame = {
    ...createNode("frame", 40, 300),
    id: nodeId(10),
    name: "W12 constraint resize frame",
    positionId: positionId(10),
    width: 200,
    height: 100,
  } satisfies CanvasNode;
  const constrained = {
    ...createNode("rectangle", 60, 320),
    id: nodeId(11),
    name: "Stretch and center child",
    parentId: constraintFrame.id,
    positionId: positionId(11),
    width: 100,
    height: 30,
    constraints: { horizontal: "stretch", vertical: "center" },
  } satisfies CanvasNode;
  const textFrame = {
    ...createNode("frame", 340, 300),
    id: nodeId(12),
    name: "W12 text hug frame",
    positionId: positionId(12),
    width: 160,
    height: 10,
    autoLayout: fixedLayout({ mode: "vertical", padding: [10, 10, 10, 10], primarySizing: "hug" }),
  } satisfies CanvasNode;
  const text = {
    ...createNode("text", 0, 0),
    id: nodeId(13),
    name: "Auto-sized text",
    parentId: textFrame.id,
    positionId: positionId(13),
    width: 140,
    height: 40,
    text: "Alpha\nBeta",
    textProperties: {
      runs: [{ start: 0, end: 10, fontSize: 31, fontWeight: 400, italic: false, letterSpacing: 0 }],
      paragraph: { alignment: "left", lineHeight: 20, paragraphSpacing: 0 },
      autoSize: "height",
    },
    autoLayout: fixedLayout(),
  } satisfies CanvasNode;

  return {
    nodes: [target, source, ...targetChildren, nested, nestedChild, moved, absolute, constraintFrame, constrained, textFrame, text],
    targetId: target.id,
    movedId: moved.id,
    constraintFrameId: constraintFrame.id,
    textId: text.id,
  };
}

describe("W12 generated WASM Auto Layout reparent", () => {
  it("preserves FILL and min/max constraints when reparenting into a wrapped Frame", async () => {
    const wasm = await loadRuntime();
    const engine = new wasm.DocumentEngine();
    const { nodes, targetId, movedId, constraintFrameId, textId } = fixtureNodes();
    const initial = resolveCoreBatch([], nodes.map((node) => ({ type: "create" as const, node })));
    expect(initial).toBeDefined();
    expect(engine.apply_transaction_json(nodeId(99), 0n, JSON.stringify(initial!.batch))).toBe(1n);

    const rawBefore = JSON.parse(engine.snapshot_json()) as { nodes: Parameters<typeof canvasNodeFromWasmProjection>[0][] };
    const before = { nodes: rawBefore.nodes.map(canvasNodeFromWasmProjection) };
    const movedBefore = before.nodes.find((node) => node.id === movedId);
    expect(movedBefore).toMatchObject({ parentId: nodeId(2), width: 180, height: 40 });
    expect(movedBefore?.autoLayout).toMatchObject({ trackSpacing: undefined, minHeight: undefined, maxHeight: undefined });

    const stretchedFill = {
      ...movedBefore!.autoLayout!,
      counterSizing: "fill" as const,
      minHeight: 40,
      maxHeight: 40,
    };
    const finalPositionId = "efffffffffffffffffffffffffffffff:00000000000000000000000000000007";
    const pageScopedCommands = coalesceAdjacentNodeUpdates([
      { type: "update", id: movedId, patch: { autoLayout: { ...movedBefore!.autoLayout!, minHeight: 40 } } },
      { type: "update", id: movedId, patch: { autoLayout: { ...movedBefore!.autoLayout!, minHeight: 40, maxHeight: 40 } } },
      { type: "update", id: movedId, patch: { autoLayout: stretchedFill } },
      { type: "reparent", ids: [movedId], parentId: targetId },
      { type: "reposition", positionIds: [{ id: movedId, positionId: finalPositionId }] },
      { type: "update", id: constraintFrameId, patch: { width: 300, height: 200 } },
      { type: "update", id: textId, patch: {
        text: "Alpha\nBeta\nGamma",
        height: 60,
        autoLayout: fixedLayout(),
        textProperties: {
          runs: [{ start: 0, end: 16, font: null as never, fontSize: 31, fontWeight: 400, italic: false, letterSpacing: 0, color: null as never }],
          paragraph: { alignment: "left", lineHeight: 20, paragraphSpacing: 0 },
          autoSize: "height",
          fallbackFonts: [],
          textTruncation: null,
          maxLines: null,
        },
      } },
    ]);
    expect(pageScopedCommands.map((command) => command.type)).toEqual(["update", "reparent", "reposition", "update", "update"]);
    const resolved = resolveCoreBatch(before.nodes, pageScopedCommands);
    expect(resolved).toBeDefined();
    expect(resolved!.batch.map((command) => command.type)).toEqual(["update", "reparent", "reposition", "update", "update"]);
    expect(() => encodeCoreBatchPayload(resolved!.batch)).not.toThrow();

    expect(engine.apply_transaction_json(nodeId(100), 1n, JSON.stringify(resolved!.batch))).toBe(2n);
    const after = JSON.parse(engine.snapshot_json()) as { nodes: CanvasNode[] };
    expect(after.nodes.find((node) => node.id === movedId)).toMatchObject({
      parentId: targetId,
      x: 50,
      y: 190,
      width: 180,
      height: 40,
      autoLayout: expect.objectContaining({ primarySizing: "fill", counterSizing: "fill", minWidth: 120, maxWidth: 180, minHeight: 40, maxHeight: 40 }),
    });
    expect(after.nodes.find((node) => node.id === constraintFrameId)).toMatchObject({ width: 300, height: 200 });
  });
});
