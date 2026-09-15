/**
 * Hybrid retrieval (PRD 5.7).
 *
 * Dense cosine and field-weighted BM25 each produce a ranked list; both are
 * min-max normalised and combined as a weighted mean, which orders results far
 * better than rank-only fusion. Chunks are then assembled into articles with
 * their neighbours, so an answer cites documents rather than fragments.
 *
 * Two scores, kept strictly apart: the fused score *ranks* (relative to the
 * query), and raw cosine *decides* (absolute, comparable across queries). See
 * RetrieveResult.topScore.
 *
 * Index data comes from a cached session rather than IndexedDB reads per query
 * — that is what keeps p95 inside the 150 ms budget at 15k chunks (5.7.6). The
 * embedder and session are injected so this is testable without a browser.
 */

import type { RetrievedArticle, RetrieveResult } from "@/domain/retrieval.js";
import type { SherpaDatabase } from "@/storage/db.js";
import type { StoredChunk } from "@/domain/records.js";
import { normalizeInPlace, dot } from "@/embed/vecmath.js";
import { cosineTopK } from "./cosine.js";
import { loadSession, type IndexSession } from "./session.js";
import { weightedFusion, applyBoost, DENSE_WEIGHT, SPARSE_WEIGHT, EXPANDED_WEIGHT } from "./fusion.js";
import { assembleArticles, DEFAULT_ASSEMBLE, type AssembleOptions, type ScoredChunk } from "./articles.js";
import { expandQuery, DEFAULT_EXPANSION, type ExpansionOptions } from "./expansion.js";
import { applyRerank, DEFAULT_RERANK, type RerankOptions, type Reranker } from "./rerank.js";
import { priorBoosts, type PriorIndex } from "./prior.js";
import { sameSection } from "@/lib/url.js";
import { log } from "@/lib/log.js";

export interface Embedderish {
  readonly dim: number;
  embed(texts: readonly string[]): Promise<Float32Array>;
  /** Some models want queries phrased differently from passages. */
  embedQuery?(text: string): Promise<Float32Array>;
}

export interface RetrieveDeps {
  readonly db: SherpaDatabase;
  readonly indexId: string;
  readonly embedder: Embedderish;
  /** Prebuilt session; loaded from the per-index cache when omitted. */
  readonly session?: IndexSession;
  /**
   * The page the user is reading, when the panel knows it. Pages in the same
   * section are nudged up — asking from the Asset Hub docs should favour Asset
   * Hub answers.
   */
  readonly currentUrl?: string;
  /**
   * Restrict results to a single page.
   *
   * Set when the user picked a refinement chip. Unlike `currentUrl` — a nudge
   * for a page they happen to be reading — this is a filter, because they named
   * the document explicitly. It also makes the pick terminal: one page cannot
   * scatter, so `chooseRefinements` returns nothing and the old ask-again loop
   * has no state to re-enter.
   */
  readonly focusUrl?: string;
  /**
   * Pages this index has learned are the answer to questions like this one
   * (prior.ts). Ranking only — never applied to `similarity`.
   */
  readonly priors?: PriorIndex;
  /** Injected so decay is testable without controlling the clock. */
  readonly now?: number;
  /**
   * Text for the *dense* half to embed instead of the raw question — a HyDE
   * passage, when one was produced. Precomputed by `understand.ts` rather than
   * generated here: retrieval used to make its own model call mid-search, which
   * put a network round trip inside a function the perf budget measures and
   * made the search untestable without a fake generator.
   */
  readonly denseText?: string;
  /**
   * Cross-encoder that rescores the top candidates (see rerank.ts). Optional:
   * the weights are an explicit opt-in, and without it first-stage ranking
   * stands unchanged.
   */
  readonly rerank?: Reranker;
}

export interface RetrieveOptions {
  /** Candidates drawn from each retriever before fusion. */
  readonly topK: number;
  readonly assemble: AssembleOptions;
  /** Multiplier for a chunk on the same section as the page being read. */
  readonly sectionBoost: number;
  /** Pseudo-relevance feedback for the sparse half. Set maxTerms to 0 to disable. */
  readonly expansion: ExpansionOptions;
  readonly rerank: RerankOptions;
}

export const DEFAULT_RETRIEVE: RetrieveOptions = {
  topK: 30,
  assemble: DEFAULT_ASSEMBLE,
  sectionBoost: 1.15,
  expansion: DEFAULT_EXPANSION,
  rerank: DEFAULT_RERANK,
};

/**
 * Re-exported from `domain/retrieval.ts`, where it is declared.
 *
 * It moved to break the last real import cycle: `cache.ts` needs the shape to
 * describe what it caches, `session.ts` needs the cache, and `retrieve.ts`
 * needs the session — so declaring the shape here made the three mutually
 * dependent for the sake of one type. A result shape is domain vocabulary; the
 * retrieval that produces one stays here.
 */
export type { RetrieveResult };

/**
 * Rescore the head of the ranked list with the cross-encoder.
 *
 * Candidates are keyed by vector id, which is unique per chunk — reranking a
 * list keyed by anything coarser would collapse chunks from the same page.
 */
async function rerankRanked(
  rerank: Reranker,
  query: string,
  ranked: readonly ScoredChunk[],
  options: RerankOptions,
): Promise<ScoredChunk[]> {
  try {
    const head = ranked.slice(0, options.topN);
    if (head.length === 0) return [...ranked];
    const scores = await rerank(
      query,
      head.map((r) => ({ id: r.chunk.vectorId, text: r.chunk.body })),
    );
    const withIds = ranked.map((r) => ({ ...r, id: r.chunk.vectorId }));
    return applyRerank(withIds, scores, options.topN);
  } catch {
    // Reranking is an enhancement; losing it must not lose the search.
    return [...ranked];
  }
}

/**
 * Every chunk of one page, ranked ones first.
 *
 * A pick is an explicit instruction to read *this document*, so the page is
 * always returned in full even where retrieval only surfaced part of it —
 * otherwise the answer is drawn from whichever fragments happened to match the
 * chip's wording rather than from the page the user chose.
 */
function scopeToPage(
  ranked: readonly ScoredChunk[],
  pageChunks: readonly StoredChunk[] | undefined,
  similarityOf: (vectorId: number) => number | undefined,
): ScoredChunk[] {
  // No such page in this index — a stale URL costs the scoping, not the answer.
  if (!pageChunks || pageChunks.length === 0) return [...ranked];

  const byVectorId = new Map(ranked.map((r) => [r.chunk.vectorId, r]));
  const scored = pageChunks
    .filter((c) => byVectorId.has(c.vectorId))
    .map((c) => byVectorId.get(c.vectorId) as ScoredChunk)
    .sort((a, b) => b.rankScore - a.rankScore);

  const rest: ScoredChunk[] = pageChunks
    .filter((c) => !byVectorId.has(c.vectorId))
    .map((chunk) => ({
      chunk,
      // Below anything the retrievers ranked, so it never displaces a real hit.
      rankScore: 0,
      // Measured, never assumed — `topScore` and the source card read this.
      similarity: similarityOf(chunk.vectorId),
      // Neither retriever surfaced these, and saying so is the honest answer.
      denseRank: undefined,
      sparseRank: undefined,
    }));

  return [...scored, ...rest];
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
  if (count === 0) return { articles: [], topScore: 0, denseAvailable: true };

  /**
   * Dense side: embed the HyDE passage when `understand` produced one, because
   * a question and the passage answering it don't look alike (see hyde.ts).
   * Absent — no model, HyDE off, or a rejected generation — means the plain
   * query, which is the behaviour every caller had before HyDE existed.
   */
  const denseText = deps.denseText ?? query;

  /**
   * Embedding can fail for reasons that have nothing to do with the query:
   * Chrome evicts the model under disk pressure, the WASM backend fails to
   * compile, an index was built by a different model. Any of those used to
   * throw straight out of `retrieve` and take the whole search with it —
   * a keyword search that would have worked fine never ran.
   */
  let q: Float32Array | null = null;
  try {
    const embedded = deps.embedder.embedQuery
      ? await deps.embedder.embedQuery(denseText)
      : await deps.embedder.embed([denseText]);
    q = embedded.slice(0, dim);
    normalizeInPlace(q);
  } catch (error) {
    log.warn("dense_unavailable_keyword_fallback", { error: String(error) });
  }

  const dense = q ? cosineTopK(q, data, dim, count, options.topK) : [];

  /**
   * Sparse side: run once, borrow the vocabulary of the top hits, run again.
   * BM25 cannot match a term the user didn't type, and users don't type the
   * docs' nouns — this is where "two way role play" learns "avatar".
   */
  const firstPass = session.bm25.search(query, options.topK);
  const feedback = firstPass
    .slice(0, options.expansion.feedbackDocs)
    .map((hit) => session.byId.get(hit.id)?.text ?? "")
    .filter(Boolean);
  const expanded = expandQuery(query, feedback, options.expansion);
  // The expanded query is a *separate* retriever, not a replacement: borrowed
  // vocabulary must not outvote the words the user actually typed.
  const sparseExpanded =
    expanded === query ? [] : session.bm25.search(expanded, options.topK);

  const fused = weightedFusion([
    { results: dense, weight: DENSE_WEIGHT },
    { results: firstPass, weight: SPARSE_WEIGHT },
    ...(sparseExpanded.length > 0
      ? [{ results: sparseExpanded, weight: EXPANDED_WEIGHT }]
      : []),
  ]);

  const denseRanks = rankMap(dense.map((d) => d.id));
  const sparseRanks = rankMap(firstPass.map((s) => s.id));

  // Cosine for the dense top-k is already known; anything else we surface gets
  // measured, never guessed from its rank.
  const similarity = new Map(dense.map((d) => [d.id, d.score]));
  const similarityOf = (vectorId: number): number | undefined => {
    // Without a query vector there is nothing to measure against; the caller
    // reads `denseAvailable` and skips the cosine floor entirely.
    if (!q) return undefined;
    const known = similarity.get(vectorId);
    if (known !== undefined) return known;
    if (vectorId < 0 || vectorId >= count) return undefined;
    const measured = dot(data, q, vectorId * dim, dim);
    similarity.set(vectorId, measured);
    return measured;
  };

  /**
   * Learned preferences from past picks. Applied to the rank score alongside
   * the section boost and, like it, never to `similarity` — the refusal floor
   * must decide on the same absolute cosine whatever the index has learned.
   */
  const boosts = deps.priors
    ? priorBoosts(query, deps.priors, deps.now ?? Date.now())
    : undefined;

  const ranked: ScoredChunk[] = [];
  for (const { id, confidence } of fused) {
    const chunk = session.byId.get(id);
    if (!chunk) continue;

    let boosted = confidence;
    if (deps.currentUrl && sameSection(chunk.url, deps.currentUrl)) {
      boosted = applyBoost(boosted, options.sectionBoost);
    }
    const prior = boosts?.get(chunk.url);
    if (prior !== undefined) boosted = applyBoost(boosted, prior);

    ranked.push({
      chunk,
      rankScore: boosted,
      similarity: similarityOf(id),
      denseRank: denseRanks.get(id),
      sparseRank: sparseRanks.get(id),
    });
  }
  // The boost can reorder, so sort after applying it.
  ranked.sort((a, b) => b.rankScore - a.rankScore);

  /**
   * Second stage. Reordering only — `similarity` is untouched, so the refusal
   * floor still decides on the same absolute cosine it always did, and a
   * reranker cannot argue Sherpa into answering something it would refuse.
   * A failure here (missing weights, a slow load) leaves first-stage order.
   */
  const finalOrder = deps.rerank
    ? await rerankRanked(deps.rerank, query, ranked, options.rerank)
    : ranked;

  /**
   * Scope to the chosen page, if there is one.
   *
   * Taken from the index (`session.byUrl`) rather than by filtering the ranked
   * candidates. Filtering looks equivalent and isn't: `finalOrder` is the *fused
   * top-k*, so a page whose chunks didn't make that cut would silently fall back
   * to unscoped results — the user picks one document and is answered from a
   * different one, believing they scoped. Reading the page directly means a
   * pick always returns the page that was picked.
   *
   * Chunks already ranked keep their scores and order; the rest are appended in
   * document order so the whole page is available to the generator.
   */
  const scoped = deps.focusUrl
    ? scopeToPage(finalOrder, session.byUrl.get(deps.focusUrl), similarityOf)
    : finalOrder;

  const articles = assembleArticles(scoped, session.byUrl, options.assemble);
  const topScore = articles.reduce((best, a) => Math.max(best, a.similarity ?? 0), 0);
  return { articles, topScore, denseAvailable: q !== null };
}
