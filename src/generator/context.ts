/**
 * Context packing for the model tiers (PRD 5.8.5).
 *
 * Gemini Nano has a small window, so we can't hand it everything retrieval
 * assembled. Articles are kept whole and in rank order until the budget runs
 * out — truncating an article mid-procedure would defeat the point of
 * assembling it, and a citation whose text was cut is worse than one absent.
 */

import type { RetrievedArticle } from "@/domain/retrieval.js";
import { estimateTokens } from "@/lib/chunk.js";

/**
 * Nano's practical ceiling once instructions and the question are allowed for.
 *
 * Raised from 1,800 alongside full-page assembly for the top article: a whole
 * help article runs to roughly 1,500 tokens, so the old budget was spent by the
 * first source and the rest were dropped — which showed up as answers that
 * stopped partway through a procedure. Still well inside the session's input
 * quota, and `packContext` keeps articles whole rather than filling to the line.
 */
export const NANO_TOKEN_BUDGET = 3000;
/** PRD 5.8.5: a handful of sources, not the whole result set. */
export const NANO_MAX_ARTICLES = 4;

export interface PackOptions {
  readonly maxArticles: number;
  readonly tokenBudget: number;
}

export const NANO_PACK: PackOptions = {
  maxArticles: NANO_MAX_ARTICLES,
  tokenBudget: NANO_TOKEN_BUDGET,
};

/** BYOK providers have room for the full result set. */
export const BYOK_PACK: PackOptions = { maxArticles: 8, tokenBudget: 12_000 };

/**
 * Select the articles to send, preserving rank order. The best article is
 * always included even if it alone exceeds the budget — sending nothing would
 * guarantee a refusal.
 */
export function packContext(
  articles: readonly RetrievedArticle[],
  options: PackOptions = NANO_PACK,
): RetrievedArticle[] {
  const out: RetrievedArticle[] = [];
  let tokens = 0;

  for (const article of articles) {
    if (out.length >= options.maxArticles) break;
    const cost = estimateTokens(article.body);
    if (out.length > 0 && tokens + cost > options.tokenBudget) break;
    out.push(article);
    tokens += cost;
  }
  return out;
}
