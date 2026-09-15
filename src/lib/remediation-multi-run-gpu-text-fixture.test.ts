import { describe, expect, it } from "vitest";
import { textFrozenLayoutPlan } from "./text-svg-layout-input";
import { createRemediationMultiRunGpuTextFixture } from "./remediation-multi-run-gpu-text-fixture";

describe("multi-run GPU text fixture", () => {
  it("owns two immutable font resources and two raster scales without GPU-only paint semantics", () => {
    const fixture = createRemediationMultiRunGpuTextFixture();
    const text = fixture.nodes[0]!;
    const plan = textFrozenLayoutPlan(text);

    expect(fixture.assets).toHaveLength(2);
    expect(new Set(fixture.assets.map((asset) => asset.assetId)).size).toBe(2);
    expect(new Set(fixture.assets.map((asset) => asset.contentHash)).size).toBe(1);
    expect(plan?.runs.map((run) => [run.font.assetId, run.fontSize, run.letterSpacing])).toEqual([
      [fixture.assets[0]!.assetId, 24, 0],
      [fixture.assets[1]!.assetId, 48, 0],
    ]);
    expect(text.textProperties?.runs.every((run) => run.color === undefined && run.fillStack === undefined)).toBe(true);
  });
});
