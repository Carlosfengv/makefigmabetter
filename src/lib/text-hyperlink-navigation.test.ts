import { describe, expect, it } from "vitest";
import { createNode, type DocumentTextProperties } from "./editor-protocol";
import { resolveTextHyperlinkNavigation, textHyperlinkAtUtf16Character } from "./text-hyperlink-navigation";

const properties: DocumentTextProperties = {
  autoSize: "fixed",
  textTruncation: "disabled",
  paragraph: { alignment: "left" },
  runs: [
    { start: 0, end: 1, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0, hyperlink: { type: "URL", value: "https://example.com/path" } },
    { start: 1, end: 5, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0, hyperlink: { type: "NODE", value: "target" } },
    { start: 5, end: 6, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 },
  ],
};

describe("text hyperlink navigation", () => {
  it("maps browser UTF-16 character positions to canonical UTF-8 style runs", () => {
    const text = "A😀B";
    expect(textHyperlinkAtUtf16Character(text, properties, 0)).toEqual({ type: "URL", value: "https://example.com/path" });
    expect(textHyperlinkAtUtf16Character(text, properties, 1)).toEqual({ type: "NODE", value: "target" });
    expect(textHyperlinkAtUtf16Character(text, properties, 2)).toBeUndefined();
    expect(textHyperlinkAtUtf16Character(text, properties, 3)).toBeUndefined();
    expect(textHyperlinkAtUtf16Character(text, properties, 4)).toBeUndefined();
  });

  it("allows only absolute HTTP(S) URLs to become executable navigation", () => {
    expect(resolveTextHyperlinkNavigation({ type: "URL", value: "https://example.com/a b" }, [], "page-1"))
      .toEqual({ type: "URL", url: "https://example.com/a%20b" });
    expect(resolveTextHyperlinkNavigation({ type: "URL", value: "javascript:alert(1)" }, [], "page-1")).toBeUndefined();
    expect(resolveTextHyperlinkNavigation({ type: "URL", value: "/relative" }, [], "page-1")).toBeUndefined();
  });

  it("resolves NODE targets only while they exist in the document", () => {
    const target = { ...createNode("rectangle", 0, 0), id: "target", pageId: "page-2" };
    expect(resolveTextHyperlinkNavigation({ type: "NODE", value: "target" }, [target], "page-1"))
      .toEqual({ type: "NODE", nodeId: "target", pageId: "page-2" });
    expect(resolveTextHyperlinkNavigation({ type: "NODE", value: "missing" }, [target], "page-1")).toBeUndefined();
  });
});
