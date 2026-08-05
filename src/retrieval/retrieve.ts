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

import type { RetrievedArticle } from "@/domain/retrieval.js";
import type { SherpaDatabase } from "@/storage/db.js";
import { normalizeInPlace, dot } from "@/embed/vecmath.js";
import { cosineTopK } from "./cosine.js";
import { loadSession, type IndexSession } from "./session.js";
import { weightedFusion, applyBoost, DENSE_WEIGHT, SPARSE_WEIGHT, EXPANDED_WEIGHT } from "./fusion.js";
import { assembleArticles, DEFAULT_ASSEMBLE, type AssembleOptions, type ScoredChunk } from "./articles.js";
import { expandQuery, DEFAULT_EXPANSION, type ExpansionOptions } from "./expansion.js";
import { hydeQuery, DEFAULT_HYDE, type HydeOptions, type Hypothesizer } from "./hyde.js";
import { applyRerank, DEFAULT_RERANK, type RerankOptions, type Reranker } from "./rerank.js";
import { sameSection } from "@/lib/url.js";

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
   * Writes a hypothetical answer to embed instead of the raw question (HyDE).
   * Optional: without it the query is embedded directly, which is what every
   * caller did before and remains the fallback whenever generation fails.
   */
  readonly hypothesize?: Hypothesizer;
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
  readonly hyde: HydeOptions;
  readonly rerank: RerankOptions;
}

export const DEFAULT_RETRIEVE: RetrieveOptions = {
  topK: 30,
  assemble: DEFAULT_ASSEMBLE,
  sectionBoost: 1.15,
  expansion: DEFAULT_EXPANSION,
  hyde: DEFAULT_HYDE,
  rerank: DEFAULT_RERANK,
};

export interface RetrieveResult {
  readonly articles: readonly RetrievedArticle[];
  /**
   * Best *absolute* cosine similarity across the results — what the refusal
   * floor compares against (PRD 5.8.8).
   *
   * Deliberately not the fused score: min-max normalisation is relative to the
   * query, so the top fused score is ~1 for every query including ones the
   * index cannot answer. Using it as a gate makes the adversarial false-answer
   * rate 100%. Ranking is relative; the answer/refuse decision has to be
   * absolute.
   */
  readonly topScore: number;
  /**
   * False when the embedder was unavailable and only BM25 ran. The caller must
   * not compare `topScore` to a cosine floor in that case — there is no cosine.
   */
  readonly denseAvailable: boolean;
}

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
   * Dense side: embed a hypothetical *answer* when a generator is available,
   * because a question and the passage answering it don't look alike (see
   * hyde.ts). Falls back to the plain question on any failure.
   */
  const denseText = deps.hypothesize
    ? await hydeQuery(query, deps.hypothesize, options.hyde)
    : query;

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
    console.warn("sherpa: embedding unavailable, falling back to keyword search", error);
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

  const ranked: ScoredChunk[] = [];
  for (const { id, confidence } of fused) {
    const chunk = session.byId.get(id);
    if (!chunk) continue;

    const boosted = deps.currentUrl && sameSection(chunk.url, deps.currentUrl)
      ? applyBoost(confidence, options.sectionBoost)
      : confidence;

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

  const articles = assembleArticles(finalOrder, session.byUrl, options.assemble);
  const topScore = articles.reduce((best, a) => Math.max(best, a.similarity ?? 0), 0);
  return { articles, topScore, denseAvailable: q !== null };
}
