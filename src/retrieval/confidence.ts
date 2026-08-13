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
 * Shipped defaults, now measured rather than guessed.
 *
 * These were 0.45/0.65, carried over from a sweep against the fixture
 * embedder — a hashed bag-of-words stand-in whose cosine distribution has
 * nothing to do with bge-small's. `npm run eval:sites` against three real
 * crawled help centres (eGain 221 pages, Gong 731, Mindtickle 1406) measured
 * what bge actually produces:
 *
 *   answerable (a page asked by its own title)   median 0.76–0.86
 *   cross-site negatives (a neighbour's docs)    p95    0.69–0.72
 *   off-domain negatives (nothing like a doc)    p95    0.60–0.62
 *
 * bge scores *everything* in a product's subject area highly, so the old floor
 * sat far below even the off-domain noise: at 0.40 the measured false-answer
 * rate was **92%, 100% and 92%** across the three sites. The threshold was not
 * merely miscalibrated, it was inert — nothing could ever be refused, and the
 * model's own grounding refusal was silently carrying the entire load.
 *
 * 0.70 sits just above the negatives' p95 on all three corpora and is the
 * lowest floor meeting a ≤3% false-answer rate on the cleanest of them. It is a
 * *fallback*: an index calibrated at crawl time knows its own corpus better,
 * and `floorsForIndex` prefers that. What this number has to be is defensible
 * when nothing better exists — which 0.45 was not.
 *
 * Re-derive with `npm run eval:sites` after any change to the embedding model.
 */
export const DEFAULT_FLOORS: ConfidenceFloors = { refuse: 0.7, confident: 0.8 };

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
