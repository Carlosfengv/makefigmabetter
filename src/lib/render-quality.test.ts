import { describe, expect, it } from "vitest";
import { renderDpr, resolveRenderQuality } from "./render-quality";

describe("dynamic render quality", () => {
  it("uses lower DPR only while interacting and restores native resolution", () => {
    const active = resolveRenderQuality({ tier: "settled", zoomBucket: "normal" }, .3, true);
    expect(active).toEqual({ tier: "interactive", zoomBucket: "far" });
    expect(renderDpr(2, active)).toBe(1.3);
    expect(renderDpr(2, resolveRenderQuality(active, .3, false))).toBe(2);
  });

  it("keeps zoom buckets stable around their hysteresis boundaries", () => {
    const far = resolveRenderQuality({ tier: "interactive", zoomBucket: "far" }, .5, true);
    expect(far.zoomBucket).toBe("far");
    expect(resolveRenderQuality(far, .59, true).zoomBucket).toBe("normal");
    const near = resolveRenderQuality({ tier: "interactive", zoomBucket: "near" }, 1, true);
    expect(near.zoomBucket).toBe("near");
    expect(renderDpr(2, near)).toBe(1.5);
  });
});
