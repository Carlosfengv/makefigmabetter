#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PHASE2_COMMON_NODES_PERFORMANCE_FORMAT = "makefigma-phase2-common-nodes-performance-v1";

function finite(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function valid(metrics) {
  return metrics && Number.isInteger(metrics.render?.samples) && metrics.render.samples > 0
    && Number.isInteger(metrics.render?.inputToRenderSamples) && metrics.render.inputToRenderSamples > 0
    && Number.isInteger(metrics.input?.samples) && metrics.input.samples > 0
    && [metrics.render.p50Ms, metrics.render.p95Ms, metrics.render.maxMs, metrics.render.inputToRenderP95Ms, metrics.input.p50Ms, metrics.input.p95Ms, metrics.input.maxMs].every(finite);
}

export function parsePhase2CommonNodesPerformanceRun(value) {
  for (const line of value.split(/\r?\n/).map((candidate) => candidate.trim())) {
    if (!line) continue;
    try {
      const decoded = JSON.parse(line);
      const metrics = typeof decoded === "string" ? JSON.parse(decoded) : decoded;
      if (valid(metrics)) return metrics;
    } catch { /* Playwright includes non-JSON headings around eval output. */ }
  }
  return undefined;
}

function median(values) { return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]; }

export function summarizePhase2CommonNodesPerformance(runs, warmupSeconds, format = PHASE2_COMMON_NODES_PERFORMANCE_FORMAT) {
  if (!Number.isInteger(warmupSeconds) || warmupSeconds < 0) throw new Error("Warmup seconds must be a non-negative integer.");
  if (runs.length < 3) throw new Error("Phase 2 performance evidence requires at least three runs.");
  if (runs.some((run) => !valid(run.metrics))) throw new Error("A Phase 2 performance run did not contain complete input and render metrics.");
  // The in-app sampler is intentionally rolling. Consecutive probes therefore
  // retain more of the same steady-state window, rather than resetting a live
  // editor between runs. Every probe must still contribute a full 64-event
  // exercise before it is accepted as evidence.
  if (runs.some((run) => run.metrics.render.samples < 64 || run.metrics.render.inputToRenderSamples < 64)) throw new Error("Each performance run must contain at least 64 input-to-render samples.");
  const medianMetrics = {
    renderP95Ms: median(runs.map((run) => run.metrics.render.p95Ms)),
    inputToRenderP95Ms: median(runs.map((run) => run.metrics.render.inputToRenderP95Ms)),
    inputBacklogP95Ms: median(runs.map((run) => run.metrics.input.p95Ms)),
  };
  return {
    format,
    // This records a reproducible local candidate only. The 60-minute Gate is
    // separately required before Phase 2 may be declared complete.
    status: "local-candidate",
    warmupSeconds,
    renderSamplesPerRun: runs.map((run) => run.metrics.render.samples),
    inputSamplesPerRun: runs.map((run) => run.metrics.render.inputToRenderSamples),
    runs,
    median: medianMetrics,
    gates: {
      renderP95Under12Ms: medianMetrics.renderP95Ms < 12,
      inputToRenderP95Under50Ms: medianMetrics.inputToRenderP95Ms < 50,
      inputBacklogP95Under32Ms: medianMetrics.inputBacklogP95Ms < 32,
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [evidenceDirectory, rawWarmup, format] = process.argv.slice(2);
  if (!evidenceDirectory || !/^\d+$/.test(rawWarmup ?? "")) {
    console.error("Usage: write-phase2-common-nodes-performance-summary.mjs <evidence-directory> <warmup-seconds>");
    process.exitCode = 64;
  } else {
    const directory = resolve(evidenceDirectory);
    const runs = readdirSync(directory)
      .filter((name) => /^performance-run-\d+\.txt$/.test(name))
      .sort()
      .map((file) => ({ file, metrics: parsePhase2CommonNodesPerformanceRun(readFileSync(resolve(directory, file), "utf8")) }));
    try {
      writeFileSync(resolve(directory, "performance-summary.json"), `${JSON.stringify(summarizePhase2CommonNodesPerformance(runs, Number(rawWarmup), format || PHASE2_COMMON_NODES_PERFORMANCE_FORMAT), null, 2)}\n`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Unable to summarize Phase 2 performance evidence.");
      process.exitCode = 1;
    }
  }
}
