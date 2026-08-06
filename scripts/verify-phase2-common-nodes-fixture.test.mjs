import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyPhase2CommonNodesFixture } from "./verify-phase2-common-nodes-fixture.mjs";

const directories = [];

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "makefigma-phase2-fixture-"));
  directories.push(root);
  const manifestPath = join(root, "manifest.json");
  const fixturePath = join(root, "fixture.json");
  const sourceFixture = readFileSync(join(process.cwd(), "fixtures/documents/phase2-common-nodes.fixture.json"));
  writeFileSync(fixturePath, sourceFixture);
  writeFileSync(manifestPath, JSON.stringify({ format: "makefigma-phase2-common-nodes-manifest-v1", fixture: "fixture.json", fixtureName: "F-PHASE2-COMMON-NODES", fixtureSha256: "1aa99d33c43a0e5192b6304fbb96f7639303de7dd63b7b08b0bac6b89af92417" }));
  return { root, manifestPath, fixturePath };
}

afterEach(() => { directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })); });

describe("Phase 2 common-nodes fixture verifier", () => {
  it("freezes the exact hierarchy and specialized node cases", () => {
    const { root, manifestPath } = fixtureRoot();
    expect(verifyPhase2CommonNodesFixture({ root, manifestPath })).toMatchObject({ status: "pass", nodeCount: 9 });
  });

  it("reports a fixture change before an evidence capture can run", () => {
    const { root, manifestPath, fixturePath } = fixtureRoot();
    writeFileSync(fixturePath, "{}");
    expect(verifyPhase2CommonNodesFixture({ root, manifestPath })).toMatchObject({ status: "fail", reason: "FIXTURE_HASH_MISMATCH" });
  });
});
