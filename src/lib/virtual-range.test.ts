import { describe, expect, it } from "vitest";
import { reversedIndex, virtualRange } from "./virtual-range";

describe("virtual layer range", () => {
  it("calculates a bounded fixed-height range with overscan", () => {
    expect(virtualRange(100, 62, 93)).toEqual({ start: 0, end: 13 });
    expect(virtualRange(100, 31 * 95, 62)).toEqual({ start: 87, end: 100 });
  });

  it("reads the document in reverse without allocating a copy", () => {
    expect(reversedIndex(5, 0)).toBe(4);
    expect(reversedIndex(5, 4)).toBe(0);
  });
});
