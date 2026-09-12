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
