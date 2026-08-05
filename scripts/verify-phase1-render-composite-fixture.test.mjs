import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyPhase1RenderCompositeFixture } from "./verify-phase1-render-composite-fixture.mjs";

function writeFixture(root, mutate = (fixture) => fixture) {
  const fixturePath = "fixtures/render.json";
  mkdirSync(join(root, "fixtures"), { recursive: true });
  const fixture = mutate(JSON.parse(readFileSync("fixtures/documents/phase1-render-composite.fixture.json", "utf8")));
  const bytes = Buffer.from(JSON.stringify(fixture));
  writeFileSync(join(root, fixturePath), bytes);
  const manifestPath = "manifest.json";
  writeFileSync(join(root, manifestPath), JSON.stringify({
    format: "makefigma-phase1-render-composite-manifest-v1",
    fixture: fixturePath,
    fixtureName: "F-PHASE1-RENDER-COMPOSITE",
    fixtureSha256: createHash("sha256").update(bytes).digest("hex"),
  }));
  return manifestPath;
}

describe("F-PHASE1-RENDER-COMPOSITE fixture verifier", () => {
  it("accepts the bounded image, fixed scene composition and valid PNG header", () => {
    const root = mkdtempSync(join(tmpdir(), "makefigma-render-composite-"));
    expect(verifyPhase1RenderCompositeFixture({ root, manifestPath: writeFixture(root) })).toMatchObject({ status: "pass", nodeCount: 5, imageDimensions: { width: 24, height: 16 } });
  });

  it("rejects an image whose canonical dimensions disagree with its PNG", () => {
    const root = mkdtempSync(join(tmpdir(), "makefigma-render-composite-"));
    const manifestPath = writeFixture(root, (fixture) => ({ ...fixture, assets: [{ ...fixture.assets[0], pixelWidth: 25 }] }));
    expect(verifyPhase1RenderCompositeFixture({ root, manifestPath })).toMatchObject({ status: "fail", reason: "PNG_DIMENSION_MISMATCH" });
  });
});
