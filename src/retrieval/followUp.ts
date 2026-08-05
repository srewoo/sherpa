/**
 * Resolve a follow-up against the question before it.
 *
 * The side panel is a conversation, and retrieval was not. Every question was
 * embedded standalone, so "and for admins?" or "what about on mobile" searched
 * for the words *and*, *for*, *admins* with no idea what was being asked about
 * — while the previous turn sat on screen, two inches above, saying exactly
 * that. It is the cheapest large win available in retrieval: no model, no extra
 * latency, and it fixes a whole class of question users naturally ask second.
 *
 * The rules are borrowed from the server-side KB's router, which does this with
 * an LLM. The discipline transfers even though the mechanism doesn't:
 *
 *  - **Resolve references only.** Carry the previous question's *subject*, never
 *    its intent. "How do I delete a user?" followed by "and reports?" is about
 *    reports; it is not another delete question.
 *  - **Never touch a self-contained question.** A question that stands on its
 *    own is left exactly as typed. Silently rewriting a clear query is worse
 *    than not helping, because the user cannot see it happen.
 *  - **Add nothing that wasn't said.** Terms come from the previous turn
 *    verbatim; none are invented, expanded or paraphrased.
 */

import { tokenize } from "./bm25.js";

/**
 * Openers that signal a question leaning on the one before it. A question
 * starting this way is grammatically incomplete on its own.
 */
const FOLLOW_UP_OPENERS = [
  "and", "what about", "how about", "also", "but", "or", "then", "plus",
  "what if", "and what", "and how", "ok and", "okay and", "same for",
  "and for", "and in", "and on", "what of",
];

/**
 * Words that point at something already named rather than naming it. Their
 * presence is what makes a question a reference rather than a question.
 */
const REFERENTIAL = new Set([
  "it", "its", "it's", "that", "this", "those", "these", "them", "they",
  "there", "same", "one", "ones", "above", "instead",
]);

/** Words too common to carry meaning forward. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "for", "in", "on", "at", "to", "of",
  "is", "are", "was", "were", "be", "do", "does", "did", "how", "what", "why",
  "when", "where", "who", "which", "can", "could", "should", "would", "will",
  "my", "me", "i", "you", "your", "we", "us", "about", "with", "from", "as",
  "if", "then", "than", "so", "not", "no", "yes", "get", "got", "make", "use",
]);

export interface FollowUpOptions {
  /** At or above this many words, a question is treated as self-contained. */
  readonly standaloneWords: number;
  /** How many distinctive terms to carry forward from the previous question. */
  readonly maxCarriedTerms: number;
  /** Shortest a term must be to be worth carrying. */
  readonly minTermLength: number;
}

export const DEFAULT_FOLLOW_UP: FollowUpOptions = {
  // Six words is long enough to name a subject and an action. Below it, a
  // question usually leans on context; above it, it stands up on its own.
  standaloneWords: 6,
  maxCarriedTerms: 4,
  minTermLength: 3,
};

/** Does this question depend on the one before it? */
export function isFollowUp(
  query: string,
  options: FollowUpOptions = DEFAULT_FOLLOW_UP,
): boolean {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === "") return false;

  const words = tokenize(trimmed);
  if (words.length === 0) return false;

  // An explicit opener is a follow-up however long the question runs on.
  if (FOLLOW_UP_OPENERS.some((opener) => trimmed.startsWith(`${opener} `))) return true;

  // A long question carries its own subject even if it mentions "it".
  if (words.length >= options.standaloneWords) return false;

  return words.some((w) => REFERENTIAL.has(w));
}

/** The distinctive words of a question, in order, without filler. */
export function distinctiveTerms(
  query: string,
  options: FollowUpOptions = DEFAULT_FOLLOW_UP,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of tokenize(query)) {
    if (term.length < options.minTermLength) continue;
    if (STOPWORDS.has(term) || REFERENTIAL.has(term)) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    out.push(term);
  }
  return out;
}

/**
 * The query to search with.
 *
 * `previousQuestions` is most-recent-first. Only the immediately preceding turn
 * is used: reaching further back is how a conversation that has moved on gets
 * dragged back to a topic the user left two questions ago.
 */
export function resolveFollowUp(
  query: string,
  previousQuestions: readonly string[],
  options: FollowUpOptions = DEFAULT_FOLLOW_UP,
): string {
  const previous = previousQuestions[0];
  if (!previous || !isFollowUp(query, options)) return query;

  // Terms already present don't need carrying, and repeating them would
  // silently re-weight the query.
  const already = new Set(tokenize(query));
  const carried = distinctiveTerms(previous, options)
    .filter((term) => !already.has(term))
    .slice(0, options.maxCarriedTerms);

  if (carried.length === 0) return query;

  // The user's own words lead; context is appended. Their phrasing stays the
  // primary signal, and the result still reads as their question.
  return `${query} ${carried.join(" ")}`;
}
