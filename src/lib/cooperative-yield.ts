/** Awaiting an already resolved promise does not let Worker message tasks run.
 * Long recovery loops must periodically yield through an actual task. */
export function createCooperativeYield(budgetMs = 8) {
  let lastYieldAt = performance.now();
  return async () => {
    if (performance.now() - lastYieldAt < budgetMs) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    lastYieldAt = performance.now();
  };
}
