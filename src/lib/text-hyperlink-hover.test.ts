import { describe, expect, it } from "vitest";
import { freshTextHyperlinkHoverTarget } from "./text-hyperlink-hover";

const target = { type: "URL" as const, value: "https://example.com" };
const hover = { revision: 7, pageId: "page-a", x: 20, y: 30, target };

describe("text hyperlink hover freshness", () => {
  it("accepts the same revision, page and adjacent pointer", () => {
    expect(freshTextHyperlinkHoverTarget(hover, { revision: 7, pageId: "page-a", x: 21, y: 31 })).toEqual(target);
  });

  it("rejects stale revision, page and pointer evidence", () => {
    expect(freshTextHyperlinkHoverTarget(hover, { revision: 8, pageId: "page-a", x: 20, y: 30 })).toBeUndefined();
    expect(freshTextHyperlinkHoverTarget(hover, { revision: 7, pageId: "page-b", x: 20, y: 30 })).toBeUndefined();
    expect(freshTextHyperlinkHoverTarget(hover, { revision: 7, pageId: "page-a", x: 23, y: 30 })).toBeUndefined();
  });

  it("fails closed for missing targets and invalid tolerances", () => {
    expect(freshTextHyperlinkHoverTarget({ ...hover, target: undefined }, { revision: 7, pageId: "page-a", x: 20, y: 30 })).toBeUndefined();
    expect(freshTextHyperlinkHoverTarget(hover, { revision: 7, pageId: "page-a", x: 20, y: 30 }, -1)).toBeUndefined();
  });
});
