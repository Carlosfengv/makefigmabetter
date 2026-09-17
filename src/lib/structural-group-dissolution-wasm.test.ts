import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_ID } from "./document-bootstrap";
import { createNode, type CanvasNode, type DocumentVectorPath } from "./editor-protocol";
import { resolveCoreBatch, resolveFlattenNodesBatch } from "./transaction-batch";
import { canvasNodeFromWasmProjection } from "./wasm-projection-node";
import { worldTransformForNode } from "./scene-transform";

type WasmRuntime = typeof import("../wasm/generated/editor_wasm");

let runtime: Promise<WasmRuntime> | undefined;

async function loadRuntime(): Promise<WasmRuntime> {
  runtime ??= import("../wasm/generated/editor_wasm").then(async (wasm) => {
    await wasm.default({ module_or_path: await readFile(new URL("../wasm/generated/editor_wasm_bg.wasm", import.meta.url)) });
    return wasm;
  });
  return runtime;
}

const outerId = "00000000-0000-4000-8000-000000000701";
const innerId = "00000000-0000-4000-8000-000000000702";
const firstId = "00000000-0000-4000-8000-000000000703";
const secondId = "00000000-0000-4000-8000-000000000704";
const siblingId = "00000000-0000-4000-8000-000000000705";
const presentedFrameId = "00000000-0000-4000-8000-000000000706";

function nestedNodes(): CanvasNode[] {
  const outer = { ...createNode("group", 80, 40), id: outerId, pageId: DEFAULT_PAGE_ID, positionId: "10000000000000000000000000000000:00000000000040008000000000000701" };
  const inner = { ...createNode("group", 20, 10), id: innerId, pageId: DEFAULT_PAGE_ID, parentId: outer.id, positionId: "10000000000000000000000000000000:00000000000040008000000000000702" };
  const first = { ...createNode("vector", 10, 5), id: firstId, pageId: DEFAULT_PAGE_ID, parentId: inner.id, width: 20, height: 20, positionId: "10000000000000000000000000000000:00000000000040008000000000000703" };
  const second = { ...createNode("vector", 40, 5), id: secondId, pageId: DEFAULT_PAGE_ID, parentId: inner.id, width: 20, height: 20, positionId: "20000000000000000000000000000000:00000000000040008000000000000704" };
  const sibling = { ...createNode("vector", 240, 50), id: siblingId, pageId: DEFAULT_PAGE_ID, positionId: "f0000000000000000000000000000000:00000000000040008000000000000705" };
  return [outer, inner, first, second, sibling];
}

async function seededEngine(): Promise<{
  engine: InstanceType<WasmRuntime["DocumentEngine"]>;
  projection(): CanvasNode[];
}> {
  return seededEngineWith(nestedNodes(), "00000000-0000-4000-8000-000000000710");
}

async function seededEngineWith(nodes: CanvasNode[], transactionId: string): Promise<{
  engine: InstanceType<WasmRuntime["DocumentEngine"]>;
  projection(): CanvasNode[];
}> {
  const wasm = await loadRuntime();
  const engine = new wasm.DocumentEngine();
  const seed = resolveCoreBatch([], nodes.map((node) => ({ type: "create" as const, node })))!;
  expect(engine.apply_transaction_json(transactionId, 0n, JSON.stringify(seed.batch))).toBe(1n);
  const projection = () => {
    const snapshot = JSON.parse(engine.snapshot_json()) as { nodes: Parameters<typeof canvasNodeFromWasmProjection>[0][] };
    return snapshot.nodes.map(canvasNodeFromWasmProjection);
  };
  return { engine, projection };
}

function autoLayoutNodes(): CanvasNode[] {
  const ownerLayout = { mode: "horizontal" as const, padding: [8, 8, 8, 8] as [number, number, number, number], itemSpacing: 12, wrap: false, primaryAlignment: "start" as const, counterAlignment: "start" as const, primarySizing: "fixed" as const, counterSizing: "fixed" as const, absolute: false };
  const absoluteLayout = { ...ownerLayout, mode: "none" as const, padding: [0, 0, 0, 0] as [number, number, number, number], itemSpacing: 0, absolute: true };
  const frame = { ...createNode("frame", 100, 50), id: outerId, pageId: DEFAULT_PAGE_ID, width: 300, height: 160, autoLayout: ownerLayout, positionId: "10000000000000000000000000000000:00000000000040008000000000000701" };
  const first = { ...createNode("vector", 20, 30), id: firstId, pageId: DEFAULT_PAGE_ID, parentId: frame.id, width: 40, height: 20, autoLayout: absoluteLayout, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 20, f: 30 }, positionId: "10000000000000000000000000000000:00000000000040008000000000000703" };
  const second = { ...createNode("vector", 90, 50), id: secondId, pageId: DEFAULT_PAGE_ID, parentId: frame.id, width: 30, height: 20, autoLayout: absoluteLayout, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 90, f: 50 }, positionId: "20000000000000000000000000000000:00000000000040008000000000000704" };
  return [frame, first, second];
}

function flowLayoutNodes(): CanvasNode[] {
  const ownerLayout = { mode: "horizontal" as const, padding: [8, 8, 8, 8] as [number, number, number, number], itemSpacing: 12, wrap: false, primaryAlignment: "start" as const, counterAlignment: "start" as const, primarySizing: "fixed" as const, counterSizing: "fixed" as const, absolute: false };
  const flowLayout = { ...ownerLayout, mode: "none" as const, padding: [0, 0, 0, 0] as [number, number, number, number], itemSpacing: 0 };
  const frame = { ...createNode("frame", 100, 50), id: outerId, pageId: DEFAULT_PAGE_ID, width: 300, height: 160, autoLayout: ownerLayout, positionId: "10000000000000000000000000000000:00000000000040008000000000000701" };
  const first = { ...createNode("vector", 0, 0), id: firstId, pageId: DEFAULT_PAGE_ID, parentId: frame.id, width: 40, height: 20, autoLayout: flowLayout, positionId: "10000000000000000000000000000000:00000000000040008000000000000703" };
  const second = { ...createNode("vector", 0, 0), id: secondId, pageId: DEFAULT_PAGE_ID, parentId: frame.id, width: 30, height: 20, autoLayout: flowLayout, positionId: "20000000000000000000000000000000:00000000000040008000000000000704" };
  return [frame, first, second];
}

function presentedGroupNodes(): CanvasNode[] {
  const frame = { ...createNode("frame", 40, 20), id: presentedFrameId, pageId: DEFAULT_PAGE_ID, width: 360, height: 200, positionId: "08000000000000000000000000000000:00000000000040008000000000000706" };
  const group = {
    ...createNode("group", 80, 40),
    id: outerId,
    pageId: DEFAULT_PAGE_ID,
    parentId: frame.id,
    positionId: "10000000000000000000000000000000:00000000000040008000000000000701",
    opacity: .55,
    blendMode: "multiply" as const,
    isMask: true,
  };
  const first = { ...createNode("vector", 10, 5), id: firstId, pageId: DEFAULT_PAGE_ID, parentId: group.id, width: 20, height: 20, positionId: "10000000000000000000000000000000:00000000000040008000000000000703" };
  const second = { ...createNode("vector", 40, 5), id: secondId, pageId: DEFAULT_PAGE_ID, parentId: group.id, width: 20, height: 20, positionId: "20000000000000000000000000000000:00000000000040008000000000000704" };
  const sibling = { ...createNode("vector", 240, 50), id: siblingId, pageId: DEFAULT_PAGE_ID, parentId: frame.id, positionId: "f0000000000000000000000000000000:00000000000040008000000000000705" };
  return [frame, group, first, second, sibling];
}

describe("nested neutral Group Core dissolution", () => {
  it("recursively dissolves the consumed Group chain for Boolean creation", async () => {
    const { engine, projection } = await seededEngine();
    const booleanId = "00000000-0000-4000-8000-000000000711";
    const resolved = resolveCoreBatch(projection(), [{
      type: "boolean",
      ids: [firstId, secondId],
      operation: "union",
      id: booleanId,
      pageId: DEFAULT_PAGE_ID,
      index: 0,
    }])!;

    expect(engine.apply_transaction_json("00000000-0000-4000-8000-000000000712", 1n, JSON.stringify(resolved.batch))).toBe(2n);
    const confirmed = projection();
    expect(confirmed.some((node) => node.id === outerId || node.id === innerId)).toBe(false);
    expect(confirmed.find((node) => node.id === booleanId)).toMatchObject({ kind: "booleanOperation", parentId: undefined });
    expect(confirmed.filter((node) => node.parentId === booleanId).map((node) => node.id)).toEqual([firstId, secondId]);
  });

  it("recursively dissolves the consumed Group chain for multi-node flatten", async () => {
    const { engine, projection } = await seededEngine();
    const replacementId = "00000000-0000-4000-8000-000000000713";
    const vectorPath: DocumentVectorPath = {
      fillRule: "nonZero",
      subpaths: [{ closed: true, points: [
        { id: "00000000-0000-4000-8000-000000000721", x: 0, y: 0, pointType: "corner" },
        { id: "00000000-0000-4000-8000-000000000722", x: 50, y: 0, pointType: "corner" },
        { id: "00000000-0000-4000-8000-000000000723", x: 0, y: 20, pointType: "corner" },
      ] }],
    };
    const resolved = resolveFlattenNodesBatch(
      projection(),
      [firstId, secondId],
      vectorPath,
      () => replacementId,
      replacementId,
      { pageId: DEFAULT_PAGE_ID, index: 0 },
    )!;

    expect(engine.apply_transaction_json("00000000-0000-4000-8000-000000000714", 1n, JSON.stringify(resolved.batch))).toBe(2n);
    const confirmed = projection();
    expect(confirmed.some((node) => [outerId, innerId, firstId, secondId].includes(node.id))).toBe(false);
    expect(confirmed.find((node) => node.id === replacementId)).toMatchObject({ kind: "vector", parentId: undefined });
  });

  it("commits and restores absolute structural replacements inside Auto Layout", async () => {
    const booleanId = "00000000-0000-4000-8000-000000000731";
    const booleanSeed = await seededEngineWith(autoLayoutNodes(), "00000000-0000-4000-8000-000000000730");
    const boolean = resolveCoreBatch(booleanSeed.projection(), [{
      type: "boolean",
      ids: [firstId, secondId],
      operation: "union",
      id: booleanId,
      parentId: outerId,
      index: 0,
    }])!;

    expect(booleanSeed.engine.apply_transaction_json("00000000-0000-4000-8000-000000000732", 1n, JSON.stringify(boolean.batch))).toBe(2n);
    expect(booleanSeed.projection().find((node) => node.id === booleanId)).toMatchObject({
      kind: "booleanOperation",
      parentId: outerId,
      autoLayout: { mode: "none", absolute: true },
    });
    expect(booleanSeed.engine.undo()).toBe(3n);
    expect(booleanSeed.projection().filter((node) => node.parentId === outerId).map((node) => node.id)).toEqual([firstId, secondId]);
    expect(booleanSeed.engine.redo()).toBe(4n);
    expect(booleanSeed.projection().find((node) => node.id === booleanId)).toMatchObject({ parentId: outerId });

    const replacementId = "00000000-0000-4000-8000-000000000733";
    const flattenSeed = await seededEngineWith(autoLayoutNodes(), "00000000-0000-4000-8000-000000000734");
    const vectorPath: DocumentVectorPath = {
      fillRule: "nonZero",
      subpaths: [{ closed: true, points: [
        { id: "00000000-0000-4000-8000-000000000741", x: 0, y: 0, pointType: "corner" },
        { id: "00000000-0000-4000-8000-000000000742", x: 100, y: 0, pointType: "corner" },
        { id: "00000000-0000-4000-8000-000000000743", x: 0, y: 40, pointType: "corner" },
      ] }],
    };
    const flattened = resolveFlattenNodesBatch(
      flattenSeed.projection(),
      [firstId, secondId],
      vectorPath,
      () => replacementId,
      replacementId,
      { parentId: outerId, index: 0 },
    )!;

    expect(flattenSeed.engine.apply_transaction_json("00000000-0000-4000-8000-000000000735", 1n, JSON.stringify(flattened.batch))).toBe(2n);
    expect(flattenSeed.projection().find((node) => node.id === replacementId)).toMatchObject({
      kind: "vector",
      parentId: outerId,
      autoLayout: { mode: "none", absolute: true },
    });
    expect(flattenSeed.engine.undo()).toBe(3n);
    expect(flattenSeed.projection().filter((node) => node.parentId === outerId).map((node) => node.id)).toEqual([firstId, secondId]);
  });

  it("commits consumed Group presentation to Boolean and flatten replacements", async () => {
    const booleanId = "00000000-0000-4000-8000-000000000751";
    const booleanSeed = await seededEngineWith(presentedGroupNodes(), "00000000-0000-4000-8000-000000000750");
    const boolean = resolveCoreBatch(booleanSeed.projection(), [{
      type: "boolean",
      ids: [firstId, secondId],
      operation: "union",
      id: booleanId,
      parentId: presentedFrameId,
      index: 0,
    }])!;

    expect(booleanSeed.engine.apply_transaction_json("00000000-0000-4000-8000-000000000752", 1n, JSON.stringify(boolean.batch))).toBe(2n);
    expect(booleanSeed.projection().find((node) => node.id === booleanId)).toMatchObject({
      kind: "booleanOperation",
      opacity: .55,
      blendMode: "multiply",
      isMask: true,
    });
    expect(booleanSeed.projection().some((node) => node.id === outerId)).toBe(false);
    expect(booleanSeed.engine.undo()).toBe(3n);
    expect(booleanSeed.projection().find((node) => node.id === outerId)).toMatchObject({ isMask: true, opacity: .55, blendMode: "multiply" });
    expect(booleanSeed.engine.redo()).toBe(4n);
    expect(booleanSeed.projection().find((node) => node.id === booleanId)).toMatchObject({ isMask: true, opacity: .55 });

    const replacementId = "00000000-0000-4000-8000-000000000753";
    const flattenSeed = await seededEngineWith(presentedGroupNodes(), "00000000-0000-4000-8000-000000000754");
    const vectorPath: DocumentVectorPath = {
      fillRule: "nonZero",
      subpaths: [{ closed: true, points: [
        { id: "00000000-0000-4000-8000-000000000761", x: 0, y: 0, pointType: "corner" },
        { id: "00000000-0000-4000-8000-000000000762", x: 50, y: 0, pointType: "corner" },
        { id: "00000000-0000-4000-8000-000000000763", x: 0, y: 20, pointType: "corner" },
      ] }],
    };
    const flattened = resolveFlattenNodesBatch(
      flattenSeed.projection(),
      [firstId, secondId],
      vectorPath,
      () => replacementId,
      replacementId,
      { parentId: presentedFrameId, index: 0 },
    )!;

    expect(flattenSeed.engine.apply_transaction_json("00000000-0000-4000-8000-000000000755", 1n, JSON.stringify(flattened.batch))).toBe(2n);
    expect(flattenSeed.projection().find((node) => node.id === replacementId)).toMatchObject({
      kind: "vector",
      opacity: .55,
      blendMode: "multiply",
      isMask: true,
    });
    expect(flattenSeed.engine.undo()).toBe(3n);
    expect(flattenSeed.projection().find((node) => node.id === outerId)).toMatchObject({ isMask: true, opacity: .55 });
  });

  it("commits full fixed flow aggregation without moving its geometry", async () => {
    const booleanId = "00000000-0000-4000-8000-000000000771";
    const booleanSeed = await seededEngineWith(flowLayoutNodes(), "00000000-0000-4000-8000-000000000770");
    const beforeBoolean = [firstId, secondId].map((id) => worldTransformForNode(booleanSeed.projection(), id)!);
    const boolean = resolveCoreBatch(booleanSeed.projection(), [{
      type: "boolean",
      ids: [firstId, secondId],
      operation: "union",
      id: booleanId,
      parentId: outerId,
      index: 0,
    }])!;
    expect(booleanSeed.engine.apply_transaction_json("00000000-0000-4000-8000-000000000772", 1n, JSON.stringify(boolean.batch))).toBe(2n);
    const booleanProjection = booleanSeed.projection();
    expect(booleanProjection.find((node) => node.id === booleanId)).toMatchObject({
      parentId: outerId,
      width: 82,
      height: 20,
    });
    expect(booleanProjection.find((node) => node.id === booleanId)?.autoLayout?.absolute ?? false).toBe(false);
    [firstId, secondId].forEach((id, index) => expect(worldTransformForNode(booleanProjection, id)).toEqual(beforeBoolean[index]));
    expect(booleanSeed.engine.undo()).toBe(3n);
    expect(booleanSeed.projection().filter((node) => node.parentId === outerId).map((node) => node.id)).toEqual([firstId, secondId]);
    expect(booleanSeed.engine.redo()).toBe(4n);
    expect(booleanSeed.projection().find((node) => node.id === booleanId)?.autoLayout?.absolute ?? false).toBe(false);

    const replacementId = "00000000-0000-4000-8000-000000000773";
    const flattenSeed = await seededEngineWith(flowLayoutNodes(), "00000000-0000-4000-8000-000000000774");
    const beforeFlatten = worldTransformForNode(flattenSeed.projection(), firstId)!;
    const vectorPath: DocumentVectorPath = {
      fillRule: "nonZero",
      subpaths: [{ closed: true, points: [
        { id: "00000000-0000-4000-8000-000000000781", x: 0, y: 0, pointType: "corner" },
        { id: "00000000-0000-4000-8000-000000000782", x: 82, y: 0, pointType: "corner" },
        { id: "00000000-0000-4000-8000-000000000783", x: 0, y: 20, pointType: "corner" },
      ] }],
    };
    const flattened = resolveFlattenNodesBatch(
      flattenSeed.projection(),
      [firstId, secondId],
      vectorPath,
      () => replacementId,
      replacementId,
      { parentId: outerId, index: 0 },
    )!;

    expect(flattenSeed.engine.apply_transaction_json("00000000-0000-4000-8000-000000000775", 1n, JSON.stringify(flattened.batch))).toBe(2n);
    const flattenProjection = flattenSeed.projection();
    expect(flattenProjection.find((node) => node.id === replacementId)).toMatchObject({
      parentId: outerId,
      width: 82,
      height: 20,
    });
    expect(flattenProjection.find((node) => node.id === replacementId)?.autoLayout?.absolute ?? false).toBe(false);
    expect(worldTransformForNode(flattenProjection, replacementId)).toEqual(beforeFlatten);
    expect(flattenSeed.engine.undo()).toBe(3n);
    expect(flattenSeed.projection().filter((node) => node.parentId === outerId).map((node) => node.id)).toEqual([firstId, secondId]);
  });
});
