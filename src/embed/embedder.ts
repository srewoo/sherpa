/**
 * On-device embedding via transformers.js (PRD 5.5.1).
 *
 * Which model runs is a user setting (see embed/models.ts); both bundled
 * options are 384-dimension, so the sharded storage layout (5.5.2) is unchanged
 * either way. Vectors from different models are not comparable, though, so the
 * model id is recorded on each index and checked before querying.
 *
 * Everything is local. The ONNX runtime and the weights ship inside the
 * extension, because MV3 treats CDN-loaded WASM as remote code and PRD 5.10.1
 * promises zero egress — once installed, embedding makes no network request.
 *
 * Browser-only (no unit test): it loads a real model. The pooling and
 * normalisation it relies on are exercised through vecmath.test.ts.
 */

import { pipeline, env } from "@xenova/transformers";
import { findModel, DEFAULT_EMBEDDING_MODEL_ID, type EmbeddingModelSpec } from "./models.js";

export { DEFAULT_EMBEDDING_MODEL_ID } from "./models.js";

/** Resolve a bundled asset to its chrome-extension:// URL. */
function assetUrl(path: string): string {
  return typeof chrome !== "undefined" && chrome.runtime?.getURL
    ? chrome.runtime.getURL(path)
    : `/${path}`;
}

export interface Embedder {
  readonly dim: number;
  readonly modelId: string;
  /** Embed passages. Returns a flat Float32Array of `texts.length * dim`. */
  embed(texts: readonly string[]): Promise<Float32Array>;
  /** Embed a search query, with whatever phrasing the model expects. */
  embedQuery(text: string): Promise<Float32Array>;
}

/** One cached instance per model, so switching back doesn't reload. */
const cache = new Map<string, Promise<Embedder>>();

/** Read the selected model without importing settings (which imports chrome). */
async function selectedModelId(): Promise<string> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    return DEFAULT_EMBEDDING_MODEL_ID;
  }
  const stored = await chrome.storage.local.get("embeddingModel");
  return (stored["embeddingModel"] as string | undefined) ?? DEFAULT_EMBEDDING_MODEL_ID;
}

/**
 * The embedder for the currently selected model, shared by crawl indexing and
 * query retrieval so the weights load only once (5.5.8).
 */
export async function getEmbedder(modelId?: string): Promise<Embedder> {
  const id = modelId ?? (await selectedModelId());
  let entry = cache.get(id);
  if (!entry) {
    entry = createEmbedder(findModel(id)).catch((err: unknown) => {
      cache.delete(id);
      throw err;
    });
    cache.set(id, entry);
  }
  return entry;
}

/**
 * Where the bundled weights live.
 *
 * Overridable so the offline eval can load the *same* weights from `public/`
 * in Node. That matters more than it looks: an eval that measures a different
 * model from the one users run is measuring nothing, and the alternative —
 * reimplementing embedding for the harness — is exactly how the two drift.
 */
export interface AssetPaths {
  readonly models: string;
  readonly ort: string;
}

export async function createEmbedder(
  spec: EmbeddingModelSpec,
  assets: AssetPaths = { models: assetUrl("models/"), ort: assetUrl("ort/") },
): Promise<Embedder> {
  // Serve weights from the bundled copy, never from the Hugging Face CDN.
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = assets.models;
  // Same for the ONNX runtime itself — without this, transformers.js pulls its
  // .wasm from jsdelivr, which MV3 blocks as remote code.
  env.backends.onnx.wasm.wasmPaths = assets.ort;
  // Threading needs SharedArrayBuffer + COOP/COEP, which extension pages don't
  // have; single-threaded SIMD is the correct build here.
  env.backends.onnx.wasm.numThreads = 1;
  // The weights are already local, and Cache.put rejects chrome-extension://
  // URLs, which logged an error on every load.
  env.useBrowserCache = false;

  const extractor = await pipeline("feature-extraction", spec.id, { quantized: true });

  const run = async (texts: readonly string[]): Promise<Float32Array> => {
    const out = await extractor(texts as string[], { pooling: spec.pooling, normalize: true });
    return out.data as Float32Array;
  };

  return {
    /**
     * The model's own dimension, not the global constant.
     *
     * This read `EMBED_DIM` — a hardcoded 384 — which made the registry's `dim`
     * field decorative and quietly wrong for any other model: vectors would be
     * written and sliced at 384 while the model produced something else, so a
     * 768-dimension model would not fail, it would return nonsense. Storage was
     * never the constraint (`vectorStore.append` takes `dim` per index and
     * records it), so the ceiling was this one line.
     */
    dim: spec.dim,
    modelId: spec.id,
    embed: run,
    embedQuery: (text) => run([spec.queryPrefix + text]),
  };
}
