import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/documents/remediation-text-truncation.fixture.json";

describe("W12-T text truncation fixture", () => {
  it("pairs an overflowing control with an ENDING maxLines case", () => {
    const [, control, ending] = fixture.nodes;
    expect(control).toMatchObject({ kind: "text", textProperties: { textTruncation: "disabled" } });
    expect(ending).toMatchObject({ kind: "text", textProperties: { textTruncation: "ending", maxLines: 2 } });
    expect(control.text).toBe(ending.text);
    expect(new Set(fixture.nodes.map((node) => node.id)).size).toBe(fixture.nodes.length);
  });
});
