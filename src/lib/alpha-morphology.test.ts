import { describe, expect, it } from "vitest";
import { morphAlphaChannel } from "./alpha-morphology";

describe("morphAlphaChannel", () => {
  it("dilates and erodes with transparent exterior pixels", () => {
    const alpha = Uint8ClampedArray.from([0, 0, 0, 0, 255, 0, 0, 0, 0]);
    expect([...morphAlphaChannel(alpha, 3, 3, 1)]).toEqual([255, 255, 255, 255, 255, 255, 255, 255, 255]);
    expect([...morphAlphaChannel(Uint8ClampedArray.from(Array(9).fill(255)), 3, 3, -1)]).toEqual([0, 0, 0, 0, 255, 0, 0, 0, 0]);
  });

  it("keeps partial alpha and is a no-op at zero spread", () => {
    const alpha = Uint8ClampedArray.from([10, 20, 30, 40]);
    expect([...morphAlphaChannel(alpha, 2, 2, 0)]).toEqual([...alpha]);
    expect([...morphAlphaChannel(alpha, 2, 2, 1)]).toEqual([40, 40, 40, 40]);
  });
});
