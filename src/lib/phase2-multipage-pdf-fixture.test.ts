import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { planFigmaRestImport, resolveFigmaRestImportBatch } from "./figma-rest-import";
import { sortNodesByLayerOrder } from "./layer-order";

function ids() {
  let next = 1;
  return {
    allocateNodeId: () => `00000000-0000-4000-8000-${(next++).toString().padStart(12, "0")}`,
    allocatePageId: () => `00000000-0000-4000-8000-${(next++).toString().padStart(12, "0")}`,
  };
}

describe("F-PHASE2-FIGMA-REST-MULTIPAGE-PDF", () => {
  it("is a valid ordered Figma REST input with one self-contained alpha-mask page", async () => {
    const json = JSON.parse(await readFile(new URL("../../fixtures/documents/phase2-figma-rest-multipage-pdf.fixture.json", import.meta.url), "utf8"));
    const plan = planFigmaRestImport(json, ids());
    const batch = resolveFigmaRestImportBatch(plan);

    expect(plan.issues).toEqual([]);
    expect(plan.pages.map((page) => page.name)).toEqual(["Mask delivery page", "Matte delivery page"]);
    expect(plan.pageCommands.map((command) => command.positionId)).toEqual(plan.pages.map((page) => page.positionId));
    expect(batch?.batch.map((command) => command.type)).toEqual(["createPage", "createPage", "create", "create", "create", "create", "setMask"]);

    const mask = plan.nodes.find((node) => node.name === "Alpha source");
    const target = plan.nodes.find((node) => node.name === "Masked magenta target");
    expect(mask).toMatchObject({ isMask: true, pageId: plan.pages[0]?.id });
    expect(target).toMatchObject({
      pageId: plan.pages[0]?.id,
      opacity: 1,
      fillColor: expect.objectContaining({ alpha: .72 }),
    });
    expect(sortNodesByLayerOrder(plan.nodes.filter((node) => node.pageId === mask?.pageId))).toEqual([mask, target]);
  });
});
