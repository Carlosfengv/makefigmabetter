import { describe, expect, it } from "vitest";
import { styledTextSpans } from "./text-style-runs";

describe("styled text spans", () => {
  it("splits Canonical UTF-8 runs without splitting an emoji", () => {
    const text = "A😀B";
    const properties = {
      runs: [
        { start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 },
        { start: 1, end: 5, fontSize: 20, fontWeight: 700, italic: true, letterSpacing: 1 },
        { start: 5, end: 6, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 },
      ],
      paragraph: { alignment: "left" as const, paragraphSpacing: 0 },
      autoSize: "fixed" as const,
    };

    expect(styledTextSpans(text, 0, 6, properties)).toEqual([
      expect.objectContaining({ text: "A", start: 0, end: 1, style: expect.objectContaining({ fontSize: 12 }) }),
      expect.objectContaining({ text: "😀", start: 1, end: 5, style: expect.objectContaining({ fontSize: 20, italic: true }) }),
      expect.objectContaining({ text: "B", start: 5, end: 6, style: expect.objectContaining({ fontSize: 12 }) }),
    ]);
  });

  it("uses the stable fallback only for an unstyled gap", () => {
    const text = "abc";
    expect(styledTextSpans(text, 0, 3, {
      runs: [{ start: 1, end: 2, fontSize: 16, fontWeight: 600, italic: false, letterSpacing: 0 }],
      paragraph: { alignment: "left", paragraphSpacing: 0 },
      autoSize: "fixed",
    }).map((span) => [span.text, span.style.fontSize])).toEqual([["a", 31], ["b", 16], ["c", 31]]);
  });
});
