export interface RenderPerformanceSummary {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

/** Fixed-size latency reservoir. Snapshot values are rounded only for reporting. */
export function createRenderPerformanceSampler(maxSamples = 240) {
  const capacity = Math.max(1, Math.floor(maxSamples));
  const samples: number[] = [];
  let recording = false;

  return {
    /** Starts a new steady-state window after startup or document hydration. */
    start() {
      samples.length = 0;
      recording = true;
    },
    /** Suppresses samples while a renderer/runtime is being rebuilt. */
    reset() {
      samples.length = 0;
      recording = false;
    },
    record(durationMs: number) {
      if (!recording || !Number.isFinite(durationMs) || durationMs < 0) return;
      samples.push(durationMs);
      if (samples.length > capacity) samples.splice(0, samples.length - capacity);
    },
    summary(): RenderPerformanceSummary {
      if (!samples.length) return { samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
      const sorted = [...samples].sort((left, right) => left - right);
      return {
        samples: samples.length,
        p50Ms: rounded(percentile(sorted, 0.5)),
        p95Ms: rounded(percentile(sorted, 0.95)),
        maxMs: rounded(sorted.at(-1) ?? 0),
      };
    },
  };
}

function percentile(sorted: readonly number[], ratio: number): number { return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0; }
function rounded(value: number): number { return Math.round(value * 1000) / 1000; }
