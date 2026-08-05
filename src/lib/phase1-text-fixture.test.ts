import fixture from "../../fixtures/documents/phase1-text-multilingual.fixture.json";
import { describe, expect, it } from "vitest";
import type { CanvasNode } from "./editor-protocol";
import { validatePhase1TextFixture } from "./phase1-text-fixture";

describe("F-TEXT-MULTILINGUAL", () => {
  it("covers mixed scripts without invalid UTF-8 style boundaries", () => {
    expect(fixture.name).toBe("F-TEXT-MULTILINGUAL");
    expect(validatePhase1TextFixture(fixture.nodes as CanvasNode[])).toEqual([]);
    const mixed = fixture.nodes.find((node) => node.name === "Mixed script styles");
    expect(mixed?.text).toContain("👩‍💻");
    expect(mixed?.textProperties?.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ start: 9, end: 19 }),
      expect.objectContaining({ start: 37, end: 48 }),
    ]));
  });

  it("rejects a byte range that would split a UTF-8 scalar", () => {
    const malformed = structuredClone(fixture.nodes) as CanvasNode[];
    const mixed = malformed.find((node) => node.name === "Mixed script styles");
    if (!mixed?.textProperties) throw new Error("fixture text properties are required");
    mixed.textProperties.runs[1].end = 10;
    mixed.textProperties.runs[2].start = 10;
    expect(validatePhase1TextFixture(malformed)).toEqual([
      `${mixed.id}: invalid UTF-8 style run 9-10`,
      `${mixed.id}: style runs do not cover source bytes`,
    ]);
  });
});
