import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/documents/remediation-backdrop-islands.fixture.json";
import type { CanvasNode } from "./editor-protocol";
import { canMaterializeCanvasIsland, gpuLayerIslands } from "./gpu-layer-prefix";

describe("immutable backdrop island fixture", () => {
  it("keeps Background Blur and blend reads in bounded previous-islands runs", () => {
    const nodes = fixture.nodes as CanvasNode[];
    const islands = gpuLayerIslands(nodes, new Set());
    expect(islands.map((island) => ({
      backend: island.backend,
      reason: island.reason,
      backdrop: island.backdrop,
      ids: island.nodes.map((node) => node.id),
    }))).toEqual([
      { backend: "gpu", reason: "initial-pass", backdrop: "transparent", ids: [
        "00000000-0000-4000-8000-000000001301",
        "00000000-0000-4000-8000-000000001302",
      ] },
      { backend: "canvas", reason: "unsupported-node", backdrop: "previous-islands", ids: [
        "00000000-0000-4000-8000-000000001304",
      ] },
      { backend: "canvas", reason: "unsupported-node", backdrop: "previous-islands", ids: [
        "00000000-0000-4000-8000-000000001303",
      ] },
      { backend: "canvas", reason: "backdrop-chain", backdrop: "previous-islands", ids: [
        "00000000-0000-4000-8000-000000001306",
      ] },
      { backend: "gpu", reason: "resume-after-canvas", backdrop: "transparent", ids: [
        "00000000-0000-4000-8000-000000001305",
      ] },
    ]);
    expect(islands.filter((island) => island.backend === "canvas").map(canMaterializeCanvasIsland)).toEqual([true, false, false]);
  });
});
