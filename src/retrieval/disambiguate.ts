/**
 * Ask instead of guessing.
 *
 * Some questions name a topic without naming the intent — "roleplay",
 * "permissions", "delete a user" — and retrieval answers honestly by returning
 * several *different* articles that each cover a different thing. Sherpa then
 * had two bad options: answer the top hit as though the ambiguity weren't
 * there, or refuse content that was plainly present.
 *
 * There is a third, and the user is holding the missing information. Offer the
 * two or three distinct readings and let them pick. This costs one extra turn
 * and saves the far more expensive one where a confident answer to the wrong
 * question sends someone down the wrong path.
 *
 * Deliberately computed from retrieval scores and titles rather than by asking
 * a model. Sherpa's always-available generator is Gemini Nano — weak, sometimes
 * absent, and the last thing that should stand between a user and an answer.
 * The information needed is already in the ranking: how close the scores are,
 * and whether the pages are actually different.
 */

import type { RetrievedArticle } from "@/domain/retrieval.js";

export interface DisambiguationOption {
  /** Short label shown on the chip. */
  readonly label: string;
  /** The page it stands for, so a pick can be turned into a sharper query. */
  readonly url: string;
}

export interface DisambiguationOptions {
  /** How many options to offer. Two or three; more is a menu, not a question. */
  readonly maxOptions: number;
  /**
   * How far ahead the top result must be, relative to its own score, to count
   * as a clear winner. Above this the field is not ambiguous and we answer.
   */
  readonly dominantGap: number;
  /** Fewest distinct pages that can constitute a genuine ambiguity. */
  readonly minDistinctPages: number;
  /** Longest a chip label may be before it stops being scannable. */
  readonly maxLabelChars: number;
}

export const DEFAULT_DISAMBIGUATION: DisambiguationOptions = {
  maxOptions: 3,
  // 15%: a top result that beats the runner-up by less than this is not
  // meaningfully "the" answer, it is one of several.
  dominantGap: 0.15,
  minDistinctPages: 3,
  maxLabelChars: 60,
};

/** Trim a title down to something readable on a chip. */
function labelOf(article: RetrievedArticle, maxChars: number): string {
  const raw = (article.title || article.headingPath || "").trim();
  if (raw.length <= maxChars) return raw;
  // Cut at a word boundary rather than mid-word.
  const cut = raw.slice(0, maxChars);
  const space = cut.lastIndexOf(" ");
  return `${space > maxChars * 0.6 ? cut.slice(0, space) : cut}…`;
}

/**
 * Should we ask? Returns the options, or null to answer normally.
 *
 * The negative rules matter as much as the positive one — inventing options
 * when the answer is obvious is its own failure, and more annoying than a wrong
 * guess because it happens on questions the user asked perfectly well:
 *
 *  - A clear winner is not ambiguous. One article far ahead of the rest is the
 *    answer, however many tangential pages trail it.
 *  - Chunks of the same page are not alternatives. Several strong hits on one
 *    article means the answer is *there*, spread across it.
 *  - Two options that read the same are not a choice. Help centres repeat
 *    titles across sections, and "Create a mission" vs "Create a mission" asks
 *    the user to pick at random.
 */
export function chooseDisambiguation(
  articles: readonly RetrievedArticle[],
  options: DisambiguationOptions = DEFAULT_DISAMBIGUATION,
): DisambiguationOption[] | null {
  if (articles.length < options.minDistinctPages) return null;

  const best = articles[0];
  const runnerUp = articles[1];
  if (!best || !runnerUp) return null;
  if (best.rankScore <= 0) return null;

  // A dominant leader means the question had one home in the docs.
  const gap = (best.rankScore - runnerUp.rankScore) / best.rankScore;
  if (gap >= options.dominantGap) return null;

  const distinctPages = new Set(articles.map((a) => a.url));
  if (distinctPages.size < options.minDistinctPages) return null;

  const chosen: DisambiguationOption[] = [];
  const seenLabels = new Set<string>();
  const seenUrls = new Set<string>();

  for (const article of articles) {
    if (chosen.length >= options.maxOptions) break;
    if (seenUrls.has(article.url)) continue;
    const label = labelOf(article, options.maxLabelChars);
    const key = label.toLowerCase();
    if (label === "" || seenLabels.has(key)) continue;
    seenLabels.add(key);
    seenUrls.add(article.url);
    chosen.push({ label, url: article.url });
  }

  // Fewer than two survivors means the "ambiguity" was duplicate titles.
  return chosen.length >= 2 ? chosen : null;
}
