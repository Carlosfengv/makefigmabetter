import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_ID } from "./document-bootstrap";
import { createNode, type CanvasNode } from "./editor-protocol";
import { resolveCoreBatch, resolveFlattenBooleanBatch } from "./transaction-batch";
import { canvasNodeFromWasmProjection } from "./wasm-projection-node";
import { transformPoint, worldTransformForNode } from "./scene-transform";

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
const positionId = (value: number) => `${(0x80000000000000000000000000000000n + BigInt(value - 201)).toString(16).padStart(32, "0")}:${id(value).replaceAll("-", "")}`;
function vector(value: number, x: number, points: readonly { x: number; y: number }[]): CanvasNode {
  return {
    ...createNode("vector", x, 40),
    id: id(value),
    pageId: DEFAULT_PAGE_ID,
    positionId: positionId(value),
    width: 160,
    height: 120,
    vectorPath: {
      fillRule: "nonZero",
      subpaths: [{ closed: true, points: points.map((point, index) => ({ id: id(value * 10 + index), ...point, pointType: "corner" as const })) }],
    },
  };
}

describe("W12 Runtime Boolean generated WASM transaction", () => {
  it("admits same-batch Vector creation and a forced-ID Boolean wrapper", async () => {
    const wasm = await loadRuntime();
    const engine = new wasm.DocumentEngine();
    const first = vector(201, 40, [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 120 }, { x: 0, y: 120 }]);
    const second = vector(202, 40, [{ x: 30, y: 30 }, { x: 90, y: 30 }, { x: 90, y: 90 }, { x: 30, y: 90 }]);
    const booleanId = id(203);
    const resolved = resolveCoreBatch([], [
      { type: "create", node: first },
      { type: "create", node: second },
      { type: "boolean", ids: [first.id, second.id], operation: "subtract", id: booleanId, pageId: DEFAULT_PAGE_ID, index: 0 },
      { type: "update", id: booleanId, patch: { name: "Runtime Boolean ring" } },
    ]);

    expect(resolved).toBeDefined();
    expect(() => engine.apply_transaction_json(id(204), 0n, JSON.stringify(resolved!.batch))).not.toThrow();
    const snapshot = JSON.parse(engine.snapshot_json()) as { nodes: CanvasNode[] };
    expect(snapshot.nodes.find((node) => node.id === booleanId)).toMatchObject({ kind: "booleanOperation", booleanOperation: "subtract" });
    expect(snapshot.nodes.filter((node) => node.parentId === booleanId)).toHaveLength(2);
  });

  it("commits a forced-ID empty Vector when Rust subtraction has no contours", async () => {
    const wasm = await loadRuntime();
    const engine = new wasm.DocumentEngine();
    const points = [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 120 }, { x: 0, y: 120 }];
    const first = vector(211, 40, points);
    const second = vector(212, 40, points);
    const booleanId = id(213);
    const wrapped = resolveCoreBatch([], [
      { type: "create", node: first },
      { type: "create", node: second },
      { type: "boolean", ids: [first.id, second.id], operation: "subtract", id: booleanId, pageId: DEFAULT_PAGE_ID, index: 0 },
    ]);
    expect(wrapped).toBeDefined();
    expect(engine.apply_transaction_json(id(214), 0n, JSON.stringify(wrapped!.batch))).toBe(1n);

    const operandPaths = [first.vectorPath, second.vectorPath];
    const rustPath = JSON.parse(wasm.boolean_vector_paths_json("subtract", JSON.stringify(operandPaths), .25)) as { subpaths: [] };
    expect(rustPath.subpaths).toEqual([]);
    const raw = JSON.parse(engine.snapshot_json()) as { nodes: Parameters<typeof canvasNodeFromWasmProjection>[0][] };
    const nodes = raw.nodes.map(canvasNodeFromWasmProjection);
    const flattened = resolveFlattenBooleanBatch(nodes, booleanId, rustPath, () => id(216), id(215));
    expect(flattened?.replacement.vectorPath?.subpaths).toEqual([]);
    expect(engine.apply_transaction_json(id(217), 1n, JSON.stringify(flattened!.batch))).toBe(2n);
    const final = JSON.parse(engine.snapshot_json()) as { nodes: Parameters<typeof canvasNodeFromWasmProjection>[0][] };
    expect(final.nodes.map(canvasNodeFromWasmProjection).find((node) => node.id === id(215))).toMatchObject({ kind: "vector", vectorPath: { subpaths: [] } });
  });

  it("atomically reparents same-page Vector operands from different Frames", async () => {
    const wasm = await loadRuntime();
    const engine = new wasm.DocumentEngine();
    const firstFrame = { ...createNode("frame", 100, 50), id: id(221), pageId: DEFAULT_PAGE_ID, positionId: positionId(221), width: 200, height: 180 };
    const secondFrame = { ...createNode("frame", 360, 80), id: id(222), pageId: DEFAULT_PAGE_ID, positionId: positionId(222), width: 200, height: 180 };
    const first = { ...vector(223, 20, [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 0, y: 40 }]), parentId: firstFrame.id, y: 30 };
    const firstSibling = { ...vector(224, 80, [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 0, y: 40 }]), parentId: firstFrame.id, y: 90 };
    const second = { ...vector(225, 10, [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 0, y: 40 }]), parentId: secondFrame.id, y: 20 };
    const secondSibling = { ...vector(226, 70, [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 0, y: 40 }]), parentId: secondFrame.id, y: 60 };
    const booleanId = id(227);
    const source = [firstFrame, secondFrame, first, firstSibling, second, secondSibling];
    const beforeOrigins = [first, second].map((node) => transformPoint(worldTransformForNode(source, node.id)!, { x: 0, y: 0 }));
    const resolved = resolveCoreBatch([], [
      ...source.map((node) => ({ type: "create" as const, node })),
      { type: "boolean", ids: [second.id, first.id], operation: "subtract" as const, id: booleanId, pageId: DEFAULT_PAGE_ID, index: 1 },
    ]);

    expect(resolved).toBeDefined();
    expect(engine.apply_transaction_json(id(228), 0n, JSON.stringify(resolved!.batch))).toBe(1n);
    const raw = JSON.parse(engine.snapshot_json()) as { nodes: Parameters<typeof canvasNodeFromWasmProjection>[0][] };
    const nodes = raw.nodes.map(canvasNodeFromWasmProjection);
    expect(nodes.filter((node) => node.parentId === booleanId).map((node) => node.id)).toEqual([first.id, second.id]);
    expect(nodes.filter((node) => node.parentId === firstFrame.id).map((node) => node.id)).toEqual([firstSibling.id]);
    expect(nodes.filter((node) => node.parentId === secondFrame.id).map((node) => node.id)).toEqual([secondSibling.id]);
    [first, second].forEach((node, index) => {
      const after = transformPoint(worldTransformForNode(nodes, node.id)!, { x: 0, y: 0 });
      expect(after.x).toBeCloseTo(beforeOrigins[index]!.x, 10);
      expect(after.y).toBeCloseTo(beforeOrigins[index]!.y, 10);
    });

    const booleanOrigin = transformPoint(worldTransformForNode(nodes, booleanId)!, { x: 0, y: 0 });
    const replacementId = id(229);
    let flattenSequence = 230;
    const flattened = resolveFlattenBooleanBatch(nodes, booleanId, {
      subpaths: [{ closed: true, points: [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 120 }] }],
    }, () => id(flattenSequence++), replacementId, { parentId: firstFrame.id, index: 0 });
    expect(flattened).toBeDefined();
    expect(engine.apply_transaction_json(id(239), 1n, JSON.stringify(flattened!.batch))).toBe(2n);
    const flattenedRaw = JSON.parse(engine.snapshot_json()) as { nodes: Parameters<typeof canvasNodeFromWasmProjection>[0][] };
    const flattenedNodes = flattenedRaw.nodes.map(canvasNodeFromWasmProjection);
    const replacement = flattenedNodes.find((node) => node.id === replacementId)!;
    expect(replacement.parentId).toBe(firstFrame.id);
    expect(flattenedNodes.filter((node) => node.parentId === firstFrame.id).map((node) => node.id)).toEqual([replacementId, firstSibling.id]);
    const replacementOrigin = transformPoint(worldTransformForNode(flattenedNodes, replacementId)!, { x: 0, y: 0 });
    expect(replacementOrigin.x).toBeCloseTo(booleanOrigin.x, 10);
    expect(replacementOrigin.y).toBeCloseTo(booleanOrigin.y, 10);
  });
});
