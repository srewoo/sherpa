/**
 * Copy the onnxruntime-web WASM binaries into public/ort/ so they ship inside
 * the extension (PRD 5.10.1 — zero egress) rather than being pulled from a CDN
 * at runtime, which MV3 forbids as remote code.
 *
 * Only the single-threaded builds are copied. Threading needs SharedArrayBuffer
 * with COOP/COEP headers, which extension pages don't get, so the embedder sets
 * numThreads = 1 and the threaded binaries could never load — they were 19 MB
 * of an already-large store package for nothing.
 *
 * Runs from `npm run build` and `npm run dev`, so the binaries always match the
 * installed onnxruntime-web version rather than drifting.
 */

import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "node_modules", "onnxruntime-web", "dist");
const to = join(root, "public", "ort");

/** SIMD where available, plain WASM as the fallback for older CPUs. */
export const REQUIRED_ORT_FILES = ["ort-wasm-simd.wasm", "ort-wasm.wasm"];

const available = await readdir(from).catch(() => []);
if (available.length === 0) {
  throw new Error(`no onnxruntime-web dist found at ${from} — is it installed?`);
}

// Drop anything a previous build left behind, so removing a file here actually
// shrinks the package.
await rm(to, { recursive: true, force: true });
await mkdir(to, { recursive: true });

let bytes = 0;
for (const file of REQUIRED_ORT_FILES) {
  if (!available.includes(file)) {
    throw new Error(`onnxruntime-web is missing ${file} — check the installed version`);
  }
  await copyFile(join(from, file), join(to, file));
  bytes += (await stat(join(to, file))).size;
}

console.log(
  `copy-ort: ${REQUIRED_ORT_FILES.length} runtime files → public/ort/ (${(bytes / 1e6).toFixed(1)} MB)`,
);
