import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { collectPhase1GateReport, renderPhase1GateAcceptance } from "./capture-phase1-gate-report.mjs";

describe("Phase 1 gate report", () => {
  it("records a commit-bound candidate and never upgrades missing independent gates to PASS", () => {
    const root = mkdtempSync(join(tmpdir(), "makefigma-phase1-gate-"));
    const probe = (_root, executable, args) => {
      const key = `${executable} ${args.join(" ")}`;
      return new Map([
        ["git rev-parse HEAD", "a".repeat(40)],
        ["git rev-parse --short HEAD", "aaaaaaaa"],
        ["git status --porcelain", " M src/example.ts"],
        ["node --version", "v23.0.0"],
        ["pnpm --version", "11.8.0"],
      ]).get(key) ?? "";
    };
    const verified = [];
    const verify = (_root, executable, args) => {
      verified.push(`${executable} ${args.join(" ")}`);
      return "pass";
    };
    const report = collectPhase1GateReport({ root, now: new Date("2026-08-05T00:00:00.000Z"), probe, verify });
    expect(report.build).toMatchObject({ buildId: "aaaaaaaa-dirty", dirty: true });
    expect(report.automatic).toMatchObject({ fixtureStatus: "fail", checks: { webTests: "pass", webLint: "pass", webBuild: "pass", rustWorkspace: "pass", worktreeSyntax: "pass" } });
    expect(verified).toEqual(["pnpm test", "pnpm lint", "pnpm build", "cargo test --workspace", "git diff --check"]);
    expect(report.result).toBe("NO-GO");
    expect(report.manualGates).toHaveLength(5);
    expect(renderPhase1GateAcceptance(report)).toContain("**NO-GO**");
  });
});
