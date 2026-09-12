import { describe, expect, it } from "vitest";
import { renderDpr, resolveRenderQuality, vectorPresentationTolerance } from "./render-quality";

describe("dynamic render quality", () => {
  it("uses lower DPR only while interacting and restores native resolution", () => {
    const active = resolveRenderQuality({ tier: "settled", zoomBucket: "normal" }, .3, true);
    expect(active).toEqual({ tier: "interactive", zoomBucket: "far" });
    expect(renderDpr(2, active)).toBe(1);
    expect(renderDpr(2, resolveRenderQuality(active, .3, false))).toBe(2);
  });

  it("keeps zoom buckets stable around their hysteresis boundaries", () => {
    const far = resolveRenderQuality({ tier: "interactive", zoomBucket: "far" }, .5, true);
    expect(far.zoomBucket).toBe("far");
    expect(resolveRenderQuality(far, .59, true).zoomBucket).toBe("normal");
    const near = resolveRenderQuality({ tier: "interactive", zoomBucket: "near" }, 1, true);
    expect(near.zoomBucket).toBe("near");
    expect(renderDpr(2, near)).toBe(1);
  });

  it("keeps Vector flattening below a quarter device pixel and buckets cache quality", () => {
    expect(vectorPresentationTolerance(.25, 2)).toBe(.25);
    expect(vectorPresentationTolerance(1, 2)).toBe(.125);
    expect(vectorPresentationTolerance(8, 2)).toBe(.015625);
    expect(vectorPresentationTolerance(32, 2)).toBe(.00390625);
    expect(vectorPresentationTolerance(10_000, 2)).toBe(.0025);
  });
});
