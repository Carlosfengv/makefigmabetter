import { describe, expect, it } from "vitest";
import { admitRenderSurface } from "./render-surface-budget";

describe("render surface budget", () => {
  it("accounts for DPR before admitting an RGBA backing surface", () => {
    expect(admitRenderSurface(100, 50, 2, 100_000)).toEqual({ accepted: true, pixelWidth: 200, pixelHeight: 100, bytes: 80_000 });
  });

  it("rejects over-budget, non-finite and unsafe dimensions before allocation", () => {
    expect(admitRenderSurface(100, 100, 2, 100_000)).toEqual({ accepted: false, reason: "RESOURCE_LIMIT" });
    expect(admitRenderSurface(Number.POSITIVE_INFINITY, 100, 1)).toEqual({ accepted: false, reason: "INVALID_DIMENSIONS" });
    expect(admitRenderSurface(Number.MAX_SAFE_INTEGER, 2, 2)).toEqual({ accepted: false, reason: "RESOURCE_LIMIT" });
  });
});
