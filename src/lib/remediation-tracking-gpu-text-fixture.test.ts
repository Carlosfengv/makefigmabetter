import { describe, expect, it } from "vitest";
import { createRemediationTrackingGpuTextFixture } from "./remediation-tracking-gpu-text-fixture";
import { textFrozenLayoutPlan } from "./text-svg-layout-input";

describe("tracking GPU text fixture", () => {
  it("owns positive and negative PIXELS tracking without unsupported run paint", () => {
    const fixture = createRemediationTrackingGpuTextFixture();
    const text = fixture.nodes[0]!;
    const plan = textFrozenLayoutPlan(text);

    expect(plan?.runs.map((run) => [run.font.assetId, run.fontSize, run.letterSpacing])).toEqual([
      [fixture.assets[0]!.assetId, 24, 2],
      [fixture.assets[1]!.assetId, 48, -1],
    ]);
    expect(text.textProperties?.runs.every((run) => run.color === undefined && run.fillStack === undefined)).toBe(true);
  });
});
