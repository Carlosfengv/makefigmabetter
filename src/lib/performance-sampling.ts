export interface RenderPerformanceSummary {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  cullingP95Ms: number;
  gpuPrepareP95Ms: number;
  gpuIslandP95Ms: number;
  canvasIslandP95Ms: number;
  overlayP95Ms: number;
  imageBitmapP95Ms: number;
  compositeP95Ms: number;
  candidateNodesP95: number;
  visibleNodesP95: number;
  gpuUploadBytesP95: number;
  canvasReadbackBytesP95: number;
  gpuCoverageUpperBoundPixelsP95: number;
  canvasFallbackCoverageUpperBoundPixelsP95: number;
  compositeSurfaceBytesP95: number;
  rendersPerInputFrameMax: number;
  /** Main-thread input timestamp through completed Worker render. */
  inputToRenderSamples: number;
  inputToRenderP95Ms: number;
}

export interface RenderBreakdownSample {
  totalMs: number;
  cullingMs?: number;
  gpuPrepareMs?: number;
  gpuIslandMs?: number;
  canvasIslandMs?: number;
  overlayMs?: number;
  imageBitmapMs?: number;
  compositeMs?: number;
  candidateNodes?: number;
  visibleNodes?: number;
  gpuUploadBytes?: number;
  canvasReadbackBytes?: number;
  gpuCoverageUpperBoundPixels?: number;
  canvasFallbackCoverageUpperBoundPixels?: number;
  compositeSurfaceBytes?: number;
  rendersPerInputFrame?: number;
  inputToRenderMs?: number;
}

/** Fixed-size latency reservoir. Snapshot values are rounded only for reporting. */
export function createRenderPerformanceSampler(maxSamples = 240) {
  const capacity = Math.max(1, Math.floor(maxSamples));
  const samples: number[] = [];
  const cullingSamples: number[] = [];
  const gpuSamples: number[] = [];
  const gpuIslandSamples: number[] = [];
  const canvasIslandSamples: number[] = [];
  const overlaySamples: number[] = [];
  const imageBitmapSamples: number[] = [];
  const compositeSamples: number[] = [];
  const candidateSamples: number[] = [];
  const visibleSamples: number[] = [];
  const uploadSamples: number[] = [];
  const readbackSamples: number[] = [];
  const gpuCoverageSamples: number[] = [];
  const canvasCoverageSamples: number[] = [];
  const compositeSurfaceSamples: number[] = [];
  const renderCounts: number[] = [];
  const inputLatencySamples: number[] = [];
  let recording = false;

  return {
    /** Starts a new steady-state window after startup or document hydration. */
    start() {
      samples.length = 0;
      clearBreakdown();
      recording = true;
    },
    /** Suppresses samples while a renderer/runtime is being rebuilt. */
    reset() {
      samples.length = 0;
      clearBreakdown();
      recording = false;
    },
    record(sample: number | RenderBreakdownSample) {
      const durationMs = typeof sample === "number" ? sample : sample.totalMs;
      if (!recording || !Number.isFinite(durationMs) || durationMs < 0) return;
      samples.push(durationMs);
      if (samples.length > capacity) samples.splice(0, samples.length - capacity);
      if (typeof sample !== "number") recordBreakdown(sample);
    },
    recordInputToRender(durationMs: number) {
      if (recording) push(inputLatencySamples, durationMs);
    },
    summary(): RenderPerformanceSummary {
      if (!samples.length) return emptySummary();
      const sorted = [...samples].sort((left, right) => left - right);
      return {
        samples: samples.length,
        p50Ms: rounded(percentile(sorted, 0.5)),
        p95Ms: rounded(percentile(sorted, 0.95)),
        maxMs: rounded(sorted.at(-1) ?? 0),
        cullingP95Ms: percentileValue(cullingSamples),
        gpuPrepareP95Ms: percentileValue(gpuSamples),
        gpuIslandP95Ms: percentileValue(gpuIslandSamples),
        canvasIslandP95Ms: percentileValue(canvasIslandSamples),
        overlayP95Ms: percentileValue(overlaySamples),
        imageBitmapP95Ms: percentileValue(imageBitmapSamples),
        compositeP95Ms: percentileValue(compositeSamples),
        candidateNodesP95: percentileValue(candidateSamples),
        visibleNodesP95: percentileValue(visibleSamples),
        gpuUploadBytesP95: percentileValue(uploadSamples),
        canvasReadbackBytesP95: percentileValue(readbackSamples),
        gpuCoverageUpperBoundPixelsP95: percentileValue(gpuCoverageSamples),
        canvasFallbackCoverageUpperBoundPixelsP95: percentileValue(canvasCoverageSamples),
        compositeSurfaceBytesP95: percentileValue(compositeSurfaceSamples),
        rendersPerInputFrameMax: renderCounts.length ? Math.max(...renderCounts) : 0,
        inputToRenderSamples: inputLatencySamples.length,
        inputToRenderP95Ms: percentileValue(inputLatencySamples),
      };
    },
  };

  function recordBreakdown(sample: RenderBreakdownSample) {
    push(cullingSamples, sample.cullingMs);
    push(gpuSamples, sample.gpuPrepareMs);
    push(gpuIslandSamples, sample.gpuIslandMs);
    push(canvasIslandSamples, sample.canvasIslandMs);
    push(overlaySamples, sample.overlayMs);
    push(imageBitmapSamples, sample.imageBitmapMs);
    push(compositeSamples, sample.compositeMs);
    push(candidateSamples, sample.candidateNodes);
    push(visibleSamples, sample.visibleNodes);
    push(uploadSamples, sample.gpuUploadBytes);
    push(readbackSamples, sample.canvasReadbackBytes);
    push(gpuCoverageSamples, sample.gpuCoverageUpperBoundPixels);
    push(canvasCoverageSamples, sample.canvasFallbackCoverageUpperBoundPixels);
    push(compositeSurfaceSamples, sample.compositeSurfaceBytes);
    push(renderCounts, sample.rendersPerInputFrame);
    push(inputLatencySamples, sample.inputToRenderMs);
  }
  function clearBreakdown() { [cullingSamples, gpuSamples, gpuIslandSamples, canvasIslandSamples, overlaySamples, imageBitmapSamples, compositeSamples, candidateSamples, visibleSamples, uploadSamples, readbackSamples, gpuCoverageSamples, canvasCoverageSamples, compositeSurfaceSamples, renderCounts, inputLatencySamples].forEach((values) => { values.length = 0; }); }
}

function emptySummary(): RenderPerformanceSummary { return { samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, cullingP95Ms: 0, gpuPrepareP95Ms: 0, gpuIslandP95Ms: 0, canvasIslandP95Ms: 0, overlayP95Ms: 0, imageBitmapP95Ms: 0, compositeP95Ms: 0, candidateNodesP95: 0, visibleNodesP95: 0, gpuUploadBytesP95: 0, canvasReadbackBytesP95: 0, gpuCoverageUpperBoundPixelsP95: 0, canvasFallbackCoverageUpperBoundPixelsP95: 0, compositeSurfaceBytesP95: 0, rendersPerInputFrameMax: 0, inputToRenderSamples: 0, inputToRenderP95Ms: 0 }; }
const BREAKDOWN_CAPACITY = 240;
function push(target: number[], value: number | undefined) { if (value === undefined || !Number.isFinite(value)) return; target.push(value); if (target.length > BREAKDOWN_CAPACITY) target.splice(0, target.length - BREAKDOWN_CAPACITY); }
function percentileValue(values: readonly number[]) { return values.length ? rounded(percentile([...values].sort((left, right) => left - right), .95)) : 0; }

function percentile(sorted: readonly number[], ratio: number): number { return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0; }
function rounded(value: number): number { return Math.round(value * 1000) / 1000; }
