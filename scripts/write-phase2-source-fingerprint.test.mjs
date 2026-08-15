import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { phase2SourceFingerprint } from "./write-phase2-source-fingerprint.mjs";

const directories = [];

afterEach(() => { directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })); });

describe("Phase 2 source fingerprint", () => {
  it("pins relevant source files while making missing inputs explicit", () => {
    const root = mkdtempSync(join(tmpdir(), "makefigma-source-fingerprint-"));
    directories.push(root);
    writeFileSync(join(root, "fixture.ts"), "fixture");
    const fingerprint = phase2SourceFingerprint({ root, paths: ["fixture.ts", "missing.ts"], capturedAt: "2026-08-10T00:00:00.000Z" });
    expect(fingerprint).toMatchObject({ format: "makefigma-phase2-source-fingerprint-v1", sourceFiles: [{ path: "fixture.ts", sha256: "f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d" }, { path: "missing.ts", missing: true }] });
  });
});
