import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  completionRecordIntegrityViolations,
  completionRecordViolations,
  remediationEvidenceViolations,
} from "./remediation-evidence.mjs";

const valid = {
  completionRecordVersion: 1,
  gate: "fixture",
  capturedAt: "2026-09-13",
  sourceCommit: "a".repeat(40),
  workspaceDiff: { status: "dirty", paths: ["src/fixture.ts"] },
  environment: { browser: "Chromium", device: "Test device" },
  commands: ["pnpm test"],
  result: "passed",
  artifacts: { fixture: { path: "fixture.json", sha256: "b".repeat(64) } },
  sourceSha256: { "src/fixture.ts": "c".repeat(64) },
  knownPartial: [],
  fallback: ["Reject unsupported input."],
  schema: { semanticsVersion: 1, localSnapshotVersion: 1, versionChange: "none" },
};

test("ignores raw artifacts that are not completion records", () => {
  assert.deepEqual(completionRecordViolations({ result: "passed" }), []);
});

test("accepts a complete versioned record", () => {
  assert.deepEqual(completionRecordViolations(valid), []);
});

test("rejects an incomplete versioned record", () => {
  const violations = completionRecordViolations({ completionRecordVersion: 1 }, "fixture.json");
  assert.ok(violations.some((message) => message.includes("sourceCommit")));
  assert.ok(violations.some((message) => message.includes("commands")));
  assert.ok(violations.some((message) => message.includes("fallback")));
});

test("verifies declared source and fixture content hashes", () => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "makefigma-evidence-"));
  try {
    writeFileSync(join(repositoryRoot, "source.ts"), "export const value = 1;\n");
    writeFileSync(join(repositoryRoot, "fixture.json"), "{}\n");
    const sourceHash = createHash("sha256").update("export const value = 1;\n").digest("hex");
    const fixtureHash = createHash("sha256").update("{}\n").digest("hex");
    const record = {
      ...valid,
      artifacts: { fixture: { path: "fixture.json", sha256: fixtureHash } },
      sourceSha256: { "source.ts": sourceHash },
    };
    assert.deepEqual(completionRecordIntegrityViolations(record, "record.json", repositoryRoot), []);
    writeFileSync(join(repositoryRoot, "source.ts"), "export const value = 2;\n");
    assert.ok(completionRecordIntegrityViolations(record, "record.json", repositoryRoot).some((message) => message.includes("source.ts") && message.includes("mismatch")));
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("rejects missing files and paths outside the repository", () => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "makefigma-evidence-"));
  try {
    const record = {
      ...valid,
      artifacts: { fixture: { path: "missing.json", sha256: "b".repeat(64) } },
      sourceSha256: { "../outside.ts": "c".repeat(64) },
    };
    const violations = completionRecordIntegrityViolations(record, "record.json", repositoryRoot);
    assert.ok(violations.some((message) => message.includes("inside the repository")));
    assert.ok(violations.some((message) => message.includes("does not exist")));
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("validates completion records in nested dated directories", () => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "makefigma-evidence-"));
  try {
    const evidenceDirectory = join(repositoryRoot, "verification", "remediation");
    const datedDirectory = join(evidenceDirectory, "2026-09-14");
    mkdirSync(datedDirectory, { recursive: true });
    writeFileSync(join(repositoryRoot, "source.ts"), "export const value = 1;\n");
    writeFileSync(join(repositoryRoot, "fixture.json"), "{}\n");
    const record = {
      ...valid,
      artifacts: {
        fixture: {
          path: "fixture.json",
          sha256: createHash("sha256").update("{}\n").digest("hex"),
        },
      },
      sourceSha256: {
        "source.ts": createHash("sha256").update("export const value = 1;\n").digest("hex"),
      },
    };
    writeFileSync(join(datedDirectory, "record.json"), `${JSON.stringify(record)}\n`);
    assert.deepEqual(remediationEvidenceViolations(evidenceDirectory, repositoryRoot), []);
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("reports malformed JSON in nested evidence directories", () => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "makefigma-evidence-"));
  try {
    const evidenceDirectory = join(repositoryRoot, "verification", "remediation");
    const datedDirectory = join(evidenceDirectory, "2026-09-14");
    mkdirSync(datedDirectory, { recursive: true });
    writeFileSync(join(datedDirectory, "broken.json"), "{\n");
    const violations = remediationEvidenceViolations(evidenceDirectory, repositoryRoot);
    assert.ok(violations.some((message) => message.includes("broken.json") && message.includes("invalid JSON")));
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("does not treat nested raw sampling artifacts as completion records", () => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "makefigma-evidence-"));
  try {
    const evidenceDirectory = join(repositoryRoot, "verification", "remediation");
    const rawDirectory = join(evidenceDirectory, "2026-09-14", "pf03-run");
    mkdirSync(rawDirectory, { recursive: true });
    writeFileSync(join(rawDirectory, "run-1.json"), "### Result\n{}");
    assert.deepEqual(remediationEvidenceViolations(evidenceDirectory, repositoryRoot), []);
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("detects content drift in nested completion records", () => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "makefigma-evidence-"));
  try {
    const evidenceDirectory = join(repositoryRoot, "verification", "remediation");
    const datedDirectory = join(evidenceDirectory, "2026-09-14");
    mkdirSync(datedDirectory, { recursive: true });
    writeFileSync(join(repositoryRoot, "source.ts"), "export const value = 2;\n");
    writeFileSync(join(repositoryRoot, "fixture.json"), "{}\n");
    const record = {
      ...valid,
      artifacts: {
        fixture: {
          path: "fixture.json",
          sha256: createHash("sha256").update("{}\n").digest("hex"),
        },
      },
      sourceSha256: {
        "source.ts": createHash("sha256").update("export const value = 1;\n").digest("hex"),
      },
    };
    writeFileSync(join(datedDirectory, "record.json"), `${JSON.stringify(record)}\n`);
    const violations = remediationEvidenceViolations(evidenceDirectory, repositoryRoot);
    assert.ok(violations.some((message) => message.includes("source.ts") && message.includes("mismatch")));
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});
