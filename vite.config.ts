import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import { fileURLToPath } from "node:url";
import manifest from "./src/manifest.config.js";

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    target: "esnext",
    rollupOptions: {
      input: {
        sidepanel: "src/sidepanel/index.html",
        options: "src/options/index.html",
        offscreen: "src/offscreen/offscreen.html",
      },
    },
  },
  // transformers.js ships large wasm/model helpers; keep them external-friendly.
  optimizeDeps: { exclude: ["@xenova/transformers"] },
});
