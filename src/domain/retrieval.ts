/**
 * Retrieval result shapes (PRD 5.7). A retrieved chunk is a stored chunk plus
 * the scoring provenance we show in source cards and use for the refusal floor.
 */

import type { StoredChunk } from "@/domain/records.js";

/**
 * One source: an article, assembled from the chunks that matched plus their
 * neighbours (PRD 5.7.4/5.7.5).
 *
 * Retrieval ranks chunks but answers from articles. Returning bare chunks made
 * a citation point at a fragment — three cards could be three slices of one
 * page, and "Sources · 6" could mean two documents. Grouping into articles
 * gives the model contiguous procedural context and the reader one card per
 * document, which is what a citation should mean.
 */
export interface RetrievedArticle {
  readonly url: string;
  readonly title: string;
  readonly headingPath: string;
  /**
   * Fused rank score, 0–1 — the weighted mean of min-max normalised dense and
   * sparse scores. This orders results *within* one query and nothing more:
   * min-max is relative, so the best hit normalises to ~1 whether the query
   * was answerable or not. Never show it, and never threshold on it.
   */
  readonly rankScore: number;
  /**
   * Best cosine similarity among its chunks — an absolute value, comparable
   * across queries. This is what the source card displays and what the refusal
   * floor (5.8.8) compares against.
   */
  readonly similarity: number | undefined;
  /** Anchor of the highest-scoring chunk, so a citation deep-links to it. */
  readonly anchor: string | undefined;
  /** Matched chunks and their neighbours, in document order. */
  readonly chunks: readonly RetrievedChunk[];
  /** Those chunks joined — the text handed to the model and previewed. */
  readonly body: string;
}

export interface RetrievedChunk extends StoredChunk {
  /**
   * Fused confidence, 0–1 — the weighted mean of min-max normalised dense and
   * sparse scores. Unlike the RRF score it replaces, this is comparable across
   * queries, so it drives both ranking and the refusal floor (5.8.8).
   */
  readonly score: number;
  /**
   * Cosine similarity to the query, 0–1. This is the number that means
   * something to a person, so it's what the source cards display; absent when
   * a chunk was found only by BM25.
   */
  readonly similarity: number | undefined;
  /** 0-based rank in the dense list, if it appeared there. */
  readonly denseRank: number | undefined;
  /** 0-based rank in the BM25 list, if it appeared there. */
  readonly sparseRank: number | undefined;
  /** True when pulled in by neighbour expansion, not a direct hit (5.7.5). */
  readonly viaNeighbour: boolean;
}

/**
 * The cosine bands that decide whether to answer, hedge, or refuse.
 *
 * Declared in the domain layer because a stored `Calibration` on `IndexMeta` is
 * a pair of these — the shape crosses the storage boundary, so it cannot live
 * above it. `retrieval/confidence.ts` owns the behaviour and re-exports the
 * type, which is where the reasoning about the numbers themselves belongs.
 */
export interface ConfidenceFloors {
  /** Below this, refuse. */
  readonly refuse: number;
  /** At or above this, answer without hedging. Between the two, hedge. */
  readonly confident: number;
}

/**
 * What one search returned.
 *
 * In the domain layer because three retrieval modules need to name it and
 * declaring it in the one that produces it made them cyclic — the cache
 * describes what it holds, the session holds a cache, and retrieval loads a
 * session.
 */
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
