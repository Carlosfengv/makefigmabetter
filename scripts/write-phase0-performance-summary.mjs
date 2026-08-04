#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PHASE0_PERFORMANCE_SUMMARY_FORMAT = "makefigma-phase0-performance-v1";

function validMetrics(value) {
  return value && Number.isInteger(value.samples) && value.samples > 0
    && [value.p50Ms, value.p95Ms, value.maxMs].every((metric) => typeof metric === "number" && Number.isFinite(metric) && metric >= 0);
}

/** Extracts the JSON string returned by the Playwright CLI without depending on
 * its human-readable headings. */
export function parsePerformanceRun(value) {
  for (const line of value.split(/\r?\n/).map((candidate) => candidate.trim())) {
    if (!line) continue;
    try {
      const decoded = JSON.parse(line);
      const metrics = typeof decoded === "string" ? JSON.parse(decoded) : decoded;
      if (validMetrics(metrics)) return metrics;
    } catch { /* The CLI also writes headings and code excerpts. */ }
  }
  return undefined;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

export function summarizePerformanceRuns(runs, warmupSeconds) {
  if (!Number.isInteger(warmupSeconds) || warmupSeconds < 0) throw new Error("Warmup seconds must be a non-negative integer.");
  if (runs.length < 3) throw new Error("Phase 0 performance evidence requires at least three runs.");
  if (runs.some((run) => !validMetrics(run.metrics))) throw new Error("A performance run did not contain valid render metrics.");
  const samplesPerRun = runs[0].metrics.samples;
  if (runs.some((run) => run.metrics.samples !== samplesPerRun)) throw new Error("Performance runs must use the same sample count.");
  return {
    format: PHASE0_PERFORMANCE_SUMMARY_FORMAT,
    status: "pass",
    warmupSeconds,
    samplesPerRun,
    runs,
    median: {
      p50Ms: median(runs.map((run) => run.metrics.p50Ms)),
      p95Ms: median(runs.map((run) => run.metrics.p95Ms)),
      maxMs: median(runs.map((run) => run.metrics.maxMs)),
    },
  };
}

function parseArgs(args) {
  if (args.length !== 2 || !/^\d+$/.test(args[1])) return undefined;
  return { evidenceDirectory: args[0], warmupSeconds: Number(args[1]) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error("Usage: write-phase0-performance-summary.mjs <evidence-directory> <warmup-seconds>");
    process.exitCode = 64;
  } else {
    const evidenceDirectory = resolve(args.evidenceDirectory);
    const runs = readdirSync(evidenceDirectory)
      .filter((name) => /^performance-run-\d+\.txt$/.test(name))
      .sort()
      .map((name) => ({ file: name, metrics: parsePerformanceRun(readFileSync(resolve(evidenceDirectory, name), "utf8")) }));
    try {
      const summary = summarizePerformanceRuns(runs, args.warmupSeconds);
      const outputPath = resolve(evidenceDirectory, "performance-summary.json");
      writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
      console.log(`Phase 0 performance summary written to ${outputPath}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Unable to summarize Phase 0 performance evidence.");
      process.exitCode = 1;
    }
  }
}
