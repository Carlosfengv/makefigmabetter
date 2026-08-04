import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { resetDocumentProjection } from "./document-reset";

describe("document reset projection", () => {
  it("creates an isolated baseline projection with its first starter selected", () => {
    const starter = [
      { ...createNode("rectangle", 12, 8), id: "00000000-0000-4000-8000-000000000001" },
      { ...createNode("text", 24, 16), id: "00000000-0000-4000-8000-000000000002" },
    ];
    const reset = resetDocumentProjection(starter);

    expect(reset).toMatchObject({ selectedIds: [starter[0].id], viewport: { x: 0, y: 0, zoom: 1 }, revision: 0, nodes: starter });
    reset.nodes[0].name = "changed after reset";
    expect(starter[0].name).toBe("Rectangle");
  });

  it("does not retain a selection when the starter set is empty", () => {
    expect(resetDocumentProjection([])).toEqual({ nodes: [], selectedIds: [], viewport: { x: 0, y: 0, zoom: 1 }, revision: 0 });
  });
});
