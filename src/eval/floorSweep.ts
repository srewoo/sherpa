/**
 * Refusal-floor calibration.
 *
 * The shipped floor (0.40) was swept against `src/eval/fixtures` — a hashed
 * bag-of-words embedder over twelve invented chunks. Cosine distributions are a
 * property of the *model*, not of the retrieval code, and a hashing projection's
 * distribution has nothing to do with bge-small's (bge scores cluster high;
 * 0.7–0.85 is an ordinary good match). So the number is defensible as a
 * placeholder and is almost certainly wrong for the model users actually run.
 *
 * This re-runs that sweep against real scores. It is pure: it takes the top
 * score each question already produced and reports what each candidate floor
 * would have decided. Retrieval runs once; the sweep is arithmetic over the
 * results, so trying twenty thresholds costs nothing.
 *
 * The output is deliberately two-sided. A floor trades false answers against
 * missed ones, and the project has only ever measured the first — which is how
 * a threshold ends up strict enough to refuse questions the docs plainly
 * answer, with nothing on the dashboard to show it.
 */

export interface FloorCase {
  /** Best absolute cosine retrieval reached for this question. */
  readonly topScore: number;
  /** Whether the docs actually answer it (i.e. the question was labelled). */
  readonly answerable: boolean;
  /** Whether retrieval found a correct article at all. */
  readonly retrieved: boolean;
}

export interface FloorResult {
  readonly floor: number;
  /** Unanswerable questions this floor would have answered anyway. */
  readonly falseAnswers: number;
  /**
   * Answerable questions whose article was retrieved and which this floor would
   * have refused. The cost side of the trade, and the half nobody was watching.
   */
  readonly missedAnswers: number;
  readonly falseAnswerRate: number;
  readonly missedAnswerRate: number;
}

/** Default sweep: fine enough to see the knee, coarse enough to read. */
export const DEFAULT_FLOORS: readonly number[] = [
  0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8,
];

export function sweepFloors(
  cases: readonly FloorCase[],
  floors: readonly number[] = DEFAULT_FLOORS,
): FloorResult[] {
  const negatives = cases.filter((c) => !c.answerable);
  // Only questions whose article was actually found can be "missed" by the
  // floor — one retrieval never surfaced is a retrieval failure, and counting
  // it here would blame the threshold for someone else's problem.
  const recoverable = cases.filter((c) => c.answerable && c.retrieved);

  return floors.map((floor) => {
    const falseAnswers = negatives.filter((c) => c.topScore >= floor).length;
    const missedAnswers = recoverable.filter((c) => c.topScore < floor).length;
    return {
      floor,
      falseAnswers,
      missedAnswers,
      falseAnswerRate: negatives.length === 0 ? 0 : falseAnswers / negatives.length,
      missedAnswerRate: recoverable.length === 0 ? 0 : missedAnswers / recoverable.length,
    };
  });
}

/**
 * The lowest floor that still meets the false-answer target.
 *
 * Lowest, not best-scoring: above the target every extra point of strictness
 * buys nothing and costs answers, so the floor should sit at the knee rather
 * than wherever a combined score happens to peak. Returns undefined when no
 * floor in the sweep is strict enough — which is itself the finding.
 */
export function recommendFloor(
  results: readonly FloorResult[],
  maxFalseAnswerRate: number,
): FloorResult | undefined {
  return [...results]
    .sort((a, b) => a.floor - b.floor)
    .find((r) => r.falseAnswerRate <= maxFalseAnswerRate);
}

/* ------------------------------------------------------------------ scatter */

/**
 * Scatter-threshold calibration, on exactly the same principle.
 *
 * `DEFAULT_REFINE.scatterDelta` decides when the leading pages are close enough
 * in absolute cosine to be worth offering as alternatives. Its predecessor —
 * a 15% *relative* gap on the min-max fused score — was picked by hand, never
 * measured, and was arithmetically incapable of being right: min-max makes the
 * top score ≈1.0 for every query, so it was thresholding on a constant.
 *
 * The lesson is that this constant needs measuring, not that 0.03 is correct.
 * Like the refusal floor it is a property of the *model's* cosine distribution,
 * so a sweep against the fixture embedder proves the arithmetic and nothing
 * about the value; `real.eval.ts` is where the number gets settled.
 */
export interface ScatterCase {
  /**
   * Absolute cosine of the leading distinct pages, best first. Fewer than two
   * means there was nothing to be ambiguous between.
   */
  readonly leadingSimilarities: readonly number[];
  /** Whether this question genuinely had one right answer. */
  readonly singleIntent: boolean;
}

export interface ScatterResult {
  readonly delta: number;
  /** Single-intent questions this delta would have cluttered with chips. */
  readonly falseOffers: number;
  /** Genuinely ambiguous questions it would have said nothing about. */
  readonly missedOffers: number;
  readonly falseOfferRate: number;
  readonly missedOfferRate: number;
}

export const DEFAULT_SCATTER_DELTAS: readonly number[] = [
  0.01, 0.02, 0.03, 0.04, 0.05, 0.075, 0.1, 0.15, 0.2,
];

/** Would this delta have offered alternatives for this question? */
export function wouldOffer(
  { leadingSimilarities }: ScatterCase,
  delta: number,
  minDistinctPages = 3,
): boolean {
  if (leadingSimilarities.length < minDistinctPages) return false;
  const leading = leadingSimilarities.slice(0, minDistinctPages);
  return (leading[0] as number) - (leading[leading.length - 1] as number) <= delta;
}

export function sweepScatter(
  cases: readonly ScatterCase[],
  deltas: readonly number[] = DEFAULT_SCATTER_DELTAS,
  minDistinctPages = 3,
): ScatterResult[] {
  const single = cases.filter((c) => c.singleIntent);
  const ambiguous = cases.filter((c) => !c.singleIntent);

  return deltas.map((delta) => {
    const falseOffers = single.filter((c) => wouldOffer(c, delta, minDistinctPages)).length;
    const missedOffers = ambiguous.filter((c) => !wouldOffer(c, delta, minDistinctPages)).length;
    return {
      delta,
      falseOffers,
      missedOffers,
      falseOfferRate: single.length === 0 ? 0 : falseOffers / single.length,
      missedOfferRate: ambiguous.length === 0 ? 0 : missedOffers / ambiguous.length,
    };
  });
}

export function formatScatterSweep(results: readonly ScatterResult[]): string {
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`.padStart(7);
  return [
    "delta   false-offer   missed-offer",
    ...results.map(
      (r) => `${r.delta.toFixed(3)}   ${pct(r.falseOfferRate)}       ${pct(r.missedOfferRate)}`,
    ),
  ].join("\n");
}

export function formatFloorSweep(results: readonly FloorResult[]): string {
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`.padStart(7);
  return [
    "floor   false-answer   missed-answer",
    ...results.map(
      (r) => `${r.floor.toFixed(2)}    ${pct(r.falseAnswerRate)}        ${pct(r.missedAnswerRate)}`,
    ),
  ].join("\n");
}
