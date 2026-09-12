#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PHASE2_PROFESSIONAL_STABILITY_FORMAT = "makefigma-phase2-professional-composite-stability-v1";
const REQUIRED_ACTIONS = ["pan", "zoom", "select", "move", "resize", "rotate", "text", "layout", "effect", "undo", "redo"];

export function parsePlaywrightResult(value) {
  for (const line of value.split(/\r?\n/).map((candidate) => candidate.trim())) {
    if (!line) continue;
    try {
      const decoded = JSON.parse(line);
      return typeof decoded === "string" ? JSON.parse(decoded) : decoded;
    } catch { /* Playwright may surround JSON results with markdown headings. */ }
  }
  return undefined;
}

function requiredFiles(directory, pattern) {
  return readdirSync(directory).filter((name) => pattern.test(name)).sort();
}

function exactActionRun(value) {
  return Array.isArray(value?.performed)
    && value.performed.length === REQUIRED_ACTIONS.length
    && value.performed.every((action, index) => action === REQUIRED_ACTIONS[index]);
}

function validDuration(value) { return Number.isInteger(value) && value >= 0; }
function validMinimumCycles(value) { return Number.isInteger(value) && value >= 3; }

/** Produces a machine-readable candidate record. It deliberately does not
 * pronounce a 60-minute run leak-free: independent review still compares the
 * paired screenshots, console, memory curve and source fingerprint. */
export function summarizePhase2ProfessionalCompositeStability({
  requestedDurationSeconds,
  elapsedSeconds,
  minimumCycleCount = Math.max(3, Math.ceil(requestedDurationSeconds / 120)),
  cycles,
  actionRuns,
  moveRuns,
  performanceRuns,
  memoryRuns,
  consoleText,
  hasStartScreenshot,
  hasEndScreenshot,
  hasBrowserEnvironment,
  hasSourceFingerprint,
}) {
  if (!validDuration(requestedDurationSeconds) || !validDuration(elapsedSeconds)) throw new Error("Stability durations must be non-negative whole seconds.");
  if (!validMinimumCycles(minimumCycleCount)) throw new Error("Stability evidence requires at least three continuous cycle records.");
  const counts = [cycles.length, actionRuns.length, moveRuns.length, performanceRuns.length, memoryRuns.length];
  if (counts.some((count) => count < minimumCycleCount) || new Set(counts).size !== 1) throw new Error(`Stability evidence requires matching action, move, performance, memory, and cycle records with at least ${minimumCycleCount} runs.`);
  if (actionRuns.some((run) => !exactActionRun(run.result))) throw new Error("A stability action record did not execute the complete fixed interaction sequence.");
  if (moveRuns.some((run) => run.result?.moved !== true)) throw new Error("A stability move record did not prove a keyboard-driven Canonical mutation.");
  if (!hasStartScreenshot || !hasEndScreenshot || !hasBrowserEnvironment || !hasSourceFingerprint) throw new Error("Stability evidence is missing a required screenshot, environment, or source fingerprint artifact.");
  if (!/Errors:\s*0\b/.test(consoleText)) throw new Error("Stability evidence contains browser console errors.");
  return {
    format: PHASE2_PROFESSIONAL_STABILITY_FORMAT,
    status: "local-candidate",
    requestedDurationSeconds,
    elapsedSeconds,
    runCount: cycles.length,
    minimumCycleCount,
    actionsPerRun: REQUIRED_ACTIONS,
    artifacts: {
      startScreenshot: hasStartScreenshot,
      endScreenshot: hasEndScreenshot,
      browserEnvironment: hasBrowserEnvironment,
      sourceFingerprint: hasSourceFingerprint,
      consoleErrors: 0,
    },
    gates: {
      elapsedAtLeastRequested: elapsedSeconds >= requestedDurationSeconds,
      minimumContinuousCycleCount: true,
      matchingRunArchives: true,
      completeActionSequence: true,
      keyboardMoveMutatedCanonicalDocument: true,
      consoleErrorsZero: true,
    },
  };
}

function loadRuns(directory, pattern) {
  return requiredFiles(directory, pattern).map((file) => ({ file, result: parsePlaywrightResult(readFileSync(resolve(directory, file), "utf8")) }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [evidenceDirectory, rawStartedAt, rawFinishedAt, rawRequestedDuration, rawRunCount, rawMinimumCycles] = process.argv.slice(2);
  if (!evidenceDirectory || !/^\d+$/.test(rawStartedAt ?? "") || !/^\d+$/.test(rawFinishedAt ?? "") || !/^\d+$/.test(rawRequestedDuration ?? "") || !/^\d+$/.test(rawRunCount ?? "") || !/^\d+$/.test(rawMinimumCycles ?? "")) {
    console.error("Usage: write-phase2-professional-composite-stability-summary.mjs <evidence-directory> <started-at-epoch> <finished-at-epoch> <requested-duration-seconds> <run-count> <minimum-cycle-count>");
    process.exitCode = 64;
  } else {
    const directory = resolve(evidenceDirectory);
    const startedAt = Number(rawStartedAt);
    const finishedAt = Number(rawFinishedAt);
    try {
      const cycles = readFileSync(resolve(directory, "cycles.tsv"), "utf8").trim().split(/\r?\n/).filter(Boolean);
      const summary = summarizePhase2ProfessionalCompositeStability({
        requestedDurationSeconds: Number(rawRequestedDuration),
        elapsedSeconds: Math.max(0, finishedAt - startedAt),
        minimumCycleCount: Number(rawMinimumCycles),
        cycles,
        actionRuns: loadRuns(directory, /^action-run-\d+\.txt$/),
        moveRuns: loadRuns(directory, /^move-verification-run-\d+\.txt$/),
        performanceRuns: requiredFiles(directory, /^performance-run-\d+\.txt$/),
        memoryRuns: requiredFiles(directory, /^memory-run-\d+\.txt$/),
        consoleText: readFileSync(resolve(directory, "console.txt"), "utf8"),
        hasStartScreenshot: existsSync(resolve(directory, "phase2-professional-composite-start.png")),
        hasEndScreenshot: existsSync(resolve(directory, "phase2-professional-composite-end.png")),
        hasBrowserEnvironment: existsSync(resolve(directory, "browser-environment.txt")),
        hasSourceFingerprint: existsSync(resolve(directory, "source-fingerprint.json")),
      });
      if (summary.runCount !== Number(rawRunCount)) throw new Error("Stability run count did not match the capture loop.");
      writeFileSync(resolve(directory, "stability-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Unable to summarize professional Phase 2 stability evidence.");
      process.exitCode = 1;
    }
  }
}
