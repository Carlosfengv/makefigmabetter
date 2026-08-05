import { describe, expect, it } from "vitest";
import { formatFontVariationAxes, parseFontVariationAxes } from "./font-variation-axes";

describe("font variation axis inspector syntax", () => {
  it("accepts and canonically orders multiple finite OpenType coordinates", () => {
    expect(parseFontVariationAxes("wdth=92, wght=650")).toEqual({
      valid: true,
      axes: [{ tag: "wdth", value: 92 }, { tag: "wght", value: 650 }],
    });
    expect(formatFontVariationAxes([{ tag: "wght", value: 650 }, { tag: "wdth", value: 92 }])).toBe("wdth=92, wght=650");
  });

  it("rejects ambiguous, duplicate, non-finite, and non-OpenType coordinates", () => {
    expect(parseFontVariationAxes("weight=650")).toMatchObject({ valid: false });
    expect(parseFontVariationAxes("wght=650,wght=700")).toMatchObject({ valid: false });
    expect(parseFontVariationAxes("wght=Infinity")).toMatchObject({ valid: false });
    expect(parseFontVariationAxes("wght:650")).toMatchObject({ valid: false });
  });
});
