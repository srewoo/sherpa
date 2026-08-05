import { defineConfig } from "vitest/config";

/**
 * Perf budgets (`npm run bench`). Same suite the default run includes, isolated
 * here so it can be run alone when tuning retrieval. This file was referenced by
 * package.json but missing, so `npm run bench` failed outright.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.bench.test.ts"],
    globals: false,
    testTimeout: 120_000,
  },
  resolve: {
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
});
