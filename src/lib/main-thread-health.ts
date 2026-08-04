/** Browser Long Tasks are defined as tasks that block the main thread for 50ms or longer. */
export const LONG_TASK_THRESHOLD_MS = 50;

export interface MainThreadLongTaskSummary {
  count: number;
  totalDurationMs: number;
  maxDurationMs: number;
}

export interface FrameIntervalSummary { samples: number; p50Ms: number; p95Ms: number; maxMs: number; }

/** A bounded, allocation-light requestAnimationFrame interval sampler. */
export function createFrameIntervalSampler(capacity = 240) {
  const samples: number[] = [];
  let previous: number | undefined;
  return {
    reset() { samples.length = 0; previous = undefined; },
    record(timestamp: number) {
      if (!Number.isFinite(timestamp)) return;
      if (previous !== undefined && timestamp >= previous) {
        samples.push(timestamp - previous);
        if (samples.length > capacity) samples.splice(0, samples.length - capacity);
      }
      previous = timestamp;
    },
    summary(): FrameIntervalSummary {
      if (!samples.length) return { samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
      const sorted = [...samples].sort((left, right) => left - right);
      return { samples: samples.length, p50Ms: percentile(sorted, .5), p95Ms: percentile(sorted, .95), maxMs: sorted.at(-1) ?? 0 };
    },
  };
}

export const emptyMainThreadLongTaskSummary = (): MainThreadLongTaskSummary => ({
  count: 0,
  totalDurationMs: 0,
  maxDurationMs: 0,
});

/**
 * Adds one observed Long Task to transient UI evidence. Invalid and sub-threshold
 * samples are deliberately ignored so a browser implementation detail cannot
 * make the editor appear unhealthy.
 */
export function recordMainThreadLongTask(
  summary: MainThreadLongTaskSummary,
  durationMs: number,
): MainThreadLongTaskSummary {
  if (!Number.isFinite(durationMs) || durationMs < LONG_TASK_THRESHOLD_MS) return summary;
  return {
    count: summary.count + 1,
    totalDurationMs: summary.totalDurationMs + durationMs,
    maxDurationMs: Math.max(summary.maxDurationMs, durationMs),
  };
}

function percentile(sorted: readonly number[], ratio: number) { return Math.round((sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0) * 1000) / 1000; }
