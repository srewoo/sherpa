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
check(
  wasmFiles.includes("ort-wasm-simd.wasm") && wasmFiles.includes("ort-wasm.wasm"),
  "dist/ort: both the SIMD build and the plain fallback must ship",
);
// Threading needs COOP/COEP, which extension pages don't have, so a threaded
// binary can never load — it would be ~10 MB of dead weight in the package.
check(
  !wasmFiles.some((f) => f.includes("threaded")),
  "dist/ort: threaded ORT builds cannot run in an extension page; don't ship them",
);

const modelDir = join(dist, "models", "Xenova", "bge-small-en-v1.5");
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
/**
 * Zero egress (PRD 5.10.1) is the product's central claim, and until now nothing
 * checked it. A `<link>` to fonts.googleapis.com sat in both entry points for
 * the life of the project: a render-blocking third-party request on every panel
 * open, and a privacy promise broken on every page load. Neither unit tests nor
 * a CSP check can see it — `script-src 'self'` blocks remote *scripts*, not
 * remote stylesheets, fonts or images.
 *
 * So HTML and CSS are scanned for absolute http(s) references. Those two are
 * scanned and JS is not, deliberately: a URL in markup is a fetch the browser
 * performs unconditionally on load, while a URL in a bundle is a string that
 * may never be called — transformers.js carries CDN fallbacks it never reaches
 * once `wasmPaths` and `localModelPath` are set, which the checks above already
 * assert. Scanning JS too would mean an allowlist long enough that a real
 * regression could hide in it.
 */
/**
 * XML namespaces only. `xmlns="http://www.w3.org/2000/svg"` appears inside the
 * inline SVG data-URIs in the stylesheet; a namespace is an identifier the
 * parser compares as a string and never resolves, so it generates no request.
 * Nothing else is permitted — a fetchable remote origin in markup is the bug
 * this check exists to catch.
 */
const REMOTE_ALLOWED = new Set(["http://www.w3.org", "https://www.w3.org"]);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const remoteHits = [];
for await (const file of walk(dist)) {
  if (!/\.(html|css)$/.test(file)) continue;
  const text = await readFile(file, "utf8");
  for (const match of text.matchAll(/https?:\/\/[a-z0-9.-]+/gi)) {
    const origin = match[0];
    // Exact match, not a prefix: `startsWith("https://www.w3.org")` would also
    // wave through `https://www.w3.org.example.com`.
    if (REMOTE_ALLOWED.has(origin)) continue;
    remoteHits.push(`${file.slice(dist.length + 1)} → ${origin}`);
  }
}

check(
  remoteHits.length === 0,
  "dist: remote origin referenced in shipped assets — this breaks the zero-egress promise:\n  " +
    [...new Set(remoteHits)].slice(0, 10).join("\n  "),
);

if (failures.length > 0) {
  console.error("verify-bundle: FAILED\n");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}

console.log(
  `verify-bundle: ok — CSP allows wasm, ${wasmFiles.length} runtime binaries and the model ship locally, no remote origins`,
);
