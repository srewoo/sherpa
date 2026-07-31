/**
 * Hybrid retrieval (PRD 5.7). Dense cosine + BM25, fused with Reciprocal Rank
 * Fusion, deduped, neighbour-expanded so procedures aren't truncated mid-steps.
 * The top fused score gates the refusal path (5.8.8). The embedder and an
 * optional prebuilt BM25 index are injected so this is unit-testable.
 */

import type { RetrievedChunk } from "@/domain/retrieval.js";
import type { StoredChunk } from "@/domain/records.js";
import type { SherpaDatabase } from "@/storage/db.js";
import { vectorStore } from "@/storage/vectors.js";
import { chunkStore } from "@/storage/chunks.js";
import { normalizeInPlace } from "@/embed/vecmath.js";
import { reciprocalRankFusion } from "@/lib/rrf.js";
import { cosineTopK } from "./cosine.js";
import { Bm25Index } from "./bm25.js";

export interface Embedderish {
  readonly dim: number;
  embed(texts: readonly string[]): Promise<Float32Array>;
}

export interface RetrieveDeps {
  readonly db: SherpaDatabase;
  readonly indexId: string;
  readonly embedder: Embedderish;
  /** Prebuilt/cached BM25; built from chunk texts when omitted. */
  readonly bm25?: Bm25Index;
}

export interface RetrieveOptions {
  readonly topK: number; // candidates per retriever
  readonly topN: number; // direct hits kept for generation
  readonly neighbourSpan: number;
}

export const DEFAULT_RETRIEVE: RetrieveOptions = { topK: 20, topN: 6, neighbourSpan: 1 };

export interface RetrieveResult {
  readonly chunks: readonly RetrievedChunk[];
  readonly topScore: number;
}

function rankMap(ids: readonly number[]): Map<number, number> {
  const m = new Map<number, number>();
  ids.forEach((id, i) => m.set(id, i));
  return m;
}

export async function retrieve(
  deps: RetrieveDeps,
  query: string,
  options: RetrieveOptions = DEFAULT_RETRIEVE,
): Promise<RetrieveResult> {
  const { db, indexId } = deps;
  const { data, dim, count } = await vectorStore.load(db, indexId);
  if (count === 0) return { chunks: [], topScore: 0 };

  const q = (await deps.embedder.embed([query])).slice(0, dim);
  normalizeInPlace(q);
  const dense = cosineTopK(q, data, dim, count, options.topK);

  const all = await db.getAllFromIndex("chunks", "byIndex", indexId);
  const bm25 = deps.bm25 ?? new Bm25Index(all.map((c) => ({ id: c.vectorId, text: c.text })));
  const sparse = bm25.search(query, options.topK);

  const fused = reciprocalRankFusion([
    { ids: dense.map((d) => d.id) },
    { ids: sparse.map((s) => s.id) },
  ]);
  const denseRanks = rankMap(dense.map((d) => d.id));
  const sparseRanks = rankMap(sparse.map((s) => s.id));

  const topFused = fused.slice(0, options.topN);
  const byId = new Map(all.map((c) => [c.vectorId, c]));
  const seen = new Set<number>();
  const out: RetrievedChunk[] = [];

  for (const { id, score } of topFused) {
    const chunk = byId.get(id);
    if (!chunk || seen.has(id)) continue;
    seen.add(id);
    out.push(toHit(chunk, score, denseRanks.get(id), sparseRanks.get(id)));
    for (const nb of await chunkStore.neighbours(db, chunk, options.neighbourSpan)) {
      if (seen.has(nb.vectorId)) continue;
      seen.add(nb.vectorId);
      out.push(toNeighbour(nb, score));
    }
  }

  // Refusal (5.8.8) compares against a cosine-scale confidence — the best dense
  // similarity — not the tiny RRF fusion score used only for ranking.
  return { chunks: out, topScore: dense[0]?.score ?? 0 };
}

function toHit(c: StoredChunk, score: number, dRank?: number, sRank?: number): RetrievedChunk {
  return { ...c, score, denseRank: dRank, sparseRank: sRank, viaNeighbour: false };
}

function toNeighbour(c: StoredChunk, score: number): RetrievedChunk {
  return { ...c, score, denseRank: undefined, sparseRank: undefined, viaNeighbour: true };
}
