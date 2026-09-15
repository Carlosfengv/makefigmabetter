import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/documents/remediation-alpha-mask-run.fixture.json";
import { compileScene } from "../runtime/scene-compiler";
import { DEFAULT_PAGE_ID } from "./document-bootstrap";
import { createNode, type CanvasNode } from "./editor-protocol";
import { resolveCoreBatch } from "./transaction-batch";
import { canvasNodeFromWasmProjection } from "./wasm-projection-node";

const pageId = "00000000-0000-0000-0000-000000000001";
const nodes = fixture.nodes as CanvasNode[];
const effectMaskId = "00000000-0000-4000-8000-000000000309";
const effectTargetId = "00000000-0000-4000-8000-00000000030a";
const gradientMaskId = "00000000-0000-4000-8000-00000000030c";
const gradientTargetId = "00000000-0000-4000-8000-00000000030d";

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

describe("RF-05 rendered alpha-mask fixture", () => {
  it("contains an effect mask and a two-paint mask with an exact transparent center", () => {
    expect(nodes).toHaveLength(14);
    const effectMask = nodes.find((node) => node.id === effectMaskId)!;
    const gradientMask = nodes.find((node) => node.id === gradientMaskId)!;

    expect(effectMask.effectStack).toEqual([{ layerBlur: { radius: 8, visible: true } }]);
    expect(gradientMask.fillStack?.layers).toHaveLength(2);
    expect(gradientMask.fillStack?.layers.map((layer) => layer.paint?.gradient?.stops.map((stop) => [stop.position, stop.color.alpha]))).toEqual([
      [[0, 1], [0.42, 1], [0.46, 0], [1, 0]],
      [[0, 0], [0.54, 0], [0.58, 1], [1, 1]],
    ]);
  });

  it("compiles effect masks with conservative visual bounds and analytic masks with exact geometry", () => {
    const compiled = compileScene({ revision: 1, pageId, nodes });
    const effectTarget = compiled.scene.semanticNodes.find((node) => node.nodeId === effectTargetId)!;
    const gradientTarget = compiled.scene.semanticNodes.find((node) => node.nodeId === gradientTargetId)!;

    expect(effectTarget.clipState).toMatchObject({
      kind: "bounded",
      bounds: { left: -224, top: 86, right: -76, bottom: 164 },
      chain: [],
    });
    expect(gradientTarget.clipState).toMatchObject({
      kind: "bounded",
      chain: [expect.objectContaining({ nodeId: gradientMaskId, geometry: "rounded-rect" })],
    });
  });

  it("hydrates the versioned gradient stack through the same Core update used by the browser fixture", async () => {
    const wasm = await loadRuntime();
    const engine = new wasm.DocumentEngine();
    const initialNodes = nodes.map((node) => node.id === gradientMaskId ? { ...node, fillStack: undefined } : node);
    const seed = resolveCoreBatch([], initialNodes.map((node) => ({ type: "create" as const, node })));
    expect(seed).toBeDefined();
    engine.seed_batch_json(JSON.stringify(seed!.batch));
    const hydrated = (JSON.parse(engine.snapshot_json()) as { nodes: CanvasNode[] }).nodes;
    const update = resolveCoreBatch(hydrated, [{
      type: "update",
      id: gradientMaskId,
      patch: { fillStack: nodes.find((node) => node.id === gradientMaskId)!.fillStack },
    }]);
    expect(update).toBeDefined();
    expect(engine.apply_transaction_json(
      "00000000-0000-4000-8000-00000000030e",
      0n,
      JSON.stringify(update!.batch),
    )).toBe(1n);
    const restoredNodes = (JSON.parse(engine.snapshot_json()) as { nodes: Parameters<typeof canvasNodeFromWasmProjection>[0][] }).nodes.map(canvasNodeFromWasmProjection);
    const restored = restoredNodes.find((node) => node.id === gradientMaskId)?.fillStack;
    expect(restored?.layers.map((layer) => ({
      visible: layer.visible,
      opacity: layer.opacity,
      blendMode: layer.blendMode,
      gradient: layer.paint?.gradient,
    }))).toEqual(nodes.find((node) => node.id === gradientMaskId)!.fillStack!.layers.map((layer) => ({
      visible: layer.visible,
      opacity: layer.opacity,
      blendMode: layer.blendMode,
      gradient: layer.paint?.gradient,
    })));
  });

  it("admits a descendant-owning Group as a mask through the generated WASM reducer", async () => {
    const wasm = await loadRuntime();
    const engine = new wasm.DocumentEngine();
    const groupId = "00000000-0000-4000-8000-000000000401";
    const childId = "00000000-0000-4000-8000-000000000402";
    const targetId = "00000000-0000-4000-8000-000000000403";
    const group = { ...createNode("group", 40, 480), id: groupId, pageId: DEFAULT_PAGE_ID, positionId: `80000000000000000000000000000003:${groupId.replaceAll("-", "")}` };
    const child = { ...createNode("ellipse", 20, 20), id: childId, pageId: DEFAULT_PAGE_ID, parentId: groupId, positionId: `80000000000000000000000000000000:${childId.replaceAll("-", "")}` };
    const target = { ...createNode("rectangle", 40, 480), id: targetId, pageId: DEFAULT_PAGE_ID, positionId: `80000000000000000000000000000004:${targetId.replaceAll("-", "")}` };
    const created = resolveCoreBatch([], [group, child, target].map((node) => ({ type: "create" as const, node })));
    expect(created).toBeDefined();
    expect(engine.apply_transaction_json("00000000-0000-4000-8000-000000000404", 0n, JSON.stringify(created!.batch))).toBe(1n);
    const source = (JSON.parse(engine.snapshot_json()) as { nodes: CanvasNode[] }).nodes;
    const masked = resolveCoreBatch(source, [{ type: "setMask", id: groupId, enabled: true }]);
    expect(masked).toBeDefined();
    expect(engine.apply_transaction_json("00000000-0000-4000-8000-000000000405", 1n, JSON.stringify(masked!.batch))).toBe(2n);
    expect((JSON.parse(engine.snapshot_json()) as { nodes: CanvasNode[] }).nodes.find((node) => node.id === groupId)?.isMask).toBe(true);
  });

  it("admits a live Vector Boolean as a mask through the generated WASM reducer", async () => {
    const wasm = await loadRuntime();
    const engine = new wasm.DocumentEngine();
    const booleanId = "00000000-0000-4000-8000-000000000411";
    const outerId = "00000000-0000-4000-8000-000000000412";
    const cutoutId = "00000000-0000-4000-8000-000000000413";
    const targetId = "00000000-0000-4000-8000-000000000414";
    const boolean = { ...createNode("booleanOperation", 40, 800), id: booleanId, pageId: DEFAULT_PAGE_ID, booleanOperation: "subtract" as const, positionId: `80000000000000000000000000000005:${booleanId.replaceAll("-", "")}` };
    const outer = { ...createNode("vector", 0, 0), id: outerId, pageId: DEFAULT_PAGE_ID, parentId: booleanId, positionId: `80000000000000000000000000000000:${outerId.replaceAll("-", "")}` };
    const cutout = { ...createNode("vector", 20, 20), id: cutoutId, pageId: DEFAULT_PAGE_ID, parentId: booleanId, positionId: `80000000000000000000000000000001:${cutoutId.replaceAll("-", "")}` };
    const target = { ...createNode("rectangle", 40, 800), id: targetId, pageId: DEFAULT_PAGE_ID, positionId: `80000000000000000000000000000006:${targetId.replaceAll("-", "")}` };
    const created = resolveCoreBatch([], [boolean, outer, cutout, target].map((node) => ({ type: "create" as const, node })));
    expect(created).toBeDefined();
    expect(engine.apply_transaction_json("00000000-0000-4000-8000-000000000415", 0n, JSON.stringify(created!.batch))).toBe(1n);
    const source = (JSON.parse(engine.snapshot_json()) as { nodes: CanvasNode[] }).nodes;
    const masked = resolveCoreBatch(source, [{ type: "setMask", id: booleanId, enabled: true }]);
    expect(masked).toBeDefined();
    expect(engine.apply_transaction_json("00000000-0000-4000-8000-000000000416", 1n, JSON.stringify(masked!.batch))).toBe(2n);
    expect((JSON.parse(engine.snapshot_json()) as { nodes: CanvasNode[] }).nodes.find((node) => node.id === booleanId)?.isMask).toBe(true);
  });
});
