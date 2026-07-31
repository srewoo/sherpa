/**
 * Reciprocal Rank Fusion (PRD 5.7.1).
 *
 * Fuses the dense (cosine) and sparse (BM25) rankings without needing their
 * scores to be on the same scale. Each list contributes 1/(k + rank) to every
 * id it ranks; the constant k (default 60, per the original RRF paper) damps
 * the influence of top ranks so a single list can't dominate.
 */

export interface RankedList<Id> {
  /** Ids in descending relevance order (best first). */
  readonly ids: readonly Id[];
  /** Optional weight; defaults to 1. Lets us favour BM25 on exact-term queries. */
  readonly weight?: number;
}

export interface FusedResult<Id> {
  readonly id: Id;
  readonly score: number;
}

/**
 * Fuse any number of ranked lists into a single ranking.
 *
 * @param lists ranked id lists (dense, sparse, …)
 * @param k     rank-damping constant; larger flattens the contribution curve
 */
export function reciprocalRankFusion<Id>(
  lists: readonly RankedList<Id>[],
  k = 60,
): FusedResult<Id>[] {
  const scores = new Map<Id, number>();

  for (const list of lists) {
    const weight = list.weight ?? 1;
    list.ids.forEach((id, rank) => {
      const contribution = weight / (k + rank + 1); // rank is 0-based
      scores.set(id, (scores.get(id) ?? 0) + contribution);
    });
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
