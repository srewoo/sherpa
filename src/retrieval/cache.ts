/**
 * A small LRU over retrieval results.
 *
 * Users re-ask. They rephrase and come back, they reopen the panel on the same
 * page, and — now that a refinement chip re-queries by design — the same text
 * can arrive twice in as many seconds. Retrieval is fast (p95 well inside the
 * 150 ms budget) but not free: it embeds the query, scans the full vector
 * matrix, runs BM25 twice for pseudo-relevance feedback, and may wake a
 * cross-encoder.
 *
 * Scope is deliberately narrow. This caches the *search*, not the answer —
 * generation still runs, so a cached turn still streams fresh text. And the key
 * carries every input that changes the result, because a cache that returns the
 * right answer to the wrong question is worse than no cache at all.
 */

import type { RetrieveResult } from "./retrieve.js";

export interface CacheKeyParts {
  readonly indexId: string;
  readonly search: string;
  readonly denseText?: string;
  readonly currentUrl?: string;
  readonly focusUrl?: string;
  /**
   * Whether the cross-encoder ran.
   *
   * `getReranker()` returns undefined while the weights are still loading and
   * after a transient failure, so the same query can legitimately be reranked
   * on one turn and not the next. Without this in the key, the first
   * un-reranked result would be served for the rest of the TTL — the reranker
   * would appear not to work, with nothing to show why.
   */
  readonly reranked?: boolean;
}

/**
 * Every field that can change the result set.
 *
 * `denseText` is included because HyDE is generative: the same question can
 * produce a different passage on a later turn, and treating those as one query
 * would serve a result the current inputs never produced. Priors are covered by
 * invalidation rather than the key — a pick clears the cache outright.
 */
/**
 * Field separator. A NUL rather than a space, because every part is free text:
 * with a space, an index called "a" and a query "b c" would key identically to
 * an index "a b" and a query "c". Written as an escape and not a literal byte —
 * a literal NUL makes the whole file read as binary, and grep skips it silently.
 */
const SEP = "\u0000";

export function cacheKey(parts: CacheKeyParts): string {
  return [
    parts.indexId,
    parts.search,
    parts.denseText ?? "",
    parts.currentUrl ?? "",
    parts.focusUrl ?? "",
    parts.reranked ? "rr" : "",
  ].join(SEP);
}

export interface ResultCacheOptions {
  /** Entries retained. Small: this is a conversation, not a workload. */
  readonly maxEntries: number;
  /** How long an entry stays valid. Docs drift; so should the cache. */
  readonly ttlMs: number;
}

export const DEFAULT_RESULT_CACHE: ResultCacheOptions = {
  maxEntries: 20,
  ttlMs: 5 * 60 * 1000,
};

interface Entry {
  readonly result: RetrieveResult;
  readonly at: number;
}

export class ResultCache {
  /** Insertion order is recency order: Map preserves it, and re-set re-dates. */
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly options: ResultCacheOptions = DEFAULT_RESULT_CACHE) {}

  get(key: string, now = Date.now()): RetrieveResult | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (now - hit.at > this.options.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh recency without refreshing the age — an entry that keeps being
    // read is still an entry that keeps getting older.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.result;
  }

  set(key: string, result: RetrieveResult, now = Date.now()): void {
    this.entries.delete(key);
    this.entries.set(key, { result, at: now });
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  clear(indexId?: string): void {
    if (indexId === undefined) {
      this.entries.clear();
      return;
    }
    const prefix = `${indexId}${SEP}`;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/** The offscreen document's cache. One per context, like the index session. */
export const resultCache = new ResultCache();
