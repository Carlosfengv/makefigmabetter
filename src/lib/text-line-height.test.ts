import { describe, expect, it } from "vitest";
import type { DocumentTextProperties } from "./editor-protocol";
import { resolvedTextLineHeight, resolvedTextLineHeightAt } from "./text-line-height";

function properties(
  lineHeight: number | undefined,
  lineHeightUnit?: "percent" | "auto",
): DocumentTextProperties {
  return {
    runs: [{ start: 0, end: 1, fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0 }],
    paragraph: { alignment: "left", lineHeight, lineHeightUnit, paragraphSpacing: 0 },
    autoSize: "fixed",
  };
}

describe("resolvedTextLineHeight", () => {
  it("preserves legacy pixels and resolves percent and auto deterministically", () => {
    expect(resolvedTextLineHeight(properties(24))).toBe(24);
    expect(resolvedTextLineHeight(properties(150, "percent"))).toBe(30);
    expect(resolvedTextLineHeight(properties(undefined, "auto"))).toBe(24);
  });

  it("uses the tallest run for the shared paragraph line box", () => {
    const value = properties(125, "percent");
    value.runs.push({ start: 1, end: 2, fontSize: 32, fontWeight: 400, italic: false, letterSpacing: 0 });
    expect(resolvedTextLineHeight(value)).toBe(40);
  });

  it("resolves PIXELS, PERCENT and AUTO overrides at paragraph boundaries", () => {
    const value = properties(24);
    value.paragraphStyleRuns = [
      { start: 0, lineHeight: 30 },
      { start: 2, lineHeight: 150, lineHeightUnit: "percent" },
      { start: 4, lineHeightUnit: "auto" },
    ];
    expect(resolvedTextLineHeightAt(value, 0)).toBe(30);
    expect(resolvedTextLineHeightAt(value, 2)).toBe(30);
    expect(resolvedTextLineHeightAt(value, 4)).toBe(24);
    expect(resolvedTextLineHeightAt(value, 6)).toBe(24);
  });
});
