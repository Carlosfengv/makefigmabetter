import { describe, expect, it } from "vitest";
import { resolveCornerRadii } from "./corner-radii";

describe("corner radii", () => {
  it("retains the legacy uniform radius when no per-corner array exists", () => {
    expect(resolveCornerRadii(100, 80, 12)).toEqual([12, 12, 12, 12]);
  });

  it("normalizes all four corners together when a resize would make them overlap", () => {
    expect(resolveCornerRadii(100, 60, 0, [80, 80, 40, 40])).toEqual([40, 40, 20, 20]);
  });

  it("rejects malformed entries without changing the remaining corners", () => {
    expect(resolveCornerRadii(100, 100, 4, [12, Number.NaN, -1, 18])).toEqual([12, 0, 0, 18]);
  });
});
