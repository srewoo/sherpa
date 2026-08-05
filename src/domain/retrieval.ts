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
