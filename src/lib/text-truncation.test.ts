import { describe, expect, it } from "vitest";
import { endingEllipsis, textDisplayLines } from "./text-truncation";

const properties = {
  runs: [],
  paragraph: { alignment: "left" as const, lineHeight: 20, paragraphSpacing: 4 },
  autoSize: "fixed" as const,
  textTruncation: "ending" as const,
  maxLines: 2,
};

describe("text truncation", () => {
  it("marks the final visible frozen line when maxLines hides later content", () => {
    const source = "one\ntwo\nthree";
    const lines = [
      { start: 0, end: 3, text: "one" },
      { start: 4, end: 7, text: "two" },
      { start: 8, end: 13, text: "three" },
    ];
    expect(textDisplayLines(source, lines, properties, 100, 20, 4)).toEqual([
      { ...lines[0], lineTop: 0, lineHeight: 20, truncateEnding: false },
      { ...lines[1], lineTop: 24, lineHeight: 20, truncateEnding: true },
    ]);
  });

  it("also truncates at fixed box height and fits the ellipsis on scalar boundaries", () => {
    const lines = [{ start: 0, end: 6, text: "a😀b" }, { start: 6, end: 7, text: "c" }];
    expect(textDisplayLines("a😀bc", lines, { ...properties, maxLines: undefined }, 20, 20, 0)[0]?.truncateEnding).toBe(true);
    expect(endingEllipsis("a😀b", 3, (value) => Array.from(value).length)).toEqual({ text: "a😀…", retainedUtf8Bytes: 5 });
  });

  it("can measure presentation-expanded candidates while retaining Canonical source offsets", () => {
    expect(endingEllipsis(
      "aßb",
      3,
      (value) => Array.from(value).length,
      (retained) => Array.from(`${retained.toLocaleUpperCase("und")}…`).length,
    )).toEqual({ text: "a…", retainedUtf8Bytes: 1 });
  });

  it("leaves all lines unchanged when truncation is disabled", () => {
    const lines = [{ start: 0, end: 1, text: "a" }, { start: 2, end: 3, text: "b" }];
    expect(textDisplayLines("a\nb", lines, { ...properties, textTruncation: "disabled", maxLines: undefined }, 1, 20, 0)).toHaveLength(2);
  });

  it("resolves paragraph spacing from the adjacent authored paragraphs", () => {
    const source = "one\ntwo\nthree";
    const lines = [
      { start: 0, end: 3, text: "one" },
      { start: 4, end: 7, text: "two" },
      { start: 8, end: 13, text: "three" },
    ];
    const pairs: Array<[number, number]> = [];
    expect(textDisplayLines(source, lines, { ...properties, maxLines: 3 }, 100, 20, (previous, next) => {
      pairs.push([previous, next]);
      return next === 4 ? 3 : 7;
    }).map((line) => line.lineTop)).toEqual([0, 23, 50]);
    expect(pairs).toEqual([[0, 4], [4, 8]]);
  });

  it("advances soft-wrapped lines with their authored paragraph line height", () => {
    const source = "one two\nthree";
    const lines = [
      { start: 0, end: 3, text: "one" },
      { start: 4, end: 7, text: "two" },
      { start: 8, end: 13, text: "three" },
    ];
    expect(textDisplayLines(source, lines, { ...properties, maxLines: 3 }, 100, (start) => start === 0 ? 12 : 30, 4)
      .map(({ lineTop, lineHeight }) => ({ lineTop, lineHeight })))
      .toEqual([
        { lineTop: 0, lineHeight: 12 },
        { lineTop: 12, lineHeight: 12 },
        { lineTop: 28, lineHeight: 30 },
      ]);
  });
});
