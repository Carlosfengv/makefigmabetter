/** A second consecutive Engine Worker failure enters safe mode instead of looping. */
export const MAX_CONSECUTIVE_WORKER_RECOVERIES = 1;

export type WorkerRecoveryPlan =
  | { mode: "restart"; nextFailures: number }
  | { mode: "safe-mode"; nextFailures: number };

/** A browser offline transition can abort a Worker module fetch without the
 * document engine itself being corrupt. Defer that restart until connectivity
 * returns; it must not consume the bounded crash-recovery budget. */
export function shouldDeferWorkerRecovery(isOnline: boolean | undefined) {
  return isOnline === false;
}

/**
 * Keeps crash handling deterministic and testable outside React. A Worker can be
 * restarted once from its last confirmed Core snapshot; repeated failures stop
 * command intake so a broken build cannot repeatedly mutate local persistence.
 */
export function planWorkerRecovery(consecutiveFailures: number): WorkerRecoveryPlan {
  const normalized = Number.isFinite(consecutiveFailures)
    ? Math.max(0, Math.floor(consecutiveFailures))
    : Number.MAX_SAFE_INTEGER;
  if (normalized >= MAX_CONSECUTIVE_WORKER_RECOVERIES) {
    return { mode: "safe-mode", nextFailures: normalized };
  }
  return { mode: "restart", nextFailures: normalized + 1 };
}
