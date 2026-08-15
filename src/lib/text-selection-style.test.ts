import { describe, expect, it } from "vitest";
import { textSelectionStyleSummary } from "./text-selection-style";

describe("text selection style summary", () => {
  const properties = { runs: [
    { start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 },
    { start: 1, end: 4, fontSize: 18, fontWeight: 700, italic: true, letterSpacing: 1 },
    { start: 4, end: 5, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 },
  ], paragraph: { alignment: "left" as const, paragraphSpacing: 0 }, autoSize: "fixed" as const, fallbackFonts: [] };

  it("recognizes a mixed UTF-8 selection while retaining DOM character count", () => {
    expect(textSelectionStyleSummary("A中B", properties, 0, 2)).toEqual({ characterCount: 2, mixed: true });
  });

  it("does not mark one Style Run as mixed", () => {
    expect(textSelectionStyleSummary("A中B", properties, 1, 2)).toEqual({ characterCount: 1, mixed: false });
  });
});
