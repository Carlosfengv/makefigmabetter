import { describe, expect, it } from "vitest";
import { createRemediationShapedCaretFixture } from "./remediation-shaped-caret-fixture";
import { textFrozenLayoutFace } from "./text-svg-layout-input";

describe("W12-T shaped caret fixture", () => {
  it("provides a fallback-free explicit-font caret evidence node", () => {
    const fixture = createRemediationShapedCaretFixture();
    const node = fixture.nodes[0]!;
    expect(fixture.assets).toEqual([
      expect.objectContaining({ mediaType: "font/ttf", bytesBase64: expect.any(String) }),
    ]);
    expect(node).toMatchObject({
      kind: "text",
      text: "Design",
      textProperties: {
        runs: [{ start: 0, end: 6, fontSize: 48, fontWeight: 400, letterSpacing: 0 }],
        paragraph: { alignment: "center", lineHeight: 60 },
      },
    });
    expect(textFrozenLayoutFace(node)?.font.assetId).toBe(fixture.assets[0]?.assetId);
  });
});
