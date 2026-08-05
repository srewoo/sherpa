/**
 * Query expansion by pseudo-relevance feedback (RM3-style).
 *
 * The failure this addresses is the one that actually breaks help search: the
 * user's words and the documentation's words are different words. Asked "how do
 * I create a two way role play", a help centre that says "Practice with avatar"
 * and "interactive video roleplay mission" shares almost no vocabulary with the
 * question. Dense retrieval bridges some of that; BM25 bridges none of it, and
 * an exact-term query is exactly where BM25 is supposed to earn its place.
 *
 * The fix is to let the corpus supply the missing vocabulary. Run the query,
 * assume the top few results are roughly relevant (hence *pseudo*-relevance —
 * nobody confirmed it), harvest the terms that distinguish those documents, and
 * re-run with them appended. No model, no network, no training: the index the
 * user already built is the thesaurus.
 *
 * It is deliberately conservative. Feedback terms are appended to the original
 * query rather than replacing it, so a good query can only be widened, never
 * redirected — the classic failure of expansion is drifting away from what was
 * asked when the top results were wrong.
 */

import { tokenize } from "./bm25.js";

/**
 * Words that appear everywhere in documentation and distinguish nothing.
 *
 * Kept short on purpose. An aggressive stop list starts eating terms that carry
 * real meaning in a help centre ("view", "share", "role"), and the term scoring
 * below already suppresses anything common across the whole feedback set.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "you", "your", "with", "that", "this", "from", "are",
  "can", "will", "has", "have", "had", "was", "were", "been", "being", "not",
  "but", "all", "any", "our", "out", "use", "used", "using", "when", "where",
  "how", "what", "which", "who", "why", "then", "than", "them", "they", "there",
  "here", "into", "onto", "its", "it's", "also", "more", "most", "some", "such",
  "only", "own", "same", "each", "other", "under", "over", "after", "before",
  "click", "select", "page", "see", "make", "want", "need", "should", "would",
]);

export interface ExpansionOptions {
  /** How many top results to treat as pseudo-relevant. */
  readonly feedbackDocs: number;
  /** How many expansion terms to add. */
  readonly maxTerms: number;
  /** Minimum length for a term to be worth adding. */
  readonly minTermLength: number;
}

export const DEFAULT_EXPANSION: ExpansionOptions = {
  // Three: enough to find a shared vocabulary, few enough that one bad top hit
  // cannot dominate. At ten, an off-topic result drags the query with it.
  feedbackDocs: 3,
  // Ten terms roughly doubles a typical question without drowning it — the
  // original terms still carry most of the weight because they are also the
  // terms most likely to appear in the feedback documents.
  maxTerms: 10,
  minTermLength: 3,
};

/**
 * Score candidate terms from the pseudo-relevant documents.
 *
 * A term scores on how many of the feedback documents contain it, then on total
 * frequency. Document count first is the important half: a word repeated twenty
 * times in one document is that document's quirk, while a word appearing once
 * in all three is the vocabulary those documents share — which is what we are
 * trying to learn.
 */
export function scoreExpansionTerms(
  feedback: readonly string[],
  exclude: ReadonlySet<string>,
  options: ExpansionOptions = DEFAULT_EXPANSION,
): { term: string; docs: number; count: number }[] {
  const docs = new Map<string, number>();
  const counts = new Map<string, number>();

  for (const text of feedback.slice(0, options.feedbackDocs)) {
    const seen = new Set<string>();
    for (const term of tokenize(text)) {
      if (term.length < options.minTermLength) continue;
      if (STOPWORDS.has(term) || exclude.has(term)) continue;
      counts.set(term, (counts.get(term) ?? 0) + 1);
      seen.add(term);
    }
    for (const term of seen) docs.set(term, (docs.get(term) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([term, count]) => ({ term, docs: docs.get(term) ?? 0, count }))
    .sort((a, b) => b.docs - a.docs || b.count - a.count || a.term.localeCompare(b.term));
}

/**
 * The expanded query: the original, plus vocabulary borrowed from its own top
 * results. Returns the original unchanged when there is nothing to learn.
 */
export function expandQuery(
  query: string,
  feedback: readonly string[],
  options: ExpansionOptions = DEFAULT_EXPANSION,
): string {
  if (feedback.length === 0 || options.maxTerms <= 0) return query;

  // Terms already in the query must not be re-added — they are weighted by the
  // ranking function, and duplicating them would silently re-weight the query.
  const original = new Set(tokenize(query));
  const scored = scoreExpansionTerms(feedback, original, options);
  if (scored.length === 0) return query;

  const added = scored.slice(0, options.maxTerms).map((t) => t.term);
  return `${query} ${added.join(" ")}`;
}
