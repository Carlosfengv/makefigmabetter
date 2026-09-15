import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/documents/remediation-gpu-islands.fixture.json";
import type { CanvasNode } from "./editor-protocol";
import { gpuLayerIslands } from "./gpu-layer-prefix";
import { resolveCoreBatch } from "./transaction-batch";

const nodes = fixture.nodes as CanvasNode[];

describe("W13 ordered GPU/Canvas island fixture", () => {
  it("contains three GPU islands around an unsupported paint and one complete mask root", () => {
    expect(gpuLayerIslands(nodes, new Set(), new Set(), (node) => node.isMask ? "mask" : false).map((island) => ({
      backend: island.backend,
      reason: island.reason,
      backdrop: island.backdrop,
      names: island.nodes.map((node) => node.name),
    }))).toEqual([
      { backend: "gpu", reason: "initial-pass", backdrop: "transparent", names: ["Island background", "GPU red base"] },
      { backend: "canvas", reason: "unsupported-node", backdrop: "transparent", names: ["Canvas polygon middle"] },
      { backend: "gpu", reason: "resume-after-canvas", backdrop: "transparent", names: ["GPU green foreground"] },
      { backend: "canvas", reason: "mask", backdrop: "transparent", names: ["Canvas mask root", "Canvas ellipse mask", "Canvas masked target"] },
      { backend: "gpu", reason: "resume-after-canvas", backdrop: "transparent", names: ["GPU orange top"] },
    ]);
  });

  it("hydrates through the generated WASM Core used by the browser", async () => {
    const wasm = await import("../wasm/generated/editor_wasm");
    await wasm.default({ module_or_path: await readFile(new URL("../wasm/generated/editor_wasm_bg.wasm", import.meta.url)) });
    for (const node of nodes.filter((node) => !node.parentId && node.kind !== "group")) {
      const single = resolveCoreBatch([], [{ type: "create" as const, node }]);
      const probe = new wasm.DocumentEngine();
      try { probe.seed_batch_json(JSON.stringify(single!.batch)); }
      catch (error) { throw new Error(`${node.name}: ${String(error)}`); }
    }
    const batch = resolveCoreBatch([], nodes.map((node) => ({ type: "create" as const, node })));
    expect(batch).toBeDefined();
    const engine = new wasm.DocumentEngine();
    expect(() => engine.seed_batch_json(JSON.stringify(batch!.batch))).not.toThrow();
    expect(JSON.parse(engine.snapshot_json()).nodes).toHaveLength(nodes.length);
  });
});
