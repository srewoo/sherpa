/**
 * Learning from picks.
 *
 * Every time someone clicks a refinement chip they are answering the question
 * retrieval could not: *for this wording, this is the right document.* That is
 * a relevance label — the expensive kind, produced by a human who knew what
 * they wanted — and it was being written to the query log and never read.
 *
 * This is the one capability a local index has that a hosted one structurally
 * cannot match. A server-side engine can learn from clicks too, but only by
 * shipping every query off the machine first. Here the signal is generated,
 * stored and applied without leaving the browser, so the privacy position is
 * unchanged and the retrieval gets better the more the index is used.
 *
 * Two constraints keep it honest:
 *
 *  - **Ranking only.** The boost is applied to `rankScore`, never `similarity`.
 *    Absolute cosine is what the refusal floor compares against, so a prior can
 *    reorder what is shown but can never argue Sherpa into answering something
 *    it would otherwise decline. Same discipline as the cross-encoder.
 *  - **Bounded and decaying.** One click cannot pin a page to the top forever.
 *    The multiplier saturates, and it fades with age, because documentation
 *    changes and so does what people are looking for.
 */

import type { QueryLogEntry } from "@/storage/schema.js";
import type { SherpaDatabase } from "@/storage/db.js";
import { queryLogStore } from "@/gap/queryLog.js";
import { distinctiveTerms } from "./followUp.js";

export interface PickPrior {
  readonly url: string;
  /**
   * Distinctive words of the questions that led here, and how often each one
   * did — not a flat set.
   *
   * The count has to be per *term*, not per page. A hub page picked once each
   * for six unrelated questions accumulates six questions' vocabulary, and a
   * page-level count would then give it the same confidence on any one of them
   * as a page chosen three times for precisely this wording. Evidence is about
   * how often *these words* led here, which is what the ranking is trying to
   * predict.
   */
  readonly terms: ReadonlyMap<string, number>;
  /** Picks in total. Reporting only — never used to score. */
  readonly count: number;
  /** Most recent pick, for decay. */
  readonly lastAt: number;
}

export type PriorIndex = readonly PickPrior[];

export interface PriorOptions {
  /**
   * Ceiling on the multiplier. Deliberately the same order as the section boost
   * (1.15): a learned preference is a nudge among ranked results, not an
   * override of the retrievers.
   */
  readonly maxBoost: number;
  /** Repeats of a term beyond this add no further confidence. */
  readonly saturateAt: number;
  /** Days for a prior's influence to halve. */
  readonly halfLifeDays: number;
  /** Most recent log entries to consider. Keeps a long-lived index cheap. */
  readonly maxEntries: number;
}

export const DEFAULT_PRIOR: PriorOptions = {
  maxBoost: 1.12,
  saturateAt: 3,
  halfLifeDays: 30,
  maxEntries: 500,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Fold logged picks into one prior per page. */
export function buildPriors(
  entries: readonly QueryLogEntry[],
  options: PriorOptions = DEFAULT_PRIOR,
): PriorIndex {
  const recent = [...entries]
    .filter((e) => e.pickedUrl)
    .sort((a, b) => b.at - a.at)
    .slice(0, options.maxEntries);

  const byUrl = new Map<string, { terms: Map<string, number>; count: number; lastAt: number }>();
  for (const entry of recent) {
    const url = entry.pickedUrl as string;
    const existing = byUrl.get(url) ?? { terms: new Map<string, number>(), count: 0, lastAt: 0 };
    // The question the pick answered, not the chip's label — see schema.ts.
    // Older records predate the field and fall back to `query`, which is the
    // label and mostly self-matching, but harmless.
    for (const term of distinctiveTerms(entry.pickedFor ?? entry.query)) {
      existing.terms.set(term, (existing.terms.get(term) ?? 0) + 1);
    }
    existing.count += 1;
    existing.lastAt = Math.max(existing.lastAt, entry.at);
    byUrl.set(url, existing);
  }

  return [...byUrl.entries()].map(([url, v]) => ({
    url,
    terms: v.terms,
    count: v.count,
    lastAt: v.lastAt,
  }));
}

/**
 * Multiplier per URL for this query, or an empty map when nothing applies.
 *
 * Strength is the average per-term evidence across the *query's* words, so both
 * halves of the obvious failure are covered: a page that matches only one word
 * of a six-word question gets little, and a page that matched every word but
 * only once gets less than one chosen repeatedly for the same wording.
 */
export function priorBoosts(
  query: string,
  priors: PriorIndex,
  now: number,
  options: PriorOptions = DEFAULT_PRIOR,
): ReadonlyMap<string, number> {
  const terms = distinctiveTerms(query);
  const out = new Map<string, number>();
  if (terms.length === 0 || priors.length === 0) return out;

  for (const prior of priors) {
    // Each query term contributes at most 1, reached when this page has been
    // picked `saturateAt` times for a question containing that word.
    let evidence = 0;
    for (const term of terms) {
      const seen = prior.terms.get(term) ?? 0;
      if (seen > 0) evidence += Math.min(1, seen / options.saturateAt);
    }
    if (evidence === 0) continue;

    const ageDays = Math.max(0, (now - prior.lastAt) / DAY_MS);
    const recency = Math.pow(2, -ageDays / options.halfLifeDays);

    const strength = (evidence / terms.length) * recency;
    if (strength <= 0) continue;
    out.set(prior.url, 1 + strength * (options.maxBoost - 1));
  }
  return out;
}

/**
 * Cached per index, and deliberately *not* part of `IndexSession`.
 *
 * A pick invalidates priors on every click, and the session cache holds the
 * vector matrix and the BM25 index — rebuilding those to record one click would
 * cost a cold load (hundreds of milliseconds) for a few bytes of new signal.
 * Keeping them apart means invalidation is cheap enough to be immediate.
 */
const cache = new Map<string, Promise<PriorIndex>>();

export function loadPriors(db: SherpaDatabase, indexId: string): Promise<PriorIndex> {
  let entry = cache.get(indexId);
  if (!entry) {
    entry = queryLogStore
      .listByIndex(db, indexId)
      .then((entries) => buildPriors(entries))
      .catch(() => {
        cache.delete(indexId);
        // A log that won't read is not a reason to fail a search.
        return [] as PriorIndex;
      });
    cache.set(indexId, entry);
  }
  return entry;
}

export function invalidatePriors(indexId?: string): void {
  if (indexId === undefined) cache.clear();
  else cache.delete(indexId);
}
