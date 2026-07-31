/**
 * Copy the onnxruntime-web WASM binaries into public/ort/ so they ship inside
 * the extension (PRD 5.10.1 — zero egress) rather than being pulled from a CDN
 * at runtime, which MV3 forbids as remote code.
 *
 * Runs from `npm run build` and `npm run dev`, so the binaries always match the
 * installed onnxruntime-web version rather than drifting.
 */

import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "node_modules", "onnxruntime-web", "dist");
const to = join(root, "public", "ort");

await mkdir(to, { recursive: true });

const entries = await readdir(from);
const wanted = entries.filter((f) => f.endsWith(".wasm") || f === "ort-wasm-threaded.worker.js");

if (wanted.length === 0) {
  throw new Error(`no onnxruntime-web wasm binaries found in ${from} — is it installed?`);
}

for (const file of wanted) {
  await copyFile(join(from, file), join(to, file));
}

console.log(`copy-ort: ${wanted.length} runtime files → public/ort/`);
