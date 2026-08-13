/**
 * Offer alternatives; never demand one.
 *
 * This replaces an earlier module that *asked before answering* — "Which of
 * these did you mean?" with three chips and no answer behind them. Three things
 * were wrong with it, and they compounded into a dead end:
 *
 *  1. It thresholded on `rankScore`. That score is min-max normalised, so the
 *     top hit is ≈1.0 for every query ever asked (see fusion.ts). A "gap"
 *     measured against it is a fact about how many similarly-titled pages the
 *     site has, not about the question. It fired constantly on large help
 *     centres, which are exactly the corpora with many sibling titles.
 *  2. It gated the answer. A gate needs to be right; this one couldn't be.
 *  3. Picking an option re-asked the chosen *title* as a fresh query — which
 *     retrieves that page plus its near-identical siblings at near-identical
 *     scores, the most reliably "ambiguous" input the corpus can produce. The
 *     question came back unchanged, forever.
 *
 * The design error underneath all three: retrieval scatter is not intent
 * ambiguity. "How do I record a call?" has one perfectly clear intent. A help
 * centre with two hundred call-related pages will always scatter. Asking the
 * user to resolve that makes them fix the corpus's problem, not their own.
 *
 * So refinement is now advisory and terminal. The answer is generated and shown
 * first; these are offered underneath it as "not what you meant?". An empty
 * list simply renders nothing, and no return value from this module can prevent
 * an answer from being produced.
 *
 * Two scores, kept apart (domain/retrieval.ts): scatter is judged on absolute
 * cosine, never on the fused rank score. Cosine is comparable across queries,
 * which is the whole property this decision needs and the previous version
 * lacked.
 */

import type { RetrievedArticle } from "@/domain/retrieval.js";

export interface RefineOption {
  /** Short label shown on the chip. */
  readonly label: string;
  /** The page it stands for, so a pick can be scoped to that document. */
  readonly url: string;
}

export interface RefineOptions {
  /** How many alternatives to offer. More is a menu, not a nudge. */
  readonly maxOptions: number;
  /**
   * How tightly the leading pages must cluster, in *absolute cosine*, to count
   * as genuinely scattered. A leader clearly ahead on this scale is the answer.
   */
  readonly scatterDelta: number;
  /** Fewest distinct pages that can constitute genuine scatter. */
  readonly minDistinctPages: number;
  /** Longest a chip label may be before it stops being scannable. */
  readonly maxLabelChars: number;
}

export const DEFAULT_REFINE: RefineOptions = {
  maxOptions: 3,
  /**
   * 0.03 cosine. Provisional: swept by `floorSweep`, but honestly calibratable
   * only against real embeddings — the eval's fixture embedder is a hashing
   * stand-in whose score *distribution* is nothing like bge's. The structural
   * gates hold regardless of this number; only the constant needs the real
   * corpus.
   */
  scatterDelta: 0.03,
  minDistinctPages: 3,
  maxLabelChars: 60,
};

/** Trim a title down to something readable on a chip. */
export function labelOf(article: RetrievedArticle, maxChars: number): string {
  const raw = (article.title || article.headingPath || "").trim();
  if (raw.length <= maxChars) return raw;
  // Cut at a word boundary rather than mid-word.
  const cut = raw.slice(0, maxChars);
  const space = cut.lastIndexOf(" ");
  return `${space > maxChars * 0.6 ? cut.slice(0, space) : cut}…`;
}

/**
 * One entry per page, best-ranked first, with a usable and unique label.
 *
 * Chunks of the same page are not alternatives — several strong hits on one
 * article means the answer is *there*, spread across it. And help centres
 * repeat titles across sections, so two options reading identically would ask
 * the user to pick at random.
 */
function distinctPages(
  articles: readonly RetrievedArticle[],
  maxLabelChars: number,
): { article: RetrievedArticle; label: string }[] {
  const out: { article: RetrievedArticle; label: string }[] = [];
  const seenUrls = new Set<string>();
  const seenLabels = new Set<string>();

  for (const article of articles) {
    if (seenUrls.has(article.url)) continue;
    const label = labelOf(article, maxLabelChars);
    const key = label.toLowerCase();
    if (label === "" || seenLabels.has(key)) continue;
    seenUrls.add(article.url);
    seenLabels.add(key);
    out.push({ article, label });
  }
  return out;
}

/**
 * Alternatives worth offering beneath the answer, or `[]` for none.
 *
 * Returns `[]` rather than null: an empty list is a rendering decision, not an
 * exceptional case, and callers should never branch on it.
 */
export function chooseRefinements(
  articles: readonly RetrievedArticle[],
  options: RefineOptions = DEFAULT_REFINE,
): RefineOption[] {
  const pages = distinctPages(articles, options.maxLabelChars);
  if (pages.length < options.minDistinctPages) return [];

  /**
   * Without a dense half there is no cosine to compare, and BM25 scores are
   * unbounded and corpus-relative — the same mistake `verdictWithoutDense`
   * exists to avoid. Offering nothing is right: the answer still shows.
   */
  const leading = pages.slice(0, options.minDistinctPages);
  const similarities = leading.map((p) => p.article.similarity);
  if (similarities.some((s) => s === undefined)) return [];

  /**
   * The spread across the leading pages — max minus min, not first minus last.
   *
   * `articles` arrive in *rank* order, and rank order is no longer cosine order:
   * the cross-encoder reorders the head, and so do the learned pick priors.
   * Taking the ends of the rank-ordered list would compare two arbitrary
   * members of the set, and can even go negative — cosines of [0.55, 0.60,
   * 0.82] would read as a spread of -0.27 and offer chips on the one case this
   * module exists to stay silent about: a page dominating on the absolute
   * scale. Spread is a property of the set, so it is computed as one.
   */
  const values = similarities as number[];
  const spread = Math.max(...values) - Math.min(...values);
  if (spread > options.scatterDelta) return [];

  return pages.slice(0, options.maxOptions).map(({ article, label }) => ({
    label,
    url: article.url,
  }));
}
