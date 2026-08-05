import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyPhase1Text10kFixture } from "./verify-phase1-text-10k-fixture.mjs";

function writeFixture(root, text = "office ".repeat(1429).slice(0, 10_000)) {
  const fixturePath = "fixtures/fixture.json";
  mkdirSync(join(root, "fixtures"), { recursive: true });
  const fixture = JSON.stringify({
    format: "makefigma-phase1-fixture-v1",
    name: "F-TEXT-10K",
    nodes: [{ name: "F-TEXT-10K source", kind: "text", text, textProperties: { runs: [{ start: 0, end: new TextEncoder().encode(text).byteLength }] } }],
  });
  writeFileSync(join(root, fixturePath), fixture);
  const manifestPath = "manifest.json";
  writeFileSync(join(root, manifestPath), JSON.stringify({
    format: "makefigma-phase1-text-10k-manifest-v1",
    fixture: fixturePath,
    fixtureName: "F-TEXT-10K",
    fixtureSha256: createHash("sha256").update(fixture).digest("hex"),
  }));
  return manifestPath;
}

describe("F-TEXT-10K fixture verifier", () => {
  it("accepts the fixed 10K UTF-8 source and exact complete run", () => {
    const root = mkdtempSync(join(tmpdir(), "makefigma-text-10k-"));
    expect(verifyPhase1Text10kFixture({ root, manifestPath: writeFixture(root) })).toMatchObject({ status: "pass", textByteLength: 10_000 });
  });

  it("rejects a fixture whose accepted hash has a shorter source", () => {
    const root = mkdtempSync(join(tmpdir(), "makefigma-text-10k-"));
    expect(verifyPhase1Text10kFixture({ root, manifestPath: writeFixture(root, "short") })).toMatchObject({ status: "fail", reason: "INVALID_TEXT_LENGTH" });
  });
});
