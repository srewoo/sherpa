import { defineConfig } from "vitest/config";

/**
 * The offline eval (`npm run eval`). Kept out of the default run: it loads real
 * ONNX weights and can take minutes, which is right for a decision and wrong
 * for every commit. It skips itself when its inputs are absent, so running it
 * without a corpus is a no-op rather than a failure.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.eval.ts"],
    globals: false,
    testTimeout: 30 * 60_000,
    hookTimeout: 30 * 60_000,
    // One corpus, one model load — parallel files would each pay for both.
    fileParallelism: false,
  },
  resolve: {
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
});
