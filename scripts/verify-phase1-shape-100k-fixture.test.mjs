import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { verifyPhase1Shape100kFixture } from "./verify-phase1-shape-100k-fixture.mjs";

describe("F-SHAPE-100K fixture verifier", () => {
  it("accepts the exact recipe and rejects manifest drift", () => {
    const root = mkdtempSync(join(tmpdir(), "makefigma-shape-fixture-"));
    mkdirSync(join(root, "fixtures/documents"), { recursive: true });
    mkdirSync(join(root, "verification"), { recursive: true });
    const fixture = JSON.stringify({ format: "makefigma-phase1-generated-fixture-v1", name: "F-SHAPE-100K", generator: "phase1-shape-100k-v1", seed: 1_507_138_393, nodeCount: 100_000, distribution: { rectangle: 80_000, ellipse: 10_000, text: 6_000, frame: 4_000 } });
    writeFileSync(join(root, "fixtures/documents/fixture.json"), fixture);
    writeFileSync(join(root, "verification/manifest.json"), JSON.stringify({ format: "makefigma-phase1-shape-100k-manifest-v1", fixture: "fixtures/documents/fixture.json", fixtureSha256: createHash("sha256").update(fixture).digest("hex"), fixtureName: "F-SHAPE-100K", generator: "phase1-shape-100k-v1", seed: 1_507_138_393, nodeCount: 100_000, distribution: { rectangle: 80_000, ellipse: 10_000, text: 6_000, frame: 4_000 } }));
    expect(verifyPhase1Shape100kFixture({ root, manifestPath: "verification/manifest.json" }).status).toBe("pass");
    writeFileSync(join(root, "verification/manifest.json"), "{}");
    expect(verifyPhase1Shape100kFixture({ root, manifestPath: "verification/manifest.json" }).reason).toBe("INVALID_MANIFEST");
  });
});
