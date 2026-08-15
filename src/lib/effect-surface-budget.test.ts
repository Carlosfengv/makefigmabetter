import { describe, expect, it } from "vitest";
import { MAX_EFFECT_SURFACE_BYTES, admitEffectSurfacePool } from "./effect-surface-budget";

describe("effect surface budget", () => {
  it("admits the two reusable RGBA8 surfaces required for ordered Drop Shadows", () => {
    expect(admitEffectSurfacePool(1920, 1080, 2)).toEqual({ accepted: true, bytesPerSurface: 1920 * 1080 * 4, totalBytes: 1920 * 1080 * 4 * 2 });
  });

  it("rejects invalid, per-surface and total-frame allocations before Canvas creation", () => {
    expect(admitEffectSurfacePool(0, 1, 2)).toEqual({ accepted: false, reason: "invalidDimensions" });
    const edge = Math.floor(Math.sqrt(MAX_EFFECT_SURFACE_BYTES / 4)) + 1;
    expect(admitEffectSurfacePool(edge, edge, 1)).toEqual({ accepted: false, reason: "surfaceLimit" });
    expect(admitEffectSurfacePool(4096, 4096, 5)).toEqual({ accepted: false, reason: "frameLimit" });
  });
});
