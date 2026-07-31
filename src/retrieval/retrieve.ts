/**
 * Hybrid retrieval (PRD 5.7). Dense cosine + BM25, fused with Reciprocal Rank
 * Fusion, deduped by page, neighbour-expanded so procedures aren't truncated
 * mid-steps. The top dense score gates the refusal path (5.8.8).
 *
 * All index data comes from a cached session (see session.ts) rather than
 * IndexedDB reads per query — that is what keeps p95 inside the 150 ms budget
 * at 15k chunks (5.7.6). The embedder and session are injected so this is
 * unit-testable without a browser.
 */

import type { RetrievedChunk } from "@/domain/retrieval.js";
import type { StoredChunk } from "@/domain/records.js";
import type { SherpaDatabase } from "@/storage/db.js";
import { normalizeInPlace } from "@/embed/vecmath.js";
import { reciprocalRankFusion } from "@/lib/rrf.js";
import { cosineTopK } from "./cosine.js";
import { loadSession, type IndexSession } from "./session.js";

export interface Embedderish {
  readonly dim: number;
  embed(texts: readonly string[]): Promise<Float32Array>;
}

export interface RetrieveDeps {
  readonly db: SherpaDatabase;
  readonly indexId: string;
  readonly embedder: Embedderish;
  /** Prebuilt session; loaded from the per-index cache when omitted. */
  readonly session?: IndexSession;
}

export interface RetrieveOptions {
  readonly topK: number; // candidates per retriever
  readonly topN: number; // direct hits kept for generation
  readonly neighbourSpan: number;
  /** Max direct hits from any one page, so a single long article can't fill
   * the context and crowd out other pages an answer needs (PRD 5.7.4). */
  readonly maxPerPage: number;
}

export const DEFAULT_RETRIEVE: RetrieveOptions = {
  topK: 20,
  topN: 6,
  neighbourSpan: 1,
  maxPerPage: 2,
};

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
  const session = deps.session ?? (await loadSession(deps.db, deps.indexId));
  const { data, dim, count } = session.vectors;
  if (count === 0) return { chunks: [], topScore: 0 };

  const q = (await deps.embedder.embed([query])).slice(0, dim);
  normalizeInPlace(q);
  const dense = cosineTopK(q, data, dim, count, options.topK);
  const sparse = session.bm25.search(query, options.topK);

  const fused = reciprocalRankFusion([
    { ids: dense.map((d) => d.id) },
    { ids: sparse.map((s) => s.id) },
  ]);
  const denseRanks = rankMap(dense.map((d) => d.id));
  const sparseRanks = rankMap(sparse.map((s) => s.id));

  const seen = new Set<number>();
  const perPage = new Map<string, number>();
  const out: RetrievedChunk[] = [];
  let kept = 0;

  for (const { id, score } of fused) {
    if (kept >= options.topN) break;
    const chunk = session.byId.get(id);
    if (!chunk || seen.has(id)) continue;

    // Page-level dedupe (5.7.4).
    const used = perPage.get(chunk.url) ?? 0;
    if (used >= options.maxPerPage) continue;
    perPage.set(chunk.url, used + 1);

    seen.add(id);
    kept += 1;
    out.push(toHit(chunk, score, denseRanks.get(id), sparseRanks.get(id)));

    for (const nb of neighbours(session, chunk, options.neighbourSpan)) {
      if (seen.has(nb.vectorId)) continue;
      seen.add(nb.vectorId);
      out.push(toNeighbour(nb, score));
    }
  }

  // The refusal floor (5.8.8) compares against a cosine-scale confidence — the
  // best dense similarity — not the tiny RRF score used only for ranking.
  return { chunks: out, topScore: dense[0]?.score ?? 0 };
}

/** Adjacent chunks of the same page (PRD 5.7.5), straight from the session. */
function neighbours(session: IndexSession, chunk: StoredChunk, span: number): StoredChunk[] {
  const page = session.byUrl.get(chunk.url) ?? [];
  return page.filter(
    (c) => c.position !== chunk.position && Math.abs(c.position - chunk.position) <= span,
  );
}

function toHit(c: StoredChunk, score: number, dRank?: number, sRank?: number): RetrievedChunk {
  return { ...c, score, denseRank: dRank, sparseRank: sRank, viaNeighbour: false };
}

function toNeighbour(c: StoredChunk, score: number): RetrievedChunk {
  return { ...c, score, denseRank: undefined, sparseRank: undefined, viaNeighbour: true };
}
