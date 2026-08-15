import { describe, expect, it } from "vitest";
import { planWorkerRecovery, shouldDeferWorkerRecovery } from "./worker-recovery";

describe("Engine Worker recovery policy", () => {
  it("allows one bounded restart before entering safe mode", () => {
    expect(planWorkerRecovery(0)).toEqual({ mode: "restart", nextFailures: 1 });
    expect(planWorkerRecovery(1)).toEqual({ mode: "safe-mode", nextFailures: 1 });
  });

  it("normalizes invalid retry counters without allowing an unbounded loop", () => {
    expect(planWorkerRecovery(-4)).toEqual({ mode: "restart", nextFailures: 1 });
    expect(planWorkerRecovery(Number.POSITIVE_INFINITY)).toEqual({ mode: "safe-mode", nextFailures: Number.MAX_SAFE_INTEGER });
  });

  it("defers a module-load restart while the browser is offline", () => {
    expect(shouldDeferWorkerRecovery(false)).toBe(true);
    expect(shouldDeferWorkerRecovery(true)).toBe(false);
    expect(shouldDeferWorkerRecovery(undefined)).toBe(false);
  });
});
