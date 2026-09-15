import { describe, expect, it } from "vitest";
import { planDirtyRegionReplay } from "./dirty-region-replay";

const viewport = { x: 0, y: 0, zoom: 1 };

describe("dirty region replay planning", () => {
  it("maps, pads, clips and merges world regions in screen space", () => {
    const plan = planDirtyRegionReplay({
      dirtyRegions: [
        { kind: "region", reason: "node-changed", bounds: { left: -50, top: -20, right: -10, bottom: 20 } },
        { kind: "region", reason: "node-added", bounds: { left: -12, top: -20, right: 20, bottom: 20 } },
      ],
      viewport,
      width: 200,
      height: 100,
      padding: 2,
    });

    expect(plan).toEqual({
      kind: "regions",
      coveredPixels: 3_256,
      rects: [{
        x: 48,
        y: 28,
        width: 74,
        height: 44,
        worldBounds: { left: -52, top: -22, right: 22, bottom: 22 },
      }],
    });
  });

  it("drops offscreen regions without forcing a repaint", () => {
    expect(planDirtyRegionReplay({
      dirtyRegions: [{ kind: "region", reason: "node-removed", bounds: { left: 500, top: 500, right: 520, bottom: 520 } }],
      viewport,
      width: 200,
      height: 100,
    })).toEqual({ kind: "none" });
  });

  it("falls back for semantic full-scene invalidation or excessive coverage", () => {
    expect(planDirtyRegionReplay({
      dirtyRegions: [{ kind: "full-scene", reason: "resource-changed" }],
      viewport,
      width: 200,
      height: 100,
    })).toEqual({ kind: "full-scene", reason: "resource-changed" });

    expect(planDirtyRegionReplay({
      dirtyRegions: [{ kind: "region", reason: "node-changed", bounds: { left: -90, top: -40, right: 90, bottom: 40 } }],
      viewport,
      width: 200,
      height: 100,
    })).toEqual({ kind: "full-scene", reason: "coverage-limit" });
  });

  it("converts padded clips back to world bounds at zoom", () => {
    const plan = planDirtyRegionReplay({
      dirtyRegions: [{ kind: "region", reason: "node-changed", bounds: { left: 10, top: 20, right: 30, bottom: 40 } }],
      viewport: { x: -5, y: 10, zoom: 2 },
      width: 300,
      height: 200,
      padding: 2,
    });

    expect(plan).toEqual({
      kind: "regions",
      coveredPixels: 1_848,
      rects: [{
        x: 158,
        y: 158,
        width: 44,
        height: 42,
        worldBounds: { left: 9, top: 19, right: 31, bottom: 40 },
      }],
    });
  });

  it("expands through overlapping visual bounds before clipping", () => {
    const plan = planDirtyRegionReplay({
      dirtyRegions: [{ kind: "region", reason: "node-changed", bounds: { left: -40, top: -10, right: -20, bottom: 10 } }],
      replayBounds: [
        { left: -30, top: -20, right: 20, bottom: 20 },
        { left: 15, top: -30, right: 60, bottom: 30 },
        { left: 80, top: -10, right: 90, bottom: 10 },
      ],
      viewport,
      width: 300,
      height: 200,
      padding: 0,
    });

    expect(plan).toEqual({
      kind: "regions",
      coveredPixels: 6_000,
      rects: [{
        x: 110,
        y: 70,
        width: 100,
        height: 60,
        worldBounds: { left: -40, top: -30, right: 60, bottom: 30 },
      }],
    });
  });
});
