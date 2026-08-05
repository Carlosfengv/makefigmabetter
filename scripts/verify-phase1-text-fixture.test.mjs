import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyPhase1TextFixture } from "./verify-phase1-text-fixture.mjs";

const directories = [];

function setup({ corrupt = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "makefigma-phase1-text-"));
  directories.push(root);
  const fixture = {
    format: "makefigma-phase1-fixture-v1",
    name: "F-TEXT-MULTILINGUAL",
    nodes: [
      { id: "one", name: "Mixed script styles", kind: "text", text: "A😀B", textProperties: { runs: [{ start: 0, end: corrupt ? 2 : 6 }] } },
      { id: "two", name: "RTL and Indic paragraphs", kind: "text", text: "مرحبا", textProperties: { runs: [] } },
      { id: "three", name: "Emoji and combining marks", kind: "text", text: "é", textProperties: { runs: [] } },
      { id: "four", name: "Ligature variable font axes", kind: "text", text: "office fi ffi", textProperties: { runs: [{ start: 0, end: 13, font: { variationAxes: [{ tag: "wdth", value: 92 }, { tag: "wght", value: 650 }] } }] } },
      { id: "five", name: "Fallback and missing glyph", kind: "text", text: "Fallback: 汉字 □", textProperties: { runs: [], fallbackFonts: [{ assetId: "fallback", faceIndex: 0 }] } },
    ],
  };
  const fixtureText = JSON.stringify(fixture);
  writeFileSync(join(root, "fixture.json"), fixtureText);
  const fixtureSha256 = createHash("sha256").update(fixtureText).digest("hex");
  writeFileSync(join(root, "manifest.json"), JSON.stringify({
    format: "makefigma-phase1-text-fixture-manifest-v1",
    fixture: "fixture.json",
    fixtureSha256,
    fixtureName: "F-TEXT-MULTILINGUAL",
    requiredNodeNames: ["Mixed script styles", "RTL and Indic paragraphs", "Emoji and combining marks", "Ligature variable font axes", "Fallback and missing glyph"],
  }));
  return { root, manifestPath: "manifest.json" };
}

afterEach(() => { directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })); });

describe("Phase 1 text fixture verifier", () => {
  it("accepts the immutable contract", () => {
    expect(verifyPhase1TextFixture(setup())).toMatchObject({ status: "pass", textNodeCount: 5 });
  });

  it("rejects a style range that cuts through an emoji", () => {
    expect(verifyPhase1TextFixture(setup({ corrupt: true }))).toMatchObject({ status: "fail", reason: "INVALID_UTF8_STYLE_RUN" });
  });
});
