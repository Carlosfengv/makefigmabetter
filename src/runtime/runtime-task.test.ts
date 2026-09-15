import { describe, expect, it, vi } from "vitest";
import { isRuntimeError } from "./runtime-errors";
import { RuntimeTask } from "./runtime-task";

describe("RuntimeTask", () => {
  it("cancels cooperative work before its durable boundary", async () => {
    const task = new RuntimeTask(async ({ signal }) => await new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const outcome = task.promise.catch((error: unknown) => error);
    task.cancel();
    expect(isRuntimeError(await outcome, "TASK_CANCELLED")).toBe(true);
    expect(task.state).toBe("cancelled");
  });

  it("settles cancellation even when an injected executor has not observed its signal yet", async () => {
    let finish!: (value: string) => void;
    const task = new RuntimeTask(async () => await new Promise<string>((resolve) => { finish = resolve; }));
    const outcome = task.promise.catch((error: unknown) => error);

    task.cancel();
    expect(isRuntimeError(await outcome, "TASK_CANCELLED")).toBe(true);
    expect(task.state).toBe("cancelled");

    // A late executor completion cannot republish the cancelled result.
    finish("late");
    await Promise.resolve();
    expect(task.state).toBe("cancelled");
  });

  it("fails a still-cancellable task on timeout", async () => {
    vi.useFakeTimers();
    const task = new RuntimeTask(async ({ signal }) => await new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }), 10);
    const outcome = task.promise.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    expect(isRuntimeError(await outcome, "TIMEOUT")).toBe(true);
    expect(task.state).toBe("failed");
    vi.useRealTimers();
  });
});
