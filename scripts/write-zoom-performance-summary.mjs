#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ZOOM_PERFORMANCE_SUMMARY_FORMAT = "makefigma-zoom-performance-v1";

export function parseZoomPerformanceRun(value) {
  for (const line of value.split(/\r?\n/).map((candidate) => candidate.trim())) {
    if (!line) continue;
    try {
      const decoded = JSON.parse(line);
      const metrics = typeof decoded === "string" ? JSON.parse(decoded) : decoded;
      if (validRun(metrics)) return metrics;
    } catch { /* The CLI adds headings around JSON results. */ }
  }
  return undefined;
}

function validNumber(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function validSummary(value) {
  return value && Number.isInteger(value.samples) && value.samples >= 0
    && [value.p50Ms, value.p95Ms, value.maxMs].every(validNumber);
}
function validRun(value) {
  return value && validSummary(value.worker) && validSummary(value.frames) && validSummary(value.inputBacklog)
    && value.longTasks && Number.isInteger(value.longTasks.count) && value.longTasks.count >= 0
    && validNumber(value.worker.cullingP95Ms) && validNumber(value.worker.gpuUploadBytesP95)
    && validNumber(value.worker.rendersPerInputFrameMax)
    && value.dynamicDpr?.interactiveSurface && value.dynamicDpr?.settledSurface;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function nativeSurface(surface, dpr) {
  return Array.isArray(surface?.css) && Array.isArray(surface?.backing)
    && surface.css.length === 2 && surface.backing.length === 2
    && surface.backing.every((value, index) => value === Math.ceil(surface.css[index] * dpr));
}

export function summarizeZoomPerformanceRuns(runs, runtime) {
  if (runs.length < 3) throw new Error("Zoom performance evidence requires at least three runs.");
  if (runs.some((run) => !validRun(run.metrics))) throw new Error("A zoom performance run did not contain complete metrics.");
  if (!runtime || !Number.isFinite(runtime.dpr) || runtime.dpr <= 0) throw new Error("Browser runtime metadata must include a positive DPR.");
  const values = (selector) => runs.map((run) => selector(run.metrics));
  const medianMetrics = {
    workerP95Ms: median(values((metrics) => metrics.worker.p95Ms)),
    frameP95Ms: median(values((metrics) => metrics.frames.p95Ms)),
    inputBacklogP95Ms: median(values((metrics) => metrics.inputBacklog.p95Ms)),
    longTaskCount: median(values((metrics) => metrics.longTasks.count)),
    rendersPerInputFrameMax: Math.max(...values((metrics) => metrics.worker.rendersPerInputFrameMax)),
    gpuUploadBytesP95: median(values((metrics) => metrics.worker.gpuUploadBytesP95)),
  };
  const dynamicDprRestored = runs.every((run) => nativeSurface(run.metrics.dynamicDpr.settledSurface, runtime.dpr));
  const dynamicDprReduced = runs.every((run) => {
    const { interactiveSurface, settledSurface } = run.metrics.dynamicDpr;
    return interactiveSurface.backing.some((value, index) => value < settledSurface.backing[index]);
  });
  return {
    format: ZOOM_PERFORMANCE_SUMMARY_FORMAT,
    runs,
    runtime,
    median: medianMetrics,
    checks: {
      workerP95Under12Ms: medianMetrics.workerP95Ms < 12,
      frameP95Under20Ms: medianMetrics.frameP95Ms < 20,
      inputBacklogP95Under32Ms: medianMetrics.inputBacklogP95Ms < 32,
      noMainThreadLongTasks: medianMetrics.longTaskCount === 0,
      oneRenderPerInputFrame: medianMetrics.rendersPerInputFrameMax <= 1,
      ...(runtime.webgpuActive ? { cameraUniformUploadAtMost256Bytes: medianMetrics.gpuUploadBytesP95 <= 256 } : {}),
      dynamicDprReduced,
      dynamicDprRestored,
    },
  };
}

function parseRuntime(value) {
  for (const line of value.split(/\r?\n/).map((candidate) => candidate.trim())) {
    try {
      const decoded = JSON.parse(line);
      const runtime = typeof decoded === "string" ? JSON.parse(decoded) : decoded;
      if (runtime && typeof runtime === "object") return runtime;
    } catch { /* Ignore CLI framing output. */ }
  }
  return undefined;
}

function main(args) {
  if (args.length !== 1) throw new Error("Usage: write-zoom-performance-summary.mjs <evidence-directory>");
  const directory = resolve(args[0]);
  const runs = readdirSync(directory).filter((name) => /^run-\d+\.json$/.test(name)).sort()
    .map((file) => ({ file, metrics: parseZoomPerformanceRun(readFileSync(resolve(directory, file), "utf8")) }));
  const runtime = parseRuntime(readFileSync(resolve(directory, "runtime.json"), "utf8"));
  const summary = summarizeZoomPerformanceRuns(runs, runtime);
  const output = resolve(directory, "performance-summary.json");
  writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Zoom performance summary written to ${output}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error instanceof Error ? error.message : "Unable to summarize zoom performance evidence."); process.exitCode = 1; }
}
