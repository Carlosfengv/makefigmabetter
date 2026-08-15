import { describe, expect, it } from "vitest";
import { styledTextSpans, styledTextVisualSpans } from "./text-style-runs";

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

  it("projects a per-run canonical color without changing adjacent runs", () => {
    const text = "AB";
    const color = { space: "srgb" as const, components: [0.9, 0.1, 0.2] as [number, number, number], alpha: 1 };
    const spans = styledTextSpans(text, 0, 2, {
      runs: [
        { start: 0, end: 1, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0, color },
        { start: 1, end: 2, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 },
      ],
      paragraph: { alignment: "left", paragraphSpacing: 0 },
      autoSize: "fixed",
    });
    expect(spans[0].style.color).toEqual(color);
    expect(spans[1].style.color).toBeUndefined();
  });

  it("orders RTL style pieces physically while retaining their source ranges", () => {
    const text = "אבגד";
    const properties = {
      runs: [
        { start: 0, end: 4, fontSize: 14, fontWeight: 400, italic: false, letterSpacing: 0 },
        { start: 4, end: 8, fontSize: 22, fontWeight: 700, italic: false, letterSpacing: 0 },
      ],
      paragraph: { alignment: "right" as const, paragraphSpacing: 0 },
      autoSize: "fixed" as const,
    };

    expect(styledTextVisualSpans(text, 0, 8, properties, [{ start: 0, end: 8, direction: "rtl" }]).map((span) => [span.text, span.start, span.end, span.style.fontSize, span.direction])).toEqual([
      ["גד", 4, 8, 22, "rtl"],
      ["אב", 0, 4, 14, "rtl"],
    ]);
  });

  it("respects UAX #9 display order across mixed-direction runs", () => {
    const text = "AאבB";
    const properties = {
      runs: [
        { start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 },
        { start: 1, end: 5, fontSize: 18, fontWeight: 700, italic: false, letterSpacing: 0 },
        { start: 5, end: 6, fontSize: 14, fontWeight: 400, italic: true, letterSpacing: 0 },
      ],
      paragraph: { alignment: "left" as const, paragraphSpacing: 0 },
      autoSize: "fixed" as const,
    };

    expect(styledTextVisualSpans(text, 0, 6, properties, [
      { start: 0, end: 1, direction: "ltr" },
      { start: 1, end: 5, direction: "rtl" },
      { start: 5, end: 6, direction: "ltr" },
    ]).map((span) => [span.text, span.style.fontSize, span.direction])).toEqual([
      ["A", 12, "ltr"],
      ["אב", 18, "rtl"],
      ["B", 14, "ltr"],
    ]);
  });
});
