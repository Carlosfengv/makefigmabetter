import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { planFigmaRestImport, resolveFigmaRestImportBatch } from "./figma-rest-import";
import { exportPageToSvg } from "./svg-export";
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

function ids() {
  let next = 800;
  return {
    allocateNodeId: () => `00000000-0000-4000-8000-${(next++).toString().padStart(12, "0")}`,
    allocatePageId: () => `00000000-0000-4000-8000-${(next++).toString().padStart(12, "0")}`,
  };
}

describe("Figma REST Connector generated WASM boundary", () => {
  it("commits local endpoints, remapped identity, caps, text, and SVG through Core history", async () => {
    const plan = planFigmaRestImport({
      version: "connector-wasm",
      document: { children: [{ id: "0:1", type: "CANVAS", name: "Flow", children: [{
        id: "1:connector", type: "CONNECTOR", name: "Approval",
        relativeTransform: [[1, 0, 40], [0, 1, 50]],
        size: { x: 180, y: 80 }, absoluteBoundingBox: { x: 40, y: 50, width: 180, height: 80 },
        connectorLineType: "CURVED",
        connectorStart: { endpointNodeId: "1:target", position: { x: 40, y: 50 } },
        connectorEnd: { position: { x: 220, y: 130 } },
        connectorStartStrokeCap: "CIRCLE_FILLED",
        connectorEndStrokeCap: "TRIANGLE_ARROW",
        characters: "Approve",
        strokes: [{ type: "SOLID", color: { r: .15, g: .25, b: .6 } }],
        strokeWeight: 3,
      }, {
        id: "1:target", type: "RECTANGLE", name: "Target",
        relativeTransform: [[1, 0, 260], [0, 1, 90]],
        size: { x: 80, y: 60 }, absoluteBoundingBox: { x: 260, y: 90, width: 80, height: 60 },
      }] }] },
    }, ids());
    expect(plan.issues).toEqual([]);
    const transaction = resolveFigmaRestImportBatch(plan);
    expect(transaction).toBeDefined();

    const wasm = await loadRuntime();
    const engine = new wasm.DocumentEngine();
    expect(engine.apply_transaction_json("00000000-0000-4000-8000-000000000899", 0n, JSON.stringify(transaction!.batch))).toBe(1n);

    const projection = () => {
      const snapshot = JSON.parse(engine.snapshot_json()) as { nodes: Parameters<typeof canvasNodeFromWasmProjection>[0][] };
      return snapshot.nodes.map(canvasNodeFromWasmProjection);
    };
    const confirmed = projection();
    const connector = confirmed.find((node) => node.kind === "connector");
    const target = confirmed.find((node) => node.kind === "rectangle");
    expect(connector?.connectorMetadata).toEqual({
      lineType: "CURVED",
      start: { x: 0, y: 0, endpointNodeId: target?.id },
      end: { x: 180, y: 80 },
      startStrokeCap: "CIRCLE_FILLED",
      endStrokeCap: "ARROW_EQUILATERAL",
      text: "Approve",
    });

    const exported = exportPageToSvg(confirmed, {
      pageId: plan.pages[0]!.id,
      defaultPageId: plan.pages[0]!.id,
      sourceRevision: Number(engine.revision),
      padding: 0,
    });
    expect(exported.svg).toContain('d="M 0 0 C 90 0 90 80 180 80"');
    expect(exported.svg).toContain("Approve");

    expect(engine.undo()).toBe(2n);
    expect(projection()).toHaveLength(0);
    expect(engine.redo()).toBe(3n);
    expect(projection().find((node) => node.kind === "connector")?.connectorMetadata).toMatchObject({ lineType: "CURVED", text: "Approve" });
  });
});
