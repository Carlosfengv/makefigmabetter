import { describe, expect, it } from "vitest";
import { fontsForRuntimeTextRange, patchRuntimeTextRange, replaceRuntimeTextRange, updateRuntimeText } from "./runtime-text";

describe("M2 Runtime text adapter", () => {
  const font = { assetId: "font-1", faceIndex: 0 };
  const properties = {
    runs: [
      { start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 },
      { start: 1, end: 8, font, fontSize: 14, fontWeight: 500, italic: false, letterSpacing: 0 },
    ],
    paragraph: { alignment: "left" as const, paragraphSpacing: 0 },
    autoSize: "fixed" as const,
  };

  it("converts UTF-16 public ranges to scalar-aligned UTF-8 style ranges", () => {
    const patched = patchRuntimeTextRange("A😀中", properties, 1, 3, { fontSize: 20 });
    expect(patched.runs).toEqual([
      { start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 },
      { start: 1, end: 5, font, fontSize: 20, fontWeight: 500, italic: false, letterSpacing: 0 },
      { start: 5, end: 8, font, fontSize: 14, fontWeight: 500, italic: false, letterSpacing: 0 },
    ]);
    expect(fontsForRuntimeTextRange("A😀中", properties, 1, 3)).toEqual([font]);
  });

  it("rebases complete style coverage when characters change", () => {
    const updated = updateRuntimeText("A😀中", "A界中", properties);
    expect(updated.characters).toBe("A界中");
    expect(updated.textProperties.runs).toEqual([
      { start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 },
      { start: 1, end: 7, font, fontSize: 14, fontWeight: 500, italic: false, letterSpacing: 0 },
    ]);
  });

  it("replaces UTF-16 text ranges without splitting a surrogate pair", () => {
    expect(replaceRuntimeTextRange("A😀中", 1, 3, "界")).toBe("A界中");
  });
});
