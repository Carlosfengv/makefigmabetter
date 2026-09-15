import { describe, expect, it } from "vitest";
import { admitCompositeSurfaceAllocation, admitCompositeSurfaceBytes } from "./composite-surface-budget";

describe("combined Canvas composite surface budget", () => {
  it("charges effect, alpha-mask and subtree pools against one frame peak", () => {
    const bytesPerSurface = 1920 * 1080 * 4;
    expect(admitCompositeSurfaceAllocation(1920, 1080, 5, 3)).toEqual({
      accepted: true,
      bytesPerSurface,
      totalBytes: bytesPerSurface * 8,
    });
  });

  it("rejects pools that pass their local cap but exceed the combined frame cap", () => {
    // A 4K alpha pair is exactly 128 MiB and a three-surface effect pool is
    // 192 MiB. Each local gate accepts, while retaining both would use 320 MiB.
    expect(admitCompositeSurfaceAllocation(4096, 4096, 2, 3)).toEqual({
      accepted: false,
      reason: "frameLimit",
    });
  });
});

describe("variable composite surface bytes", () => {
  it("admits a local pool against existing full-canvas bytes", () => {
    expect(admitCompositeSurfaceBytes(180_000_000, 800, 600, 3)).toEqual({
      accepted: true,
      bytesPerSurface: 1_920_000,
      totalBytes: 185_760_000,
    });
  });

  it("rejects the combined frame peak", () => {
    expect(admitCompositeSurfaceBytes(250 * 1024 * 1024, 1024, 1024, 3)).toEqual({
      accepted: false,
      reason: "frameLimit",
    });
  });
});
