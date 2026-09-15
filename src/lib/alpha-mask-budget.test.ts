import { describe, expect, it } from "vitest";
import { MAX_ALPHA_MASK_NESTING, MAX_ALPHA_MASK_SURFACE_BYTES, admitAlphaMaskSurface } from "./alpha-mask-budget";

describe("alpha mask surface budget", () => {
  it("allows two nested full-resolution alpha compositions within the surface cap", () => {
    expect(admitAlphaMaskSurface(1920, 1080, 0)).toEqual({ accepted: true, bytes: 1920 * 1080 * 4 * 2 });
    expect(admitAlphaMaskSurface(1920, 1080, MAX_ALPHA_MASK_NESTING - 1)).toEqual({ accepted: true, bytes: 1920 * 1080 * 4 * 2 });
  });

  it("rejects a third nested mask and an over-budget surface", () => {
    expect(admitAlphaMaskSurface(1, 1, MAX_ALPHA_MASK_NESTING)).toMatchObject({ accepted: false, reason: "nesting" });
    const edge = Math.floor(Math.sqrt(MAX_ALPHA_MASK_SURFACE_BYTES / 8));
    expect(admitAlphaMaskSurface(edge, edge, 0)).toMatchObject({ accepted: true, bytes: MAX_ALPHA_MASK_SURFACE_BYTES });
    expect(admitAlphaMaskSurface(edge + 1, edge + 1, 0)).toMatchObject({ accepted: false, reason: "surface" });
  });
});
