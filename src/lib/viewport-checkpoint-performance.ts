export interface ViewportCheckpointSummary {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

/** Bounded evidence for the independent viewport write path. */
export function createViewportCheckpointSampler(capacity = 60) {
  const samples: number[] = [];
  return {
    record(durationMs: number) {
      if (!Number.isFinite(durationMs) || durationMs < 0) return;
      samples.push(durationMs);
      if (samples.length > capacity) samples.splice(0, samples.length - capacity);
    },
    reset() { samples.length = 0; },
    summary(): ViewportCheckpointSummary {
      if (!samples.length) return { samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
      const sorted = [...samples].sort((left, right) => left - right);
      return {
        samples: samples.length,
        p50Ms: round(percentile(sorted, .5)),
        p95Ms: round(percentile(sorted, .95)),
        maxMs: round(sorted.at(-1) ?? 0),
      };
    },
  };
}

function percentile(sorted: readonly number[], ratio: number) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
}

function round(value: number) { return Math.round(value * 1000) / 1000; }
