/**
 * Vendor the cross-encoder reranker into public/models/ (optional).
 *
 * Unlike the embedding model, this one is NOT required: retrieval works without
 * it and simply skips reranking when the weights are absent. It is fetched by
 * an explicit `npm run fetch:reranker` rather than by the build, because it
 * adds ~23 MB to the extension package and the benefit is workload-dependent.
 *
 * Like the embedder, once vendored it is served from inside the extension —
 * the zero-egress promise (PRD 5.10.1) applies to it too.
 */

import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";
const BASE = `https://huggingface.co/${MODEL}/resolve/main`;
const FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "public", "models", MODEL);

for (const file of FILES) {
  const target = join(dest, file);
  await mkdir(dirname(target), { recursive: true });

  const existing = await stat(target).catch(() => null);
  if (existing && existing.size > 0 && !process.argv.includes("--force")) {
    console.log(`fetch-reranker: ${file} already present, skipping`);
    continue;
  }

  const res = await fetch(`${BASE}/${file}`);
  if (!res.ok) throw new Error(`fetch-reranker: ${file} → HTTP ${res.status}`);
  await writeFile(target, Buffer.from(await res.arrayBuffer()));
  console.log(`fetch-reranker: ${file} ✓`);
}

console.log(`fetch-reranker: done → public/models/${MODEL}`);
