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

export function formatFloorSweep(results: readonly FloorResult[]): string {
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`.padStart(7);
  return [
    "floor   false-answer   missed-answer",
    ...results.map(
      (r) => `${r.floor.toFixed(2)}    ${pct(r.falseAnswerRate)}        ${pct(r.missedAnswerRate)}`,
    ),
  ].join("\n");
}
