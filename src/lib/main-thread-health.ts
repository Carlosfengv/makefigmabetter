/** Browser Long Tasks are defined as tasks that block the main thread for 50ms or longer. */
export const LONG_TASK_THRESHOLD_MS = 50;

export interface MainThreadLongTaskSummary {
  count: number;
  totalDurationMs: number;
  maxDurationMs: number;
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
