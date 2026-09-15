#!/usr/bin/env node

import { createHash } from "node:crypto";
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
    && [
      value.worker.cullingP95Ms,
      value.worker.gpuPrepareP95Ms,
      value.worker.gpuIslandP95Ms,
      value.worker.canvasIslandP95Ms,
      value.worker.overlayP95Ms,
      value.worker.compositeP95Ms,
      value.worker.gpuUploadBytesP95,
      value.worker.canvasReadbackBytesP95,
      value.worker.gpuCoverageUpperBoundPixelsP95,
      value.worker.canvasFallbackCoverageUpperBoundPixelsP95,
      value.worker.compositeSurfaceBytesP95,
    ].every(validNumber)
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

export function summarizeZoomPerformanceRuns(runs, runtime, environment) {
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
    cullingP95Ms: median(values((metrics) => metrics.worker.cullingP95Ms)),
    gpuPrepareP95Ms: median(values((metrics) => metrics.worker.gpuPrepareP95Ms)),
    gpuIslandP95Ms: median(values((metrics) => metrics.worker.gpuIslandP95Ms)),
    canvasIslandP95Ms: median(values((metrics) => metrics.worker.canvasIslandP95Ms)),
    overlayP95Ms: median(values((metrics) => metrics.worker.overlayP95Ms)),
    compositeP95Ms: median(values((metrics) => metrics.worker.compositeP95Ms)),
    gpuUploadBytesP95: median(values((metrics) => metrics.worker.gpuUploadBytesP95)),
    canvasReadbackBytesP95: median(values((metrics) => metrics.worker.canvasReadbackBytesP95)),
    gpuCoverageUpperBoundPixelsP95: median(values((metrics) => metrics.worker.gpuCoverageUpperBoundPixelsP95)),
    canvasFallbackCoverageUpperBoundPixelsP95: median(values((metrics) => metrics.worker.canvasFallbackCoverageUpperBoundPixelsP95)),
    compositeSurfaceBytesP95: median(values((metrics) => metrics.worker.compositeSurfaceBytesP95)),
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
    ...(environment ? { environment } : {}),
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

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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
  if (args.length !== 3) throw new Error("Usage: write-zoom-performance-summary.mjs <evidence-directory> <warmup-seconds> <renderer>");
  const directory = resolve(args[0]);
  const warmupSeconds = Number(args[1]);
  if (!Number.isSafeInteger(warmupSeconds) || warmupSeconds < 0) throw new Error("Warmup seconds must be a non-negative integer.");
  const renderer = args[2];
  if (!renderer) throw new Error("Renderer must be recorded.");
  const runs = readdirSync(directory).filter((name) => /^run-\d+\.json$/.test(name)).sort()
    .map((file) => ({ file, metrics: parseZoomPerformanceRun(readFileSync(resolve(directory, file), "utf8")) }));
  const runtime = parseRuntime(readFileSync(resolve(directory, "runtime.json"), "utf8"));
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const fixtureSource = resolve(root, "src/lib/zoom-performance-fixture.ts");
  const wasm = resolve(root, "src/wasm/generated/editor_wasm_bg.wasm");
  const summary = summarizeZoomPerformanceRuns(runs, runtime, {
    warmupSeconds,
    renderer,
    fixture: {
      name: "zoom-50k",
      nodeCount: 50_000,
      seed: "0x5a17c0de",
      sourceSha256: sha256File(fixtureSource),
    },
    wasmSha256: sha256File(wasm),
  });
  const output = resolve(directory, "performance-summary.json");
  writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Zoom performance summary written to ${output}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error instanceof Error ? error.message : "Unable to summarize zoom performance evidence."); process.exitCode = 1; }
}
