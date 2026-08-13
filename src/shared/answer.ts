/**
 * Wire shapes shared between the offscreen answer service and the side panel.
 * Kept React-free so both contexts can import it. RetrievedChunks are mapped to
 * these light source cards before crossing the message boundary.
 */

import type { AnswerTier } from "@/domain/generator.js";
import type { RetrievedArticle } from "@/domain/retrieval.js";
import type { RefusalReason } from "@/generator/answerService.js";
import type { Certainty } from "@/retrieval/confidence.js";
import type { RefineOption } from "@/retrieval/refine.js";
import type { Facet } from "@/retrieval/facet.js";

export type { RefusalReason };

export interface WireSource {
  readonly index: number;
  readonly title: string;
  readonly breadcrumb: string;
  readonly snippet: string;
  readonly relevance: number;
  readonly url: string;
  readonly displayUrl: string;
}

export type PanelEvent =
  | {
      readonly kind: "sources";
      readonly tier: AnswerTier;
      readonly sources: readonly WireSource[];
      /** Why the tier in use differs from the one the user selected. */
      readonly notice?: string;
      /** "uncertain" when the best match was middling — shown as a caveat. */
      readonly certainty: Certainty;
    }
  | {
      readonly kind: "refine";
      readonly options: readonly RefineOption[];
      readonly facet?: Facet;
    }
  | { readonly kind: "delta"; readonly delta: string }
  | {
      readonly kind: "refusal";
      readonly nearest: readonly WireSource[];
      readonly reason: RefusalReason;
    }
  | { readonly kind: "done" };

function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname).replace(/\/$/, "");
  } catch {
    return url;
  }
}

/**
 * A text-fragment URL (#:~:text=) so the browser scrolls to and highlights the
 * passage in-page natively — no content script needed (PRD 5.9.5).
 *
 * Anchored on the article's best-matching chunk rather than its first, so the
 * link lands on the part that answered the question.
 */
function highlightUrl(article: RetrievedArticle): string {
  const best = article.chunks.find((c) => !c.viaNeighbour) ?? article.chunks[0];
  const words = (best?.body ?? "").replace(/\s+/g, " ").trim().split(" ").slice(0, 8).join(" ");
  if (!words) return article.anchor ? `${article.url}#${article.anchor}` : article.url;
  return `${article.url}#:~:text=${encodeURIComponent(words)}`;
}

/**
 * Interface text that leaked into stored titles before extraction learned to
 * strip it — a copy-link button's "Copied!" confirmation, most often.
 */
const TITLE_NOISE = /\s*(copied!?|copy link|copy|share|permalink)\s*$/i;

/**
 * Tidy a stored title for display.
 *
 * Extraction now keeps this text out at crawl time, but an index built before
 * that fix still holds it, and re-crawling thousands of pages to correct a
 * label is a poor trade. Cleaning on the way to the card fixes existing indexes
 * immediately and costs nothing on new ones.
 */
export function cleanTitle(title: string): string {
  let out = title.trim();
  for (let i = 0; i < 2; i++) out = out.replace(TITLE_NOISE, "").trim();
  return out || title.trim();
}

/**
 * Collapse repeated crumbs in a stored heading path.
 *
 * Breadcrumb extraction used to count each crumb twice, giving trails like
 * "Help & Support > Help & Support > Asset Hub > Asset Hub". Same reasoning as
 * above: fix it on display so existing indexes read correctly.
 */
export function cleanHeadingPath(path: string): string {
  const parts = path.split(">").map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    if (out[out.length - 1]?.toLowerCase() === part.toLowerCase()) continue;
    out.push(cleanTitle(part));
  }
  return out.join(" › ");
}

/**
 * The relevance figure on a source card.
 *
 * Not the RRF score: reciprocal rank fusion produces values around 1/(60+rank),
 * so every card read "3% relevant" however good the match — a number that
 * actively misleads. Cosine similarity is on a scale that means something, and
 * a chunk found only by BM25 falls back to its rank rather than claiming a
 * similarity it doesn't have.
 */
export function relevancePercent(article: RetrievedArticle): number {
  // Cosine similarity, not the fused rank score: the latter is min-max
  // normalised per query, so the top result would always read 100%. This is on
  // the same absolute scale as the refusal floor, so a card can never claim
  // high relevance beside a refusal that says nothing cleared it.
  if (article.similarity === undefined) return 0;
  return Math.max(0, Math.min(100, Math.round(article.similarity * 100)));
}

/**
 * Map an assembled article to a source card.
 *
 * `position` is the 0-based array index; citations are 1-based so the card
 * numbers line up with the `[n]` markers the grounding prompt emits — both now
 * enumerate the same articles.
 */
export function articleToSource(article: RetrievedArticle, position: number): WireSource {
  const snippet = article.body.slice(0, 240).trim();
  return {
    index: position + 1,
    title: cleanTitle(article.title) || cleanHeadingPath(article.headingPath) || "Untitled",
    breadcrumb: cleanHeadingPath(article.headingPath),
    snippet: snippet + (article.body.length > 240 ? "…" : ""),
    relevance: relevancePercent(article),
    url: highlightUrl(article),
    displayUrl: displayUrl(article.url),
  };
}
