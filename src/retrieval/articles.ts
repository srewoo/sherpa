/**
 * Article assembly (PRD 5.7.4, 5.7.5).
 *
 * Retrieval scores chunks; answers cite articles. This groups the ranked chunks
 * by page, expands each match by its neighbours so a procedure stays whole,
 * and joins them into one contiguous passage per article — ordered by the best
 * chunk each article contributed.
 *
 * Merging replaces the old `maxPerPage` cap, which existed only to stop one
 * long page filling the result list. Grouping handles that properly: a page
 * appears once however many of its chunks matched, and all of them inform the
 * answer.
 */

import type { RetrievedArticle, RetrievedChunk } from "@/domain/retrieval.js";
import type { StoredChunk } from "@/domain/records.js";

export interface AssembleOptions {
  /** Chunks either side of a match to pull in. */
  readonly neighbourSpan: number;
  /** Maximum articles to return. */
  readonly maxArticles: number;
  /** Cap on an assembled article's text, so one huge page can't fill context. */
  readonly maxBodyChars: number;
  /**
   * Give the best-ranked article its whole page rather than a window around
   * its matches.
   *
   * Help content is procedural, and a procedure does not survive being sampled.
   * "How do I create a roleplay mission" matches the chunk holding steps 1–2,
   * and a span of one neighbour hands the model exactly that — so the answer
   * confidently stops at step 2 and looks complete, because nothing in the
   * context suggests there were ever steps 3 onward. Truncation the model
   * cannot see is worse than truncation it can.
   *
   * Only the top article, and still bounded by `maxBodyChars`: the answer is
   * usually grounded in one page, and widening every article would crowd the
   * others out of a small context window instead.
   *
   * Conditional rather than unconditional — see `shouldExpandFullPage`. Applied
   * to every top article regardless, a long page eats the whole context budget
   * and starves the other sources, which turned one bug (answers stopping
   * early) into another (answers that read one page and ignore its siblings).
   */
  readonly fullPageForTop: boolean;
  /**
   * Longest page worth including whole. Past this it is not "the article", it
   * is a manual — window it and let the other sources keep their room.
   */
  readonly fullPageMaxChars: number;
  /**
   * How far ahead of the runner-up the top article must score, as a fraction of
   * its own score, before it earns the whole page.
   *
   * A clear winner is a question with one home in the docs, and the answer will
   * be built almost entirely from it — completeness there is worth the tokens.
   * A close field is a question spanning several pages, where breadth beats
   * depth and spending the budget on one page is the wrong trade.
   */
  readonly fullPageMinGap: number;
}

export const DEFAULT_ASSEMBLE: AssembleOptions = {
  // Two chunks either side rather than one: a step and its screenshot caption
  // routinely land in separate chunks, so a span of one still cuts procedures.
  neighbourSpan: 2,
  /**
   * The ceiling for the widest tier, not a per-answer count.
   *
   * Retrieval is tier-agnostic by design, so this has to cover the most
   * capacious consumer — BYOK, whose 12k-token budget wants eight articles.
   * At 5 that budget was unreachable and a paid model was being handed five
   * sources for no stated reason. Each tier trims to its own `pack` in the
   * answer service, so Nano still sees four.
   */
  maxArticles: 8,
  maxBodyChars: 6_000,
  fullPageForTop: true,
  fullPageMaxChars: 8_000,
  fullPageMinGap: 0.1,
};

/**
 * Does the best article earn its whole page?
 *
 * Pure, because this is a judgement call with two failure directions and both
 * have already been observed: too eager and one long page crowds out every
 * other source; too shy and the answer stops halfway through a procedure.
 */
export function shouldExpandFullPage(
  best: number,
  runnerUp: number | undefined,
  pageChars: number,
  options: AssembleOptions,
): boolean {
  if (!options.fullPageForTop) return false;
  if (pageChars > options.fullPageMaxChars) return false;
  // Nothing to compete with: the whole answer comes from here either way.
  if (runnerUp === undefined) return true;
  if (best <= 0) return false;
  // Epsilon because a gap that is mathematically exactly the threshold isn't,
  // in floats: 1.0 - 0.9 is 0.09999999999999998, and a rule that flips on that
  // is a rule nobody can reason about from the number they configured.
  return (best - runnerUp) / best >= options.fullPageMinGap - 1e-9;
}

/** A scored chunk plus the page it belongs to. */
export interface ScoredChunk {
  readonly chunk: StoredChunk;
  /** Fused rank score — ordering only. */
  readonly rankScore: number;
  /** Absolute cosine similarity. */
  readonly similarity: number | undefined;
  readonly denseRank: number | undefined;
  readonly sparseRank: number | undefined;
}

/**
 * Group ranked chunks into articles.
 *
 * `pageChunks` supplies every chunk of a page so neighbours can be pulled in;
 * ranked order is preserved, so the first article is the one holding the single
 * best chunk.
 */
export function assembleArticles(
  ranked: readonly ScoredChunk[],
  pageChunks: ReadonlyMap<string, readonly StoredChunk[]>,
  options: AssembleOptions = DEFAULT_ASSEMBLE,
): RetrievedArticle[] {
  const order: string[] = [];
  const matchesByUrl = new Map<string, ScoredChunk[]>();

  for (const scored of ranked) {
    const url = scored.chunk.url;
    const existing = matchesByUrl.get(url);
    if (existing) {
      existing.push(scored);
      continue;
    }
    if (order.length >= options.maxArticles) continue;
    order.push(url);
    matchesByUrl.set(url, [scored]);
  }

  // The runner-up's best score decides whether the leader is a clear winner.
  const bestOf = (url: string): number =>
    (matchesByUrl.get(url) ?? []).reduce((max, m) => Math.max(max, m.rankScore), 0);
  const leader = order[0] === undefined ? 0 : bestOf(order[0]);
  const runnerUp = order[1] === undefined ? undefined : bestOf(order[1]);

  return order.map((url, rank) => {
    const pageChars = (pageChunks.get(url) ?? []).reduce((n, c) => n + c.body.length, 0);
    const wholePage =
      rank === 0 && shouldExpandFullPage(leader, runnerUp, pageChars, options);
    return build(url, matchesByUrl.get(url) ?? [], pageChunks, options, wholePage);
  });
}

function build(
  url: string,
  matches: readonly ScoredChunk[],
  pageChunks: ReadonlyMap<string, readonly StoredChunk[]>,
  options: AssembleOptions,
  wholePage: boolean,
): RetrievedArticle {
  const page = pageChunks.get(url) ?? matches.map((m) => m.chunk);
  const best = matches.reduce((a, b) => (b.rankScore > a.rankScore ? b : a));

  // Positions to include: every match, plus its neighbours — or the whole page
  // when this is the article the answer will mostly be built from.
  const wanted = new Set<number>();
  if (wholePage) {
    for (const c of page) wanted.add(c.position);
  } else {
    for (const match of matches) {
      for (let d = -options.neighbourSpan; d <= options.neighbourSpan; d++) {
        wanted.add(match.chunk.position + d);
      }
    }
  }

  const matchedIds = new Set(matches.map((m) => m.chunk.vectorId));
  const byPosition = new Map(matches.map((m) => [m.chunk.position, m]));

  const selected = page
    .filter((c) => wanted.has(c.position))
    .sort((a, b) => a.position - b.position);

  const chunks: RetrievedChunk[] = selected.map((c) => {
    const match = byPosition.get(c.position);
    return {
      ...c,
      score: match?.rankScore ?? best.rankScore,
      similarity: match?.similarity,
      denseRank: match?.denseRank,
      sparseRank: match?.sparseRank,
      viaNeighbour: !matchedIds.has(c.vectorId),
    };
  });

  return {
    url,
    title: best.chunk.title || best.chunk.headingPath || "Untitled",
    headingPath: best.chunk.headingPath,
    rankScore: best.rankScore,
    similarity: matches.reduce<number | undefined>(
      (acc, m) => (m.similarity === undefined ? acc : Math.max(acc ?? 0, m.similarity)),
      undefined,
    ),
    anchor: best.chunk.anchor,
    chunks,
    body: joinBodies(chunks, options.maxBodyChars),
  };
}

/**
 * Join an article's chunks into one passage. Truncated at a paragraph boundary
 * where possible, so the model is never handed half a sentence.
 */
function joinBodies(chunks: readonly RetrievedChunk[], maxChars: number): string {
  const joined = chunks.map((c) => c.body.trim()).filter(Boolean).join("\n\n");
  if (joined.length <= maxChars) return joined;

  const cut = joined.slice(0, maxChars);
  const boundary = cut.lastIndexOf("\n\n");
  return boundary > maxChars * 0.5 ? cut.slice(0, boundary) : cut;
}
