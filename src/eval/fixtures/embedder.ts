/**
 * A deterministic stand-in embedder for the eval harness and the perf bench.
 *
 * It is a hashing bag-of-words projection, not a semantic model: loading real
 * MiniLM weights in Node would make the suite slow and non-hermetic, and CI
 * needs to run on every change. What it preserves is everything the harness is
 * actually measuring — vector shape, L2-normalised cosine behaviour, the RRF
 * fusion of dense and sparse ranks, page dedupe, neighbour expansion and the
 * refusal floor. Semantic recall of the real model is measured separately,
 * against live sites, per §7.1.
 */

import { tokenize } from "@/retrieval/bm25.js";

export const FIXTURE_DIM = 256;

function hash(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % FIXTURE_DIM;
}

/** Sub-token shingles let near-misses ("invoices"/"invoice") share dimensions. */
function features(text: string): string[] {
  const out: string[] = [];
  for (const token of tokenize(text)) {
    out.push(token);
    if (token.length > 4) out.push(token.slice(0, 4));
  }
  return out;
}

export function embedOne(text: string): Float32Array {
  const v = new Float32Array(FIXTURE_DIM);
  for (const f of features(text)) {
    const slot = hash(f);
    v[slot] = (v[slot] ?? 0) + 1;
  }

  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}

export const fixtureEmbedder = {
  dim: FIXTURE_DIM,
  async embed(texts: readonly string[]): Promise<Float32Array> {
    const out = new Float32Array(texts.length * FIXTURE_DIM);
    texts.forEach((t, i) => out.set(embedOne(t), i * FIXTURE_DIM));
    return out;
  },
};
