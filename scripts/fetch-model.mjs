/**
 * Vendor the embedding model into public/models/ (PRD 5.5.1, 5.5.8).
 *
 * The weights are committed so a clone builds offline and the extension makes
 * no network request for them at runtime. Re-run this only to change or refresh
 * the model: `npm run fetch:model`.
 */

import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODEL = "Xenova/all-MiniLM-L6-v2";
const BASE = `https://huggingface.co/${MODEL}/resolve/main`;
const FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "public", "models", MODEL);

for (const file of FILES) {
  const target = join(dest, file);
  await mkdir(dirname(target), { recursive: true });

  const existing = await stat(target).catch(() => null);
  if (existing && existing.size > 0 && !process.argv.includes("--force")) {
    console.log(`fetch-model: ${file} already present, skipping`);
    continue;
  }

  const res = await fetch(`${BASE}/${file}`);
  if (!res.ok) throw new Error(`fetch-model: ${file} → HTTP ${res.status}`);
  await writeFile(target, Buffer.from(await res.arrayBuffer()));
  console.log(`fetch-model: ${file} ✓`);
}
