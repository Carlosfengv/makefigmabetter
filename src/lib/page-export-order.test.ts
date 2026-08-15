import { describe, expect, it } from "vitest";
import { pagesInCanonicalExportOrder } from "./page-export-order";

describe("page PDF export ordering", () => {
  it("uses Canonical page PositionId rather than the active or input order", () => {
    const pages = pagesInCanonicalExportOrder([
      { id: "page-c", name: "Last", positionId: "03:00" },
      { id: "page-a", name: "First", positionId: "01:00" },
      { id: "page-b", name: "Middle", positionId: "02:00" },
    ]);

    expect(pages.map((page) => page.name)).toEqual(["First", "Middle", "Last"]);
  });

  it("has a stable ID tie-break for malformed duplicate positions", () => {
    expect(pagesInCanonicalExportOrder([
      { id: "page-b", name: "B", positionId: "01:00" },
      { id: "page-a", name: "A", positionId: "01:00" },
    ]).map((page) => page.id)).toEqual(["page-a", "page-b"]);
  });
});
