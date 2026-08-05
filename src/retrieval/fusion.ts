/**
 * Score fusion for hybrid retrieval (PRD 5.7.1).
 *
 * Reciprocal Rank Fusion — what this replaces — combines by *position* and
 * discards magnitude, so a runaway best match and a marginal one both come out
 * near 1/(60+rank). That left no usable confidence signal, which forced the
 * refusal floor (5.8.8) onto raw cosine: a scale that shifts with the embedding
 * model and produced figures no user could interpret.
 *
 * Instead each retriever's scores are min-max normalised to 0–1 and combined as
 * a weighted mean. The output is a comparable confidence on a fixed scale, so
 * ranking and the refusal decision can share it. This mirrors the
 * normalization-processor OpenSearch runs server-side for hybrid queries.
 */

export interface ScoredId {
  readonly id: number;
  readonly score: number;
}

export interface RetrieverResults {
  readonly results: readonly ScoredId[];
  /** Relative influence on the fused score. */
  readonly weight: number;
}

/**
 * Dense similarity carries more signal than lexical overlap on help content,
 * but BM25 is what finds error codes and flag names — the same 0.25/0.75 split
 * OpenSearch's hybrid pipeline is configured with.
 */
export const DENSE_WEIGHT = 0.75;
export const SPARSE_WEIGHT = 0.25;

/**
 * The expanded sparse query (see expansion.ts) fuses as its own retriever at a
 * deliberately small weight, rather than replacing the sparse list.
 *
 * `Bm25Index.search` dedupes query terms, so an expanded query gives borrowed
 * vocabulary exactly the same weight as the words the user typed — ten added
 * terms outvote a four-word question, and the ranking drifts toward whatever
 * the first pass happened to surface. Measured: replacing the sparse list this
 * way cost 1.5 points of hit@1 on the eval corpus.
 *
 * As a third retriever it can only ever *add* — the original ranking keeps its
 * full weight, and expansion promotes a chunk only when it agrees with it.
 */
export const EXPANDED_WEIGHT = 0.1;

/**
 * Scale scores to 0–1. A list whose scores are all equal normalises to 1: it
 * expresses no preference, so every member should carry that retriever's full
 * weight rather than none of it.
 */
export function minMaxNormalise(results: readonly ScoredId[]): Map<number, number> {
  const out = new Map<number, number>();
  if (results.length === 0) return out;

  let min = Infinity;
  let max = -Infinity;
  for (const { score } of results) {
    if (score < min) min = score;
    if (score > max) max = score;
  }

  const range = max - min;
  for (const { id, score } of results) {
    out.set(id, range === 0 ? 1 : (score - min) / range);
  }
  return out;
}

export interface FusedScore {
  readonly id: number;
  /** Weighted mean of the normalised scores, 0–1. */
  readonly confidence: number;
}

/**
 * Fuse any number of retrievers into one ranked list.
 *
 * A document missing from one retriever scores 0 there rather than being
 * dropped — the divisor is the total weight across all retrievers, not just the
 * ones that found it. Otherwise a chunk found by BM25 alone would score the
 * same as one both retrievers agreed on, which is precisely the agreement
 * signal hybrid retrieval exists to capture.
 */
export function weightedFusion(retrievers: readonly RetrieverResults[]): FusedScore[] {
  const totalWeight = retrievers.reduce((sum, r) => sum + r.weight, 0);
  if (totalWeight === 0) return [];

  const accumulated = new Map<number, number>();
  for (const retriever of retrievers) {
    const normalised = minMaxNormalise(retriever.results);
    for (const [id, score] of normalised) {
      accumulated.set(id, (accumulated.get(id) ?? 0) + score * retriever.weight);
    }
  }

  return [...accumulated.entries()]
    .map(([id, weighted]) => ({ id, confidence: weighted / totalWeight }))
    .sort((a, b) => b.confidence - a.confidence);
}

/**
 * Multiply a confidence by a boost, keeping it inside 0–1.
 *
 * Used for the page-context boost (PRD 5.7.7-adjacent): a question asked while
 * reading the Asset Hub docs should favour Asset Hub pages. Applied after
 * normalisation so the boost is a predictable proportion rather than something
 * that depends on the raw score scale.
 */
export function applyBoost(confidence: number, boost: number): number {
  return Math.max(0, Math.min(1, confidence * boost));
}
