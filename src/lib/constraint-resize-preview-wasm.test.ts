import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createNode, type CoreProjectionNode } from "./editor-protocol";
import { resolveCoreBatch } from "./transaction-batch";

type WasmRuntime = typeof import("../wasm/generated/editor_wasm");

let runtime: Promise<WasmRuntime> | undefined;

async function loadRuntime() {
  runtime ??= import("../wasm/generated/editor_wasm").then(async (wasm) => {
    await wasm.default({ module_or_path: await readFile(new URL("../wasm/generated/editor_wasm_bg.wasm", import.meta.url)) });
    return wasm;
  });
  return runtime;
}

describe("Core Frame resize preview", () => {
  it("is read-only and projects the same constrained child geometry as commit", async () => {
    const frame = {
      ...createNode("frame", 0, 0),
      id: "00000000-0000-4000-8000-000000001201",
      name: "Frame",
      width: 200,
      height: 100,
    };
    const child = {
      ...createNode("rectangle", 20, 10),
      id: "00000000-0000-4000-8000-000000001202",
      name: "Child",
      parentId: frame.id,
      width: 50,
      height: 20,
      constraints: { horizontal: "stretch" as const, vertical: "center" as const },
    };
    const created = resolveCoreBatch([], [frame, child].map((node) => ({ type: "create" as const, node })));
    const resize = resolveCoreBatch([frame, child], [{
      type: "update",
      id: frame.id,
      patch: { width: 300, height: 200 },
    }]);
    expect(created).toBeDefined();
    expect(resize).toBeDefined();

    const wasm = await loadRuntime();
    const engine = new wasm.DocumentEngine();
    engine.seed_batch_json(JSON.stringify(created!.batch));
    const before = engine.snapshot_json();
    const beforeHash = engine.canonical_hash();

    const preview = JSON.parse(engine.preview_resize_transaction_json(
      "00000000-0000-4000-8000-000000001211",
      JSON.stringify(resize!.batch),
    )) as CoreProjectionNode[];
    expect(engine.revision).toBe(0n);
    expect(engine.canonical_hash()).toBe(beforeHash);
    expect(engine.snapshot_json()).toBe(before);
    expect(preview).toHaveLength(2);
    expect(preview.find((node) => node.id === child.id)).toMatchObject({
      x: 20,
      y: 60,
      width: 150,
      height: 20,
    });

    const ignoredPreview = JSON.parse(engine.preview_resize_transaction_json(
      "00000000-0000-4000-8000-000000001213",
      JSON.stringify(resize!.batch.map((command) => command.type === "update"
        ? { ...command, ignoreConstraints: true }
        : command)),
    )) as CoreProjectionNode[];
    expect(ignoredPreview.map((node) => node.id)).toEqual([frame.id]);
    expect(engine.revision).toBe(0n);

    engine.apply_transaction_json(
      "00000000-0000-4000-8000-000000001212",
      engine.revision,
      JSON.stringify(resize!.batch),
    );
    const committed = JSON.parse(engine.snapshot_json()) as { nodes: CoreProjectionNode[] };
    expect(preview).toEqual(committed.nodes.filter((node) => preview.some((candidate) => candidate.id === node.id)));
  });
});
