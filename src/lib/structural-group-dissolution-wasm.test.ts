import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_ID } from "./document-bootstrap";
import { createNode, type CanvasNode, type DocumentVectorPath } from "./editor-protocol";
import { resolveCoreBatch, resolveFlattenNodesBatch } from "./transaction-batch";
import { canvasNodeFromWasmProjection } from "./wasm-projection-node";

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
  const wasm = await loadRuntime();
  const engine = new wasm.DocumentEngine();
  const seed = resolveCoreBatch([], nestedNodes().map((node) => ({ type: "create" as const, node })))!;
  expect(engine.apply_transaction_json("00000000-0000-4000-8000-000000000710", 0n, JSON.stringify(seed.batch))).toBe(1n);
  const projection = () => {
    const snapshot = JSON.parse(engine.snapshot_json()) as { nodes: Parameters<typeof canvasNodeFromWasmProjection>[0][] };
    return snapshot.nodes.map(canvasNodeFromWasmProjection);
  };
  return { engine, projection };
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
});
