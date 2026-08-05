#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyPhase1AssetHostileFixture } from "./verify-phase1-asset-hostile-fixture.mjs";
import { verifyPhase1RenderCompositeFixture } from "./verify-phase1-render-composite-fixture.mjs";
import { verifyPhase1Shape100kFixture } from "./verify-phase1-shape-100k-fixture.mjs";
import { verifyPhase1SnapshotFixtures } from "./verify-phase1-snapshot-fixtures.mjs";
import { verifyPhase1Text10kFixture } from "./verify-phase1-text-10k-fixture.mjs";
import { verifyPhase1TextFixture } from "./verify-phase1-text-fixture.mjs";

const requiredManualGates = [
  "GitHub main required jobs",
  "B1–B4 independent environment evidence",
  "independently reviewed frozen Golden",
  "30-minute stability run",
  "P0/P1 defect audit and independent sign-off",
];

function command(root, executable, args) {
  try {
    return execFileSync(executable, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

function verificationCommand(root, executable, args) {
  try {
    execFileSync(executable, args, { cwd: root, stdio: "ignore" });
    return "pass";
  } catch {
    return "fail";
  }
}

const automaticChecks = {
  webTests: ["pnpm", ["test"]],
  webLint: ["pnpm", ["lint"]],
  webBuild: ["pnpm", ["build"]],
  rustWorkspace: ["cargo", ["test", "--workspace"]],
  worktreeSyntax: ["git", ["diff", "--check"]],
};

export function collectPhase1GateReport({ root = process.cwd(), now = new Date(), probe = command, verify = verificationCommand } = {}) {
  const fixtures = {
    snapshots: verifyPhase1SnapshotFixtures({ root }),
    textMultilingual: verifyPhase1TextFixture({ root }),
    text10k: verifyPhase1Text10kFixture({ root }),
    shape100k: verifyPhase1Shape100kFixture({ root }),
    assetHostile: verifyPhase1AssetHostileFixture({ root }),
    renderComposite: verifyPhase1RenderCompositeFixture({ root }),
  };
  const commit = probe(root, "git", ["rev-parse", "HEAD"]);
  const shortCommit = probe(root, "git", ["rev-parse", "--short", "HEAD"]);
  const dirty = probe(root, "git", ["status", "--porcelain"]) !== "";
  const fixturePass = Object.values(fixtures).every((result) => result.status === "pass");
  const checks = Object.fromEntries(
    Object.entries(automaticChecks).map(([name, [executable, args]]) => [name, verify(root, executable, args)]),
  );
  return {
    format: "makefigma-phase1-gate-report-v1",
    capturedAt: now.toISOString(),
    build: {
      commit: commit ?? "unavailable",
      buildId: `${shortCommit ?? "unavailable"}${dirty ? "-dirty" : ""}`,
      dirty,
      node: probe(root, "node", ["--version"]) ?? "unavailable",
      pnpm: probe(root, "pnpm", ["--version"]) ?? "unavailable",
    },
    fixtures,
    automatic: { fixtureStatus: fixturePass ? "pass" : "fail", checks },
    manualGates: requiredManualGates.map((gate) => ({ gate, status: "pending" })),
    result: "NO-GO",
  };
}

export function renderPhase1GateAcceptance(report) {
  const fixtureRows = Object.entries(report.fixtures)
    .map(([name, result]) => `| ${name} | ${result.status.toUpperCase()} | ${result.fixture ?? result.reason ?? "—"} |`)
    .join("\n");
  const manual = report.manualGates.map(({ gate }) => `- [ ] ${gate}`).join("\n");
  const automaticRows = Object.entries(report.automatic.checks)
    .map(([name, status]) => `| ${name} | ${status.toUpperCase()} |`)
    .join("\n");
  return `# Phase 1.11 Candidate Gate Report\n\n| Field | Value |\n| --- | --- |\n| Build | ${report.build.buildId} (${report.build.commit}) |\n| Worktree | ${report.build.dirty ? "dirty; report is a candidate observation, not a releasable commit" : "clean"} |\n| Captured | ${report.capturedAt} |\n| Result | **${report.result}** |\n\n## Automated checks\n\n| Check | Status |\n| --- | --- |\n| fixtures | ${report.automatic.fixtureStatus.toUpperCase()} |\n${automaticRows}\n\n## Fixture checks\n\n| Fixture | Status | Evidence |\n| --- | --- | --- |\n${fixtureRows}\n\n## Required before GO\n\n${manual}\n\nThis report deliberately cannot produce PASS: Phase 1 requires independent GitHub, multi-environment, Golden, stability, defect-audit and sign-off evidence.\n`;
}

export function writePhase1GateReport({ root = process.cwd(), outputDirectory, now, probe } = {}) {
  const report = collectPhase1GateReport({ root, now, probe });
  const directory = resolve(root, outputDirectory ?? `output/phase1-gates/${report.build.buildId}-${report.capturedAt.replace(/[:.]/g, "-")}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, "environment.json"), `${JSON.stringify({ capturedAt: report.capturedAt, build: report.build }, null, 2)}\n`);
  writeFileSync(resolve(directory, "fixture-manifest.json"), `${JSON.stringify({ format: report.format, fixtures: report.fixtures, automatic: report.automatic }, null, 2)}\n`);
  writeFileSync(resolve(directory, "defects.md"), "# Defect audit\n\nNo P0/P1 audit has been independently completed for this candidate.\n");
  writeFileSync(resolve(directory, "acceptance.md"), renderPhase1GateAcceptance(report));
  return { directory, report };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outputDirectory = process.argv[2];
  const { directory, report } = writePhase1GateReport({ outputDirectory });
  console.log(JSON.stringify({ status: report.result, directory, buildId: report.build.buildId }, null, 2));
}
