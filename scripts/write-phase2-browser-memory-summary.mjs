#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PHASE2_BROWSER_MEMORY_FORMAT = "makefigma-phase2-browser-memory-v1";

function finite(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0; }

export function parsePhase2BrowserMemoryRun(value) {
  for (const line of value.split(/\r?\n/).map((candidate) => candidate.trim())) {
    if (!line) continue;
    try {
      const decoded = JSON.parse(line);
      const sample = typeof decoded === "string" ? JSON.parse(decoded) : decoded;
      if (typeof sample?.capturedAt === "string" && finite(sample.memory?.usedJSHeapSize) && finite(sample.memory?.totalJSHeapSize) && finite(sample.memory?.jsHeapSizeLimit)) return sample;
    } catch { /* Playwright may prefix output around eval results. */ }
  }
  return undefined;
}

function range(values) {
  const first = values[0];
  const last = values.at(-1);
  return { first, last, min: Math.min(...values), max: Math.max(...values), delta: last - first };
}

export function summarizePhase2BrowserMemory(runs, format = PHASE2_BROWSER_MEMORY_FORMAT) {
  if (runs.length < 3) throw new Error("Phase 2 stability evidence requires at least three browser memory samples.");
  if (runs.some((run) => !run.sample)) throw new Error("A browser memory sample was missing or unsupported.");
  const samples = runs.map(({ file, sample }) => ({ file, capturedAt: sample.capturedAt, ...sample.memory }));
  return {
    format,
    // This is an observed curve for an independent reviewer, not an automatic
    // memory-leak verdict. The reviewer evaluates it with the paired actions,
    // performance samples, browser environment, and start/end screenshots.
    status: "local-candidate",
    samples,
    usedJSHeapSize: range(samples.map((sample) => sample.usedJSHeapSize)),
    totalJSHeapSize: range(samples.map((sample) => sample.totalJSHeapSize)),
    jsHeapSizeLimit: [...new Set(samples.map((sample) => sample.jsHeapSizeLimit))],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [evidenceDirectory, format] = process.argv.slice(2);
  if (!evidenceDirectory) {
    console.error("Usage: write-phase2-browser-memory-summary.mjs <evidence-directory> [format]");
    process.exitCode = 64;
  } else {
    const directory = resolve(evidenceDirectory);
    const runs = readdirSync(directory)
      .filter((name) => /^memory-run-\d+\.txt$/.test(name))
      .sort()
      .map((file) => ({ file, sample: parsePhase2BrowserMemoryRun(readFileSync(resolve(directory, file), "utf8")) }));
    try {
      writeFileSync(resolve(directory, "memory-summary.json"), `${JSON.stringify(summarizePhase2BrowserMemory(runs, format || PHASE2_BROWSER_MEMORY_FORMAT), null, 2)}\n`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Unable to summarize Phase 2 browser memory evidence.");
      process.exitCode = 1;
    }
  }
}
