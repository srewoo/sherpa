/**
 * On-device embedding via transformers.js (PRD 5.5.1). all-MiniLM-L6-v2, 384-d,
 * mean-pooled and L2-normalised.
 *
 * Everything is local. The ONNX runtime's WASM binaries and the model weights
 * both ship inside the extension (see scripts/copy-ort.mjs and
 * scripts/fetch-model.mjs), because MV3 treats CDN-loaded WASM as remote code
 * and because PRD 5.10.1 promises zero egress in the default configuration —
 * once installed, embedding makes no network request at all.
 *
 * Browser-only (no unit test): it loads a real model. The pooling/normalisation
 * it relies on is exercised through vecmath.test.ts.
 */

import { pipeline, env } from "@xenova/transformers";
import { EMBED_DIM } from "./vecmath.js";

const MODEL = "Xenova/all-MiniLM-L6-v2";

/** Resolve a bundled asset to its chrome-extension:// URL. */
function assetUrl(path: string): string {
  return typeof chrome !== "undefined" && chrome.runtime?.getURL
    ? chrome.runtime.getURL(path)
    : `/${path}`;
}

export interface Embedder {
  readonly dim: number;
  /** Returns a flat Float32Array of `texts.length * dim` normalised values. */
  embed(texts: readonly string[]): Promise<Float32Array>;
}

let cached: Promise<Embedder> | null = null;

/** Process-wide embedder, shared by crawl indexing and query retrieval so the
 * model loads only once (5.5.8). */
export function getEmbedder(): Promise<Embedder> {
  if (!cached) cached = createEmbedder();
  return cached;
}

export async function createEmbedder(): Promise<Embedder> {
  // Serve weights from the bundled copy, never from the Hugging Face CDN.
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = assetUrl("models/");
  // The weights already live inside the extension, so there is nothing to gain
  // from copying them into the Cache API — and Cache.put rejects
  // chrome-extension:// URLs outright, which is what logs
  // "Request scheme 'chrome-extension' is unsupported" on every load.
  env.useBrowserCache = false;
  // Same for the ONNX runtime itself — without this, transformers.js pulls its
  // .wasm from jsdelivr, which MV3 blocks as remote code.
  env.backends.onnx.wasm.wasmPaths = assetUrl("ort/");
  // Threading needs SharedArrayBuffer + COOP/COEP, which extension pages don't
  // have; single-threaded SIMD is the correct build here.
  env.backends.onnx.wasm.numThreads = 1;

  const extractor = await pipeline("feature-extraction", MODEL, { quantized: true });

  return {
    dim: EMBED_DIM,
    async embed(texts) {
      const out = await extractor(texts as string[], { pooling: "mean", normalize: true });
      return out.data as Float32Array;
    },
  };
}
