/**
 * How sure are we? (PRD 5.8.8, widened.)
 *
 * Sherpa used one threshold and two outcomes: answer, or refuse. That forces a
 * single number to carry a decision it cannot make well, because the score
 * distributions of answerable and unanswerable questions genuinely overlap —
 * measured on real bge weights, a question the docs *don't* cover still scores
 * 0.55–0.70, right where good answers live. Any single cut through that band
 * either refuses questions the docs answer or answers ones they don't.
 *
 * Three outcomes fit the evidence better, and it's what the server-side KB does:
 *
 *   confident  — answer plainly
 *   uncertain  — answer, and say the match wasn't strong
 *   refuse     — don't answer; show the nearest pages instead
 *
 * The middle band is the point. It converts a coin-flip into a hedge: the user
 * still gets the passage and the citation, plus an honest note that Sherpa isn't
 * sure — which is far more useful than a confident wrong answer *or* a refusal
 * on content that was sitting right there.
 */

export type Certainty = "confident" | "uncertain";

export type ScoreVerdict =
  | { readonly kind: "answer"; readonly certainty: Certainty }
  | { readonly kind: "refuse" };

export interface ConfidenceFloors {
  /** Below this, refuse. */
  readonly refuse: number;
  /** At or above this, answer without hedging. Between the two, hedge. */
  readonly confident: number;
}

/**
 * Shipped defaults.
 *
 * `refuse` at 0.45 and `confident` at 0.65 bracket the overlap measured against
 * real bge embeddings (`npm run eval` → floor sweep): below 0.45 the adversarial
 * questions live, above 0.65 the answerable ones do, and 0.45–0.65 is the region
 * where the score alone genuinely cannot tell them apart. Both are adjustable,
 * and the eval's sweep re-derives them for a specific corpus.
 */
export const DEFAULT_FLOORS: ConfidenceFloors = { refuse: 0.45, confident: 0.65 };

export function verdictFor(
  topScore: number,
  hasResults: boolean,
  floors: ConfidenceFloors = DEFAULT_FLOORS,
): ScoreVerdict {
  if (!hasResults) return { kind: "refuse" };
  if (topScore < floors.refuse) return { kind: "refuse" };
  return { kind: "answer", certainty: topScore >= floors.confident ? "confident" : "uncertain" };
}

/**
 * The verdict when retrieval ran without its dense half.
 *
 * The floors are cosine thresholds, and with no embedder there is no cosine —
 * BM25 scores are unbounded and corpus-relative, so comparing them to 0.45
 * would be arithmetic on two different scales. Applying the floor anyway would
 * refuse everything (no similarity → 0). So the floor is skipped and the answer
 * is hedged instead: lexical matches are real evidence, just weaker evidence,
 * and a keyword hit is worth showing while the model is unavailable.
 */
export function verdictWithoutDense(hasResults: boolean): ScoreVerdict {
  return hasResults ? { kind: "answer", certainty: "uncertain" } : { kind: "refuse" };
}
