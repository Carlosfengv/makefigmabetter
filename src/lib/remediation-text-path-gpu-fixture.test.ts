import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { textPathGeometry } from "./text-path-layout";
import { gpuLayerIslands } from "./gpu-layer-prefix";
import {
  createRemediationTextPathGpuFixture,
  createRemediationTextPathStructuredFixture,
  createRemediationTextPathTransformFixture,
} from "./remediation-text-path-gpu-fixture";
import { textFrozenLayoutPlan } from "./text-svg-layout-input";
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

describe("TextPath GPU browser fixture", () => {
  it("owns one authored cubic and two metric/paint runs on an embedded font", () => {
    const fixture = createRemediationTextPathGpuFixture();
    const node = fixture.nodes[0]!;
    const plan = textFrozenLayoutPlan(node);

    expect(node.kind).toBe("textPath");
    expect(textPathGeometry(node.vectorPath, node.textPathMetadata)?.length).toBeGreaterThan(node.width);
    expect(plan?.runs.map((run) => [run.font.assetId, run.fontSize, run.fontWeight, run.italic, run.letterSpacing])).toEqual([
      [fixture.assets[0]!.assetId, 28, 400, false, 1],
      [fixture.assets[0]!.assetId, 46, 700, true, -.5],
    ]);
    expect(node.textProperties?.runs.map((run) => run.color?.alpha)).toEqual([1, .9]);
  });

  it("preserves the shaped TextPath contract when Core duplicates the node", async () => {
    const fixture = createRemediationTextPathGpuFixture();
    const wasm = await loadRuntime();
    const engine = new wasm.DocumentEngine();
    engine.seed_assets_json(JSON.stringify(fixture.assets));
    const initial = resolveCoreBatch([], fixture.nodes.map((node) => ({ type: "create" as const, node })));
    expect(initial).toBeDefined();
    engine.seed_batch_json(JSON.stringify(initial!.batch));

    const source = (JSON.parse(engine.snapshot_json()) as { nodes: Parameters<typeof canvasNodeFromWasmProjection>[0][] })
      .nodes.map(canvasNodeFromWasmProjection);
    const copyId = "00000000-0000-4000-8000-0000000038c3";
    const duplicate = resolveCoreBatch(source, [{ type: "duplicate", ids: [source[0]!.id] }], () => copyId);
    expect(duplicate).toBeDefined();
    expect(engine.apply_transaction_json("00000000-0000-4000-8000-0000000038c4", 0n, JSON.stringify(duplicate!.batch))).toBe(1n);

    const copied = (JSON.parse(engine.snapshot_json()) as { nodes: Parameters<typeof canvasNodeFromWasmProjection>[0][] })
      .nodes.map(canvasNodeFromWasmProjection)
      .find((node) => node.id === copyId);
    expect(copied).toMatchObject({
      kind: "textPath",
      text: "Design",
      vectorPath: fixture.nodes[0]!.vectorPath,
      textPathMetadata: fixture.nodes[0]!.textPathMetadata,
      textProperties: fixture.nodes[0]!.textProperties,
    });
    expect(textFrozenLayoutPlan(copied!)).toBeDefined();
  });

  it("provides separate legacy-rotation and native-affine browser gates", () => {
    const fixture = createRemediationTextPathTransformFixture();
    expect(fixture.nodes).toHaveLength(2);
    expect(fixture.nodes[0]).toMatchObject({ kind: "textPath", rotation: 28 });
    expect(fixture.nodes[0]?.relativeTransform).toBeUndefined();
    expect(fixture.nodes[1]).toMatchObject({
      kind: "textPath",
      rotation: 0,
      relativeTransform: { a: .94, b: .22, c: .28, d: .88, e: 20, f: 80 },
    });
    expect(fixture.nodes.every((candidate) => textFrozenLayoutPlan(candidate))).toBe(true);
  });

  it("keeps clipped, masked and effected TextPaths in complete structural Canvas roots", () => {
    const fixture = createRemediationTextPathStructuredFixture();
    const textPaths = fixture.nodes.filter((node) => node.kind === "textPath");
    const parentByChild = new Map(
      textPaths.map((node) => [
        node.name,
        fixture.nodes.find((candidate) => candidate.id === node.parentId)?.name,
      ]),
    );
    expect(fixture.nodes).toHaveLength(11);
    expect(textPaths).toHaveLength(3);
    expect(textPaths.every((node) => textFrozenLayoutPlan(node))).toBe(true);
    expect(parentByChild).toEqual(new Map([
      ["Clipped shaped TextPath", "TextPath clipped frame"],
      ["Masked shaped TextPath", "TextPath mask run"],
      ["Effected shaped TextPath", "TextPath effect group"],
    ]));
    const pointIds = textPaths.flatMap((node) =>
      node.vectorPath?.subpaths.flatMap((subpath) =>
        subpath.points.map((point) => point.id),
      ) ?? [],
    );
    expect(new Set(pointIds).size).toBe(6);
    expect(resolveCoreBatch(
      [],
      fixture.nodes.map((node) => ({ type: "create" as const, node })),
    )).toBeDefined();

    const textPathIds = new Set(textPaths.map((node) => node.id));
    const islands = gpuLayerIslands(
      fixture.nodes,
      new Set(),
      textPathIds,
      (node) => {
        const parent = fixture.nodes.find((candidate) => candidate.id === node.parentId);
        if (node.isMask) return "mask";
        if (node.name === "TextPath effect group") return "subtree-composition";
        if (parent?.name === "TextPath clipped frame") return "frame-clip";
        return false;
      },
    );
    expect(islands.map((island) => ({
      backend: island.backend,
      reason: island.reason,
      nodes: island.nodes.map((node) => node.name),
    }))).toEqual([
      { backend: "gpu", reason: "initial-pass", nodes: ["Structured TextPath backdrop"] },
      { backend: "canvas", reason: "frame-clip", nodes: ["TextPath clipped frame", "Clipped shaped TextPath"] },
      { backend: "canvas", reason: "mask", nodes: ["TextPath mask run", "Mask panel", "TextPath ellipse mask", "Masked shaped TextPath"] },
      { backend: "canvas", reason: "subtree-composition", nodes: ["TextPath effect group", "Effect panel", "Effected shaped TextPath"] },
      { backend: "gpu", reason: "resume-after-canvas", nodes: ["GPU resume marker"] },
    ]);
  });
});
