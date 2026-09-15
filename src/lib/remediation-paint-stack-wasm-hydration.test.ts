import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/documents/remediation-paint-stack.fixture.json";
import { createNode, type CanvasNode, type CoreProjectionNode, type DocumentAsset } from "./editor-protocol";
import { writeFigmaPluginNode } from "./figma-plugin-node-mutation";
import {
  cancelFigmaRestAssetBindings,
  pendingFigmaRestAssetRequests,
  planFigmaRestImport,
  resolveFigmaRestAssetBindings,
  resolveFigmaRestImportBatch,
} from "./figma-rest-import";
import { resolveCoreBatch } from "./transaction-batch";
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

describe("W09 Paint Stack WASM hydration", () => {
  it("hydrates image fill and stroke stacks only after their asset is registered", async () => {
    const wasm = await loadRuntime();
    const engine = new wasm.DocumentEngine();
    engine.seed_assets_json(JSON.stringify(fixture.assets satisfies Array<DocumentAsset & { bytesBase64: string }>));
    const nodes = structuredClone(fixture.nodes) as CanvasNode[];
    const resolved = resolveCoreBatch([], nodes.map((node) => ({ type: "create" as const, node })));
    expect(resolved).toBeDefined();
    engine.seed_batch_json(JSON.stringify(resolved!.batch));

    const hydrated = JSON.parse(engine.snapshot_json()) as { schemaVersion: number; nodes: CanvasNode[] };
    expect(hydrated.schemaVersion).toBe(32);
    expect(hydrated.nodes.find((node) => node.name === "Layered image fill")?.fillStack).toMatchObject(nodes[1]!.fillStack!);
    expect(hydrated.nodes.find((node) => node.name === "Image stroke endpoints")?.strokeStack).toMatchObject(nodes[2]!.strokeStack!);
  });
});

function importIds() {
  let next = 1;
  return {
    allocateNodeId: () => `00000000-0000-4000-8000-${(next++).toString().padStart(12, "0")}`,
    allocatePageId: () => `00000000-0000-4000-8000-${(next++).toString().padStart(12, "0")}`,
  };
}

describe("W02 empty Paint end-to-end", () => {
  it("keeps empty and hidden REST paints transparent through Core history, delayed image binding, and protobuf restore", async () => {
    const wasm = await loadRuntime();
    const engine = new wasm.DocumentEngine();
    const plan = planFigmaRestImport({
      version: "w02-empty-paint",
      document: { children: [{
        id: "0:1",
        type: "CANVAS",
        name: "W02",
        children: [{
          id: "1:1",
          type: "FRAME",
          name: "Explicit empty frame",
          relativeTransform: [[1, 0, 0], [0, 1, 0]],
          absoluteBoundingBox: { x: 0, y: 0, width: 120, height: 80 },
          fills: [],
          strokes: [],
        }, {
          id: "1:2",
          type: "RECTANGLE",
          name: "Hidden paint rectangle",
          relativeTransform: [[1, 0, 140], [0, 1, 0]],
          absoluteBoundingBox: { x: 140, y: 0, width: 120, height: 80 },
          fills: [{ type: "SOLID", visible: false, color: { r: 1, g: 0, b: 0, a: 1 } }],
          strokes: [{ type: "SOLID", visible: false, color: { r: 0, g: 0, b: 1, a: 1 } }],
        }, {
          id: "1:3",
          type: "RECTANGLE",
          name: "Linear gradient rectangle",
          relativeTransform: [[1, 0, 280], [0, 1, 0]],
          absoluteBoundingBox: { x: 280, y: 0, width: 120, height: 80 },
          fills: [{
            type: "GRADIENT_LINEAR",
            gradientHandlePositions: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
            gradientStops: [
              { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
              { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
            ],
          }],
          strokes: [],
        }, {
          id: "1:4",
          type: "RECTANGLE",
          name: "Pending image rectangle",
          relativeTransform: [[1, 0, 420], [0, 1, 0]],
          absoluteBoundingBox: { x: 420, y: 0, width: 120, height: 80 },
          fills: [{ type: "IMAGE", imageRef: "authorized-later", scaleMode: "FILL" }],
          strokes: [],
        }, {
          id: "1:5",
          type: "RECTANGLE",
          name: "Unsupported-only paint rectangle",
          relativeTransform: [[1, 0, 560], [0, 1, 0]],
          absoluteBoundingBox: { x: 560, y: 0, width: 120, height: 80 },
          fills: [{
            type: "GRADIENT_LINEAR",
            gradientHandlePositions: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
            gradientStops: [
              { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
              { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
            ],
          }],
          strokes: [],
        }, {
          id: "1:6",
          type: "RECTANGLE",
          name: "Mixed supported and unsupported paints",
          relativeTransform: [[1, 0, 700], [0, 1, 0]],
          absoluteBoundingBox: { x: 700, y: 0, width: 120, height: 80 },
          fills: [{ type: "SOLID", color: { r: 0, g: 1, b: 0, a: 1 } }, {
            type: "GRADIENT_LINEAR",
            gradientHandlePositions: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
            gradientStops: [
              { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
              { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
            ],
          }],
          strokes: [],
        }],
      }] },
    }, importIds());
    const initial = resolveFigmaRestImportBatch(plan);
    expect(initial).toBeDefined();
    expect(plan.assetRequests).toHaveLength(1);

    expect(engine.apply_transaction_json(
      "00000000-0000-4000-8000-000000000201",
      0n,
      JSON.stringify(initial!.batch),
    )).toBe(1n);
    const imported = JSON.parse(engine.snapshot_json()) as { nodes: CanvasNode[] };
    const empty = imported.nodes.find((node) => node.name === "Explicit empty frame");
    const hidden = imported.nodes.find((node) => node.name === "Hidden paint rectangle");
    const gradient = imported.nodes.find((node) => node.name === "Linear gradient rectangle");
    const pending = imported.nodes.find((node) => node.name === "Pending image rectangle");
    const unsupported = imported.nodes.find((node) => node.name === "Unsupported-only paint rectangle");
    const mixed = imported.nodes.find((node) => node.name === "Mixed supported and unsupported paints");
    expect(empty).toMatchObject({ fill: "#00000000", stroke: "#00000000" });
    expect(hidden).toMatchObject({ fill: "#00000000", stroke: "#00000000" });
    expect(gradient?.fillGradient?.stops).toHaveLength(2);
    expect(pending).toMatchObject({ fill: "#00000000", stroke: "#00000000" });
    expect(pending?.fillStack).toBeNull();
    expect(unsupported).toMatchObject({ fill: "#00000000", stroke: "#00000000" });
    expect(unsupported?.extensions?.["figma.rest.unsupported-paint.v1"]).toBeDefined();
    expect(mixed).toMatchObject({ fill: "#00ff00", stroke: "#00000000" });
    expect(mixed?.extensions?.["figma.rest.unsupported-paint.v1"]).toBeDefined();

    const asset: DocumentAsset = {
      assetId: "00000000-0000-4000-8000-000000000205",
      contentHash: "a".repeat(64),
      mediaType: "image/png",
      byteLength: 128,
      pixelWidth: 16,
      pixelHeight: 8,
    };
    const binding = resolveFigmaRestAssetBindings(plan.nodes, [], [{ request: plan.assetRequests[0]!, asset }]);
    expect(binding.issues).toEqual([]);
    expect(engine.apply_transaction_json(
      "00000000-0000-4000-8000-000000000202",
      1n,
      JSON.stringify(binding.batch),
    )).toBe(2n);
    const boundHash = engine.canonical_hash();
    const bound = JSON.parse(engine.snapshot_json()) as { nodes: CanvasNode[] };
    expect(bound.nodes.find((node) => node.name === "Pending image rectangle")?.fillStack)
      .toMatchObject(binding.nextNodes.find((node) => node.name === "Pending image rectangle")!.fillStack!);
    expect(pendingFigmaRestAssetRequests(bound.nodes)).toEqual([]);

    expect(engine.can_undo).toBe(true);
    expect(engine.undo()).toBe(3n);
    const undone = JSON.parse(engine.snapshot_json()) as { nodes: CanvasNode[] };
    expect(undone.nodes.find((node) => node.name === "Pending image rectangle")?.fillStack).toBeNull();
    expect(pendingFigmaRestAssetRequests(undone.nodes)).toEqual(plan.assetRequests);
    expect(engine.redo()).toBe(4n);
    expect(engine.canonical_hash()).toBe(boundHash);
    expect(pendingFigmaRestAssetRequests((JSON.parse(engine.snapshot_json()) as { nodes: CanvasNode[] }).nodes)).toEqual([]);

    const wire = engine.snapshot_protobuf();
    const restored = new wasm.DocumentEngine();
    expect(restored.load_snapshot_protobuf(wire)).toBe(4n);
    expect(restored.canonical_hash()).toBe(boundHash);
    const restoredNodes = (JSON.parse(restored.snapshot_json()) as { nodes: CanvasNode[] }).nodes;
    expect(restoredNodes.find((node) => node.name === "Explicit empty frame"))
      .toMatchObject({ fill: "#00000000", stroke: "#00000000" });
    expect(restoredNodes.find((node) => node.name === "Hidden paint rectangle"))
      .toMatchObject({ fill: "#00000000", stroke: "#00000000" });
    expect(restoredNodes.find((node) => node.name === "Pending image rectangle")?.fillStack)
      .toBeDefined();
    expect(restored.can_undo).toBe(false);

    expect(createNode("rectangle", 0, 0)).toMatchObject({ fill: "#e6edff", stroke: "#0048FF" });
    expect(createNode("frame", 0, 0)).toMatchObject({ fill: "#fbfbf8", stroke: "#d4d5cb" });
  });
});

describe("W10 Figma image cancellation history", () => {
  it("restores pending authorization on Undo and closes it again on Redo", async () => {
    const wasm = await loadRuntime();
    const engine = new wasm.DocumentEngine();
    const plan = planFigmaRestImport({
      version: "w10-image-cancellation",
      document: { children: [{
        id: "0:1",
        type: "CANVAS",
        children: [{
          id: "1:1",
          type: "IMAGE",
          locked: true,
          imageRef: "authorize-later",
          relativeTransform: [[1, 0, 0], [0, 1, 0]],
          absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 40 },
        }],
      }] },
    }, importIds());
    const imported = resolveFigmaRestImportBatch(plan);
    expect(imported).toBeDefined();
    engine.apply_transaction_json("00000000-0000-4000-8000-000000000301", 0n, JSON.stringify(imported!.batch));

    const importedNodes = (JSON.parse(engine.snapshot_json()) as { nodes: CanvasNode[] }).nodes;
    expect(pendingFigmaRestAssetRequests(importedNodes)).toEqual(plan.assetRequests);
    const cancellation = cancelFigmaRestAssetBindings(importedNodes, plan.assetRequests);
    engine.apply_transaction_json("00000000-0000-4000-8000-000000000302", 1n, JSON.stringify(cancellation.batch));
    const cancelledHash = engine.canonical_hash();
    expect(pendingFigmaRestAssetRequests((JSON.parse(engine.snapshot_json()) as { nodes: CanvasNode[] }).nodes)).toEqual([]);

    engine.undo();
    expect(pendingFigmaRestAssetRequests((JSON.parse(engine.snapshot_json()) as { nodes: CanvasNode[] }).nodes)).toEqual(plan.assetRequests);
    engine.redo();
    expect(engine.canonical_hash()).toBe(cancelledHash);
    expect(pendingFigmaRestAssetRequests((JSON.parse(engine.snapshot_json()) as { nodes: CanvasNode[] }).nodes)).toEqual([]);
  });
});

describe("W11 extension-backed node mutation history", () => {
  it("persists Component metadata through Core, Undo/Redo, and protobuf restore", async () => {
    const wasm = await loadRuntime();
    const engine = new wasm.DocumentEngine();
    const component: CanvasNode = {
      ...createNode("component", 0, 0),
      id: "00000000-0000-4000-8000-000000000401",
      name: "Card",
    };
    const created = resolveCoreBatch([], [{ type: "create", node: component }]);
    expect(created).toBeDefined();
    expect(engine.apply_transaction_json(
      "00000000-0000-4000-8000-000000000402",
      0n,
      JSON.stringify(created!.batch),
    )).toBe(1n);

    const before = snapshotCanvasNodes(engine)[0]!;
    expect(before.componentMetadata?.description).toBe("");
    const mutation = writeFigmaPluginNode(before, {
      description: "Reusable card",
      descriptionMarkdown: "**Reusable card**",
      documentationLinks: [{ uri: "https://design.example/card", name: "Card guide" }],
    });
    expect(mutation.ok).toBe(true);
    const resolved = resolveCoreBatch([before], mutation.ok ? mutation.commands : []);
    expect(resolved?.batch.map((command) => command.type)).toEqual(["setExtensions", "update"]);
    expect(engine.apply_transaction_json(
      "00000000-0000-4000-8000-000000000403",
      1n,
      JSON.stringify(resolved!.batch),
    )).toBe(2n);

    const updatedHash = engine.canonical_hash();
    expect(snapshotCanvasNodes(engine)[0]?.componentMetadata).toMatchObject({
      description: "Reusable card",
      descriptionMarkdown: "**Reusable card**",
      documentationLinks: [{ uri: "https://design.example/card", name: "Card guide" }],
    });
    expect(engine.undo()).toBe(3n);
    expect(snapshotCanvasNodes(engine)[0]?.componentMetadata?.description).toBe("");
    expect(engine.redo()).toBe(4n);
    expect(engine.canonical_hash()).toBe(updatedHash);

    const restored = new wasm.DocumentEngine();
    expect(restored.load_snapshot_protobuf(engine.snapshot_protobuf())).toBe(4n);
    expect(restored.canonical_hash()).toBe(updatedHash);
    expect(snapshotCanvasNodes(restored)[0]?.componentMetadata?.description).toBe("Reusable card");
  });
});

function snapshotCanvasNodes(engine: { snapshot_json(): string }): CanvasNode[] {
  const snapshot = JSON.parse(engine.snapshot_json()) as { nodes: CoreProjectionNode[] };
  return snapshot.nodes.map(canvasNodeFromWasmProjection);
}
