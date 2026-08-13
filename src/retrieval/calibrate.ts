/**
 * Per-index refusal-floor calibration.
 *
 * A cosine threshold is not a property of the product. It is a property of the
 * *model* and the *corpus* together, and Sherpa shipped it as a constant — one
 * number, 0.45, applied to every index ever built. Measured against three real
 * help centres (`npm run eval:sites`), that number sat below the lowest score
 * any unanswerable question ever produced: across 405 negative queries the
 * minimum was 0.482. Nothing could ever fall under the floor, so the refusal
 * path could never fire, and the false-answer rate was 100% on all three sites.
 *
 * Worse, no single replacement works. The same sweep wanted 0.75 for one site
 * and 0.80 for another, and on a third the distributions overlapped so badly
 * that 0.75 bought a 0.7% false-answer rate by throwing away *half* of the
 * answerable questions. A global constant is being asked to average three
 * different right answers.
 *
 * So it is measured per index, at the end of the crawl, when the corpus that
 * determines it is sitting right there. The index already records the embedding
 * model that built it for exactly this kind of reason — the floor belongs
 * beside it.
 *
 * The method, kept deliberately cheap because it runs on the user's machine:
 *
 *   negatives  A fixed set of questions no help centre answers. Their scores
 *              are this index's noise ceiling — the level a confidently wrong
 *              match reaches.
 *   positives  A sample of the index's own article titles. The docs' own words,
 *              so these are an optimistic upper bound on a real question, and
 *              treated as one: they set the ceiling for `confident`, never the
 *              refusal floor.
 *
 * The floor lands above the negatives rather than below the positives, because
 * only the negative side is measured honestly. See `calibrateFloors`.
 */

import type { ConfidenceFloors } from "./confidence.js";
import { DEFAULT_FLOORS } from "./confidence.js";

/**
 * Questions from nowhere near a help centre.
 *
 * They have to be *plausible sentences* rather than gibberish: a random string
 * scores low for reasons that tell us nothing, while a well-formed question
 * about an unrelated subject is exactly the shape of the thing that gets asked
 * by mistake, and it is what the model's baseline similarity actually responds
 * to.
 *
 * On their own these are not enough, and measuring proved it — see
 * `HARD_PROBES`. They establish the floor of the range, not the top of it.
 */
export const OFF_DOMAIN_PROBES: readonly string[] = [
  "what is the boiling point of water at altitude",
  "who won the world cup in 1998",
  "how do I braise short ribs",
  "what is the capital of Mongolia",
  "explain the offside rule in football",
  "when should I prune apple trees",
  "how many strings does a cello have",
  "what causes the northern lights",
  "best way to remove a coffee stain from linen",
  "how long does it take to fly to Tokyo",
  "what is the difference between a crocodile and an alligator",
  "how do noise cancelling headphones work",
  "what year did the Berlin Wall fall",
  "how do I change a bicycle inner tube",
  "what is the tallest mountain in Africa",
];

/**
 * Plausible questions a help centre is unlikely to answer.
 *
 * These exist because the off-domain set, used alone, calibrated the floor far
 * too low and it was measured doing so: against three real help centres the
 * resulting floor still answered 29%, 79% and 78% of questions it should have
 * refused. Nobody asks a documentation site about the offside rule, so those
 * probes locate the model's noise floor — the bottom of the range — and a floor
 * placed just above the bottom clears nothing that matters.
 *
 * The wrong question users actually ask is *on topic and uncovered*: pricing,
 * contracts, roadmap, procurement. Measured on the same three corpora these
 * land at 0.69–0.72 where the off-domain probes topped out at 0.60, and that
 * band is what a refusal floor has to clear.
 *
 * Deliberately commercial rather than technical. A technical probe risks being
 * genuinely documented — asking "how do I configure SAML" of a corpus that
 * covers SAML would drag the floor up and refuse real questions — whereas
 * pricing and legal terms are near-universally absent from product help.
 */
export const HARD_PROBES: readonly string[] = [
  "how much does the enterprise plan cost per user",
  "what is the uptime SLA in our contract",
  "how do I get a refund for unused licences",
  "when will dark mode be released",
  "how does this compare to the competing product",
  "who is the account manager for my company",
  "what is the notice period for cancelling our subscription",
  "can I get a SOC 2 report for procurement",
  "what is on the product roadmap for next quarter",
  "how do I become a reseller partner",
  "what are the payment terms for annual invoicing",
  "is there a discount for non-profit organisations",
  "how many employees does the company have",
  "where are the company offices located",
  "who founded the company and when",
];

/**
 * The probe set the crawl scores. Thirty retrievals, once, at the end of a
 * crawl — negligible beside the embedding it just finished.
 */
export const PROBE_QUESTIONS: readonly string[] = [...OFF_DOMAIN_PROBES, ...HARD_PROBES];

export interface CalibrationInput {
  /** Top absolute cosine each probe question reached against this index. */
  readonly negativeScores: readonly number[];
  /**
   * Top absolute cosine each sampled article title reached. Optional: without
   * it the floor is still derived from the negatives, which is the half that
   * matters. Used only to stop a pathological corpus pushing the floor above
   * where its own content scores.
   */
  readonly positiveScores?: readonly number[];
}

export interface Calibration extends ConfidenceFloors {
  /** How many probe questions the floor was derived from. */
  readonly samples: number;
  /** When it was measured, so a stale calibration is visible. */
  readonly at: number;
}

/**
 * Headroom above the measured negative ceiling.
 *
 * The probe set is small, so its maximum understates the true tail: the next
 * unanswerable question a user asks may score a little higher than any of these
 * thirty did. The margin buys that tail. It is additive rather than a
 * multiplier because the quantity is a cosine — bounded, and already crowded
 * near the top of its range, where a proportional bump means much less at 0.75
 * than at 0.45.
 *
 * 0.08 is fitted, not derived: it is the gap that brought all three measured
 * corpora inside the 3% false-answer target (`npm run eval:sites`). Three sites
 * is a thin basis for a constant, and this is the number most likely to need
 * revisiting as more corpora are measured. The positives guard below is what
 * stops a bad fit here from silencing an index.
 */
export const NEGATIVE_MARGIN = 0.08;

/**
 * The band between "answer plainly" and "answer, but say the match was weak".
 *
 * Kept as a span above the floor rather than an independent measurement: the
 * two thresholds have to move together, and deriving `confident` from the
 * positives would tie it to title-shaped queries that no user types.
 */
export const CONFIDENT_SPAN = 0.08;

/** A floor above this refuses so much that something has gone wrong upstream. */
export const MAX_SANE_FLOOR = 0.9;

function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
}

/**
 * The highest negative score, ignoring the single worst offender.
 *
 * A percentile is the obvious tool here and the wrong one at this sample size:
 * with fifteen probes, p95 lands on the fifteenth value — the maximum — so it
 * provides exactly no protection against the outlier it was chosen to absorb.
 * Trimming one and taking the max of the rest says what is actually meant, and
 * says it in a way that does not quietly change meaning with the probe count.
 *
 * Only one is trimmed. Two probes brushing real topics is no longer an outlier;
 * it is a corpus that genuinely covers some of this ground, and the floor
 * should rise to meet it.
 */
function trimmedMax(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length >= 10) sorted.pop();
  return sorted[sorted.length - 1] ?? 0;
}

/**
 * Derive floors for one index from its measured score distributions.
 *
 * Pure — the embedding and retrieval happen in the caller — so the policy here
 * is unit-testable without a model, which matters because this decides whether
 * users are told "I don't know".
 */
export function calibrateFloors(input: CalibrationInput, now: number): Calibration {
  const negatives = input.negativeScores.filter((s) => Number.isFinite(s) && s > 0);

  // Too little evidence to overrule the shipped defaults. Returning them keeps
  // behaviour predictable rather than inventing a threshold from three points.
  if (negatives.length < 5) {
    return { ...DEFAULT_FLOORS, samples: negatives.length, at: now };
  }

  /**
   * The trimmed maximum, not the maximum. One probe that happens to brush a
   * real topic — a docs site with a travel-expenses page will respond to the
   * Tokyo question — should not drag the floor up for every other query.
   */
  let refuse = trimmedMax(negatives) + NEGATIVE_MARGIN;

  refuse = Math.max(DEFAULT_FLOORS.refuse, Math.min(refuse, MAX_SANE_FLOOR));

  /**
   * The guard against calibrating an index into silence, applied last.
   *
   * If the corpus's own articles score no better than its noise, a floor above
   * them refuses everything; better to sit just under the content and let the
   * model's grounding prompt do the refusing.
   *
   * Ordering is load-bearing, and it changed when the shipped default rose from
   * 0.40 to a measured 0.70. Clamping to the content *before* taking
   * `max(DEFAULT_FLOORS.refuse, …)` let the global minimum overrule the guard,
   * so an index whose content genuinely scores 0.60–0.68 — a small or unusual
   * corpus — would be pinned at 0.70 and refuse every question ever asked of
   * it. The global default is a floor for the *absence* of evidence; measured
   * evidence about this corpus outranks it.
   */
  const positives = (input.positiveScores ?? []).filter((s) => Number.isFinite(s) && s > 0);
  if (positives.length >= 5) {
    const positiveFloor = quantile(positives, 0.1);
    if (refuse > positiveFloor) refuse = positiveFloor;
  }
  const confident = Math.min(refuse + CONFIDENT_SPAN, MAX_SANE_FLOOR + CONFIDENT_SPAN);

  return {
    refuse: Number(refuse.toFixed(3)),
    confident: Number(confident.toFixed(3)),
    samples: negatives.length,
    at: now,
  };
}

/**
 * Which floors to use for a query.
 *
 * An index's own calibration wins when it has one, because it was measured
 * against the corpus being searched. Settings remain the override for anyone
 * who wants to tune by hand, and an uncalibrated index — every index built
 * before this existed — falls back to them unchanged.
 */
/**
 * Should the cross-encoder run for this index?
 *
 * Deliberately the same shape as `floorsForIndex`: a per-index answer wins when
 * one exists, and the global setting is the fallback. Reranking is not a
 * quality dial that is simply on or off — measured across two real corpora it
 * moved hit@1 by +45 and −30 — so the decision belongs beside the corpus it was
 * measured against.
 */
export function rerankForIndex(
  perIndex: boolean | undefined,
  fromSettings: boolean,
): boolean {
  return perIndex ?? fromSettings;
}

export function floorsForIndex(
  calibrated: ConfidenceFloors | undefined,
  fromSettings: ConfidenceFloors,
  userOverride: boolean,
): ConfidenceFloors {
  if (userOverride || !calibrated) return fromSettings;
  return calibrated;
}
