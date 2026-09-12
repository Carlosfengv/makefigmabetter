import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      "output/**",
      // This file intentionally uses Node's native test runner because its
      // production gate executes it with `node --test`.
      "scripts/create-figma-visual-baseline.test.mjs",
    ],
  },
});
