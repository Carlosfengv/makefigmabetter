import { describe, expect, it } from "vitest";
import { mixedSelectionValue } from "./mixed-selection";

describe("mixed selection values", () => {
  it("keeps a shared value writable", () => {
    expect(mixedSelectionValue([.5, .5, .5])).toEqual({ kind: "same", value: .5 });
  });

  it("does not invent a value for divergent or empty selections", () => {
    expect(mixedSelectionValue([true, false])).toEqual({ kind: "mixed" });
    expect(mixedSelectionValue([])).toEqual({ kind: "mixed" });
  });
});
