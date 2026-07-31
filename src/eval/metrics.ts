/**
 * Eval metrics (PRD §7, M1–M3). Pure functions so the release gate is testable
 * and deterministic. Recall/hit measure retrieval; false-answer rate measures
 * whether we wrongly answer out-of-index questions; groundedness measures
 * whether answer claims trace to cited chunks.
 */

/** Proportion of a query's relevant chunks that appear in the top-k. */
export function recallAtK(retrieved: readonly number[], relevant: ReadonlySet<number>, k: number): number {
  if (relevant.size === 0) return 0;
  const top = retrieved.slice(0, k);
  const hits = top.filter((id) => relevant.has(id)).length;
  return hits / relevant.size;
}

/** 1 if any relevant chunk is in the top-k, else 0 (recall@k, binary form). */
export function hitAtK(retrieved: readonly number[], relevant: ReadonlySet<number>, k: number): number {
  return retrieved.slice(0, k).some((id) => relevant.has(id)) ? 1 : 0;
}

export interface RetrievalCase {
  readonly retrieved: readonly number[];
  readonly relevant: ReadonlySet<number>;
}

export function meanRecallAtK(cases: readonly RetrievalCase[], k: number): number {
  if (cases.length === 0) return 0;
  return cases.reduce((s, c) => s + recallAtK(c.retrieved, c.relevant, k), 0) / cases.length;
}

export function meanHitAtK(cases: readonly RetrievalCase[], k: number): number {
  if (cases.length === 0) return 0;
  return cases.reduce((s, c) => s + hitAtK(c.retrieved, c.relevant, k), 0) / cases.length;
}

/** Fraction of adversarial (unanswerable) queries that were answered anyway. */
export function falseAnswerRate(answered: readonly boolean[]): number {
  if (answered.length === 0) return 0;
  return answered.filter(Boolean).length / answered.length;
}

/** Mean fraction of answer claims that carry a citation. */
export function groundedness(cases: readonly { cited: number; total: number }[]): number {
  const scored = cases.filter((c) => c.total > 0);
  if (scored.length === 0) return 0;
  return scored.reduce((s, c) => s + c.cited / c.total, 0) / scored.length;
}
