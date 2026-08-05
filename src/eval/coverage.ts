/**
 * Answer completeness (PRD §7, the metric that was missing).
 *
 * Recall asks "did we find the right article?". It says nothing about whether
 * the answer built from that article contained the whole procedure — which is
 * precisely the failure that reads as broken to a user: an answer that finds
 * the right page, gets the first two steps right, and stops. Recall scores that
 * 1.0.
 *
 * So completeness is measured separately, against phrases a labeller marks as
 * required. Deliberately a substring test over normalised text rather than
 * anything semantic: the metric has to be explainable to the support engineer
 * who wrote the label, and "the answer never says 'Practice with avatar'" is a
 * claim they can check in a second.
 */

/**
 * Normalise for comparison: case, whitespace, and the punctuation that models
 * vary on without changing meaning. Anything more aggressive starts matching
 * phrases that are not really there.
 */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[*_`#>]/g, "") // markdown emphasis must not hide a match
    .replace(/\s+/g, " ")
    .trim();
}

export interface Coverage {
  readonly found: readonly string[];
  readonly missing: readonly string[];
  /** Fraction of required phrases present; 1 when nothing was required. */
  readonly ratio: number;
}

/**
 * Which required phrases the answer actually contains.
 *
 * A question with no `mustInclude` scores 1: absence of a label is not evidence
 * of incompleteness, and scoring it 0 would drag the mean down for every
 * question nobody has got round to labelling yet.
 */
export function coverageOf(answer: string, mustInclude: readonly string[]): Coverage {
  if (mustInclude.length === 0) return { found: [], missing: [], ratio: 1 };

  const haystack = normalizeForMatch(answer);
  const found: string[] = [];
  const missing: string[] = [];

  for (const phrase of mustInclude) {
    const needle = normalizeForMatch(phrase);
    if (needle !== "" && haystack.includes(needle)) found.push(phrase);
    else missing.push(phrase);
  }

  return { found, missing, ratio: found.length / mustInclude.length };
}

/** Mean coverage across cases. Cases with nothing required contribute 1. */
export function meanCoverage(cases: readonly Coverage[]): number {
  if (cases.length === 0) return 0;
  return cases.reduce((sum, c) => sum + c.ratio, 0) / cases.length;
}

/**
 * Phrases missed most often across the run.
 *
 * The single most actionable output of the eval: a phrase that goes missing on
 * many questions is usually one chunking or assembly bug, not many answer bugs.
 */
export function mostMissed(cases: readonly Coverage[], limit = 10): { phrase: string; misses: number }[] {
  const counts = new Map<string, number>();
  for (const c of cases) {
    for (const phrase of c.missing) counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([phrase, misses]) => ({ phrase, misses }))
    .sort((a, b) => b.misses - a.misses || a.phrase.localeCompare(b.phrase))
    .slice(0, limit);
}
