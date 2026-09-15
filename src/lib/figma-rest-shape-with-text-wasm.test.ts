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
  let next = 700;
  return {
    allocateNodeId: () => `00000000-0000-4000-8000-${(next++).toString().padStart(12, "0")}`,
    allocatePageId: () => `00000000-0000-4000-8000-${(next++).toString().padStart(12, "0")}`,
  };
}

describe("Figma REST ShapeWithText generated WASM boundary", () => {
  it("commits the imported type, text, relative line height, wrap style, and SVG geometry through Core", async () => {
    const plan = planFigmaRestImport({
      version: "shape-with-text-wasm",
      document: { children: [{ id: "0:1", type: "CANVAS", name: "Diagram", children: [{
        id: "1:1",
        type: "SHAPE_WITH_TEXT",
        name: "Decision",
        shapeType: "HEXAGON",
        characters: "Approve",
        relativeTransform: [[1, 0, 24], [0, 1, 32]],
        absoluteBoundingBox: { x: 24, y: 32, width: 200, height: 120 },
        fills: [{ type: "SOLID", color: { r: .88, g: .91, b: 1 } }],
        strokes: [{ type: "SOLID", color: { r: .31, g: .27, b: .9 } }],
        strokeWeight: 2,
        style: {
          fontSize: 20,
          fontWeight: 600,
          italic: false,
          letterSpacing: 0,
          textAlignHorizontal: "CENTER",
          lineHeightUnit: "FONT_SIZE_%",
          lineHeightPercentFontSize: 150,
          lineHeightPx: 30,
          paragraphIndent: 14,
          textWrapStyle: "BALANCE",
        },
      }] }] },
    }, ids());
    const transaction = resolveFigmaRestImportBatch(plan);
    expect(transaction).toBeDefined();

    const wasm = await loadRuntime();
    const engine = new wasm.DocumentEngine();
    expect(engine.apply_transaction_json("00000000-0000-4000-8000-000000000799", 0n, JSON.stringify(transaction!.batch))).toBe(1n);

    const projection = () => {
      const snapshot = JSON.parse(engine.snapshot_json()) as { nodes: Parameters<typeof canvasNodeFromWasmProjection>[0][] };
      return snapshot.nodes.map(canvasNodeFromWasmProjection);
    };
    const confirmed = projection();
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({
      kind: "shapeWithText",
      shapeWithTextType: "HEXAGON",
      text: "Approve",
      textProperties: {
        runs: [{ start: 0, end: 7, fontSize: 20, fontWeight: 600 }],
        paragraph: { alignment: "center", lineHeight: 150, lineHeightUnit: "percent", paragraphIndent: 14, textWrapStyle: "balance" },
      },
    });

    const exported = exportPageToSvg(confirmed, {
      pageId: plan.pages[0]!.id,
      defaultPageId: plan.pages[0]!.id,
      sourceRevision: Number(engine.revision),
      padding: 0,
    });
    expect(exported.svg).toContain('d="M 36 0 L 164 0 L 200 60 L 164 120 L 36 120 L 0 60 Z"');
    expect(exported.svg).toContain("Approve");

    expect(engine.undo()).toBe(2n);
    expect(projection()).toHaveLength(0);
    expect(engine.redo()).toBe(3n);
    expect(projection()[0]).toMatchObject({ kind: "shapeWithText", shapeWithTextType: "HEXAGON", text: "Approve" });
  });
});
