import { afterEach, expect, it, vi } from "vitest";
import { createCooperativeYield } from "./cooperative-yield";

afterEach(() => vi.restoreAllMocks());

it("lets paint and input tasks run before a large immediate replay queue finishes", async () => {
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const yieldToTasks = createCooperativeYield();
  let completed = 0;
  const checkpoints: number[] = [];
  const paint = new Promise<void>((resolve) => setTimeout(() => {
    checkpoints.push(completed);
    setTimeout(() => { checkpoints.push(completed); resolve(); }, 0);
  }, 0));
  for (let index = 0; index < 6_196; index += 1) {
    await yieldToTasks();
    // Rejected intents and cached crypto promises can both complete without
    // yielding a browser task; exercise that same sequence here.
    await Promise.resolve();
    elapsed += 1;
    completed += 1;
  }
  await paint;
  expect(completed).toBe(6_196);
  expect(checkpoints).toHaveLength(2);
  expect(checkpoints[0]).toBeGreaterThan(0);
  expect(checkpoints[1]).toBeGreaterThan(checkpoints[0]!);
  expect(checkpoints[1]).toBeLessThan(completed);
});

it("does not add a timer for work that is still within the time budget", async () => {
  vi.spyOn(performance, "now").mockReturnValue(0);
  const timers = vi.spyOn(globalThis, "setTimeout");
  const yieldToTasks = createCooperativeYield();
  await yieldToTasks();
  await yieldToTasks();
  expect(timers).not.toHaveBeenCalled();
});
