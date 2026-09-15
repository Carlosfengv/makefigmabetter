import { describe, expect, it } from "vitest";
import { MAX_SUBTREE_COMPOSITE_NESTING, admitSubtreeCompositeSurfacePool } from "./subtree-composite-budget";

describe("subtree composite surface budget", () => {
  it("charges every active source and scratch surface", () => {
    expect(admitSubtreeCompositeSurfacePool(1920, 1080, 0)).toMatchObject({
      accepted: true,
      totalBytes: 1920 * 1080 * 4 * 3,
    });
    expect(admitSubtreeCompositeSurfacePool(1920, 1080, 1)).toMatchObject({
      accepted: true,
      totalBytes: 1920 * 1080 * 4 * 6,
    });
  });

  it("rejects excessive nesting and aggregate frame memory", () => {
    expect(admitSubtreeCompositeSurfacePool(1, 1, MAX_SUBTREE_COMPOSITE_NESTING)).toEqual({ accepted: false, reason: "nesting" });
    expect(admitSubtreeCompositeSurfacePool(4096, 4096, 1)).toMatchObject({ accepted: false, reason: "frameLimit" });
  });
});
