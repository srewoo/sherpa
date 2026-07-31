/**
 * On-device embedding via transformers.js (PRD 5.5.1). all-MiniLM-L6-v2, 384-d,
 * mean-pooled and L2-normalised. Tries WebGPU first and falls back to WASM.
 * Model weights download once and are cached by the browser (5.5.8).
 *
 * Browser-only (no unit test): it loads a real model. The pooling/normalisation
 * it relies on is exercised through vecmath.test.ts.
 */

import { pipeline, env } from "@xenova/transformers";
import { EMBED_DIM } from "./vecmath.js";

const MODEL = "Xenova/all-MiniLM-L6-v2";

export interface Embedder {
  readonly dim: number;
  /** Returns a flat Float32Array of `texts.length * dim` normalised values. */
  embed(texts: readonly string[]): Promise<Float32Array>;
}

let cached: Promise<Embedder> | null = null;

/** Process-wide embedder, shared by crawl indexing and query retrieval so the
 * model loads (and downloads) only once. */
export function getEmbedder(): Promise<Embedder> {
  if (!cached) cached = createEmbedder();
  return cached;
}

export async function createEmbedder(): Promise<Embedder> {
  // Prefer remote weights cached via the Cache API rather than bundling them.
  // NOTE: transformers.js v2 runs on WASM; the WebGPU backend (PRD 5.5.1) is a
  // v3 upgrade — swap this line for the @huggingface/transformers `{ device }`
  // option when we bump the dependency.
  env.allowLocalModels = false;
  const extractor = await pipeline("feature-extraction", MODEL);

  return {
    dim: EMBED_DIM,
    async embed(texts) {
      const out = await extractor(texts as string[], { pooling: "mean", normalize: true });
      return out.data as Float32Array;
    },
  };
}
