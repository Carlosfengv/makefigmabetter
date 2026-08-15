import { describe, expect, it } from "vitest";
import { captureTextClipboard, decodeTextClipboard, encodeTextClipboard, pasteTextClipboard } from "./text-clipboard";

describe("versioned text clipboard", () => {
  const properties = { runs: [{ start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 }, { start: 1, end: 4, fontSize: 20, fontWeight: 700, italic: true, letterSpacing: 1 }], paragraph: { alignment: "left" as const, paragraphSpacing: 0 }, autoSize: "fixed" as const, fallbackFonts: [] };
  it("rebases UTF-8 Style Runs for a selected payload", () => {
    const payload = captureTextClipboard("A中", properties, 1, 2)!;
    expect(payload).toMatchObject({ text: "中", runs: [{ start: 0, end: 3, fontSize: 20, italic: true }] });
    expect(decodeTextClipboard(encodeTextClipboard(payload)!)).toEqual(payload);
  });
  it("rejects malformed or non-versioned browser data", () => {
    expect(decodeTextClipboard('{"format":"text/html"}')).toBeUndefined();
    expect(decodeTextClipboard(JSON.stringify({ format: "makefigma-text-clipboard-v1", schemaVersion: 1, text: "\ud83d", runs: [{ start: 0, end: 3, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 }] }))).toBeUndefined();
  });
  it("restores private Style Runs without changing surrounding styles", () => {
    const payload = captureTextClipboard("A中", properties, 1, 2)!;
    const pasted = pasteTextClipboard("xY", { ...properties, runs: [{ ...properties.runs[0], start: 0, end: 1 }, { ...properties.runs[1], start: 1, end: 2 }] }, 1, 2, payload)!;
    expect(pasted).toMatchObject({ text: "x中", properties: { runs: [{ start: 0, end: 1, fontSize: 12 }, { start: 1, end: 4, fontSize: 20, italic: true }] } });
  });
});
