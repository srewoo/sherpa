/**
 * Post-build checks for the two failure modes that don't show up in unit tests
 * and don't show up until you load the extension in Chrome:
 *
 *  1. Missing `wasm-unsafe-eval` in the CSP — MV3's default policy blocks
 *     WebAssembly outright, so the embedder throws on first use and nothing
 *     can be indexed or queried.
 *  2. Assets fetched from a CDN at runtime — remote code is forbidden by MV3,
 *     breaks the zero-egress promise (PRD 5.10.1), and fails Web Store review.
 *
 * Both are cheap to assert and expensive to discover manually, so CI does it.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

// ---------------------------------------------------------------- manifest
const manifest = JSON.parse(await readFile(join(dist, "manifest.json"), "utf8"));

const csp = manifest.content_security_policy?.extension_pages ?? "";
check(
  csp.includes("wasm-unsafe-eval"),
  "manifest: content_security_policy.extension_pages must include 'wasm-unsafe-eval' — " +
    "onnxruntime cannot compile the embedding model without it",
);
check(
  csp.includes("script-src 'self'"),
  "manifest: script-src must stay 'self' so no remote script can load",
);
check(
  !JSON.stringify(manifest.host_permissions ?? []).includes("*://*/*"),
  "manifest: host access must stay per-site and optional (PRD 5.10.3)",
);

const war = JSON.stringify(manifest.web_accessible_resources ?? []);
check(war.includes("ort/"), "manifest: the ONNX runtime must be web-accessible");
check(war.includes("models/"), "manifest: the model weights must be web-accessible");

// ------------------------------------------------------------------ assets
async function exists(path) {
  return stat(path).then(
    () => true,
    () => false,
  );
}

const wasmDir = join(dist, "ort");
const wasmFiles = (await exists(wasmDir)) ? (await readdir(wasmDir)).filter((f) => f.endsWith(".wasm")) : [];
check(
  wasmFiles.length > 0,
  "dist/ort: no .wasm binaries bundled — run scripts/copy-ort.mjs before building",
);

const modelDir = join(dist, "models", "Xenova", "all-MiniLM-L6-v2");
check(await exists(join(modelDir, "onnx", "model_quantized.onnx")), "dist/models: model weights missing");
check(await exists(join(modelDir, "tokenizer.json")), "dist/models: tokenizer missing");
check(await exists(join(modelDir, "config.json")), "dist/models: config missing");

// ------------------------------------------------------- no runtime CDN use
/**
 * transformers.js falls back to jsdelivr for its WASM and to huggingface.co for
 * weights unless both paths are overridden. The strings survive in the bundle
 * either way, so we check that the overrides are present rather than that the
 * hosts are absent.
 */
async function jsFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await jsFiles(path)));
    else if (entry.name.endsWith(".js")) out.push(path);
  }
  return out;
}

const bundles = await jsFiles(join(dist, "assets"));
let sawWasmPathOverride = false;
let sawLocalModelPath = false;

for (const file of bundles) {
  const source = await readFile(file, "utf8");
  if (source.includes("wasmPaths")) sawWasmPathOverride = true;
  if (source.includes("localModelPath")) sawLocalModelPath = true;
}

check(sawWasmPathOverride, "bundle: env.backends.onnx.wasm.wasmPaths is never set — ORT will fetch from a CDN");
check(sawLocalModelPath, "bundle: env.localModelPath is never set — weights will be fetched from Hugging Face");

// ----------------------------------------------------------------- verdict
if (failures.length > 0) {
  console.error("verify-bundle: FAILED\n");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}

console.log(
  `verify-bundle: ok — CSP allows wasm, ${wasmFiles.length} runtime binaries and the model ship locally`,
);
