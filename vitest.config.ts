import { defineConfig } from "vitest/config";

// Unit tests run in Node. Modules that touch chrome.* or IndexedDB pull in
// `fake-indexeddb/auto` at the top of their own test file, so the default
// environment stays lightweight.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: false,
  },
  resolve: {
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
});
