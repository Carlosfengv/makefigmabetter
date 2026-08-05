#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PHASE1_RENDER_COMPOSITE_PERFORMANCE_FORMAT = "makefigma-phase1-render-composite-performance-v1";

function validMetrics(value) {
  return value && Number.isInteger(value.samples) && value.samples > 0
    && [value.p50Ms, value.p95Ms, value.maxMs].every((metric) => typeof metric === "number" && Number.isFinite(metric) && metric >= 0);
}

export function parsePhase1RenderCompositePerformanceRun(value) {
  for (const line of value.split(/\r?\n/).map((candidate) => candidate.trim())) {
    if (!line) continue;
    try {
      const decoded = JSON.parse(line);
      const metrics = typeof decoded === "string" ? JSON.parse(decoded) : decoded;
      if (validMetrics(metrics)) return metrics;
    } catch { /* Playwright also prints headings and source excerpts. */ }
  }
  return undefined;
}

function median(values) { return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]; }

export function summarizePhase1RenderCompositePerformance(runs, warmupSeconds) {
  if (!Number.isInteger(warmupSeconds) || warmupSeconds < 0) throw new Error("Warmup seconds must be a non-negative integer.");
  if (runs.length < 3) throw new Error("Phase 1 performance evidence requires at least three runs.");
  if (runs.some((run) => !validMetrics(run.metrics))) throw new Error("A performance run did not contain valid render metrics.");
  const samplesPerRun = runs[0].metrics.samples;
  if (runs.some((run) => run.metrics.samples !== samplesPerRun)) throw new Error("Performance runs must use the same sample count.");
  return {
    format: PHASE1_RENDER_COMPOSITE_PERFORMANCE_FORMAT,
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [evidenceDirectory, rawWarmup] = process.argv.slice(2);
  if (!evidenceDirectory || !/^\d+$/.test(rawWarmup ?? "")) {
    console.error("Usage: write-phase1-render-composite-performance-summary.mjs <evidence-directory> <warmup-seconds>");
    process.exitCode = 64;
  } else {
    const directory = resolve(evidenceDirectory);
    const runs = readdirSync(directory)
      .filter((name) => /^performance-run-\d+\.txt$/.test(name))
      .sort()
      .map((file) => ({ file, metrics: parsePhase1RenderCompositePerformanceRun(readFileSync(resolve(directory, file), "utf8")) }));
    try {
      const summary = summarizePhase1RenderCompositePerformance(runs, Number(rawWarmup));
      writeFileSync(resolve(directory, "performance-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Unable to summarize Phase 1 performance evidence.");
      process.exitCode = 1;
    }
  }
}
