/**
 * A persistent cache of finished answers.
 *
 * `retrieval/cache.ts` caches the search and says, correctly for its time, that
 * generation still runs so a cached turn streams fresh text. That stopped being
 * free when BYOK arrived: the user now pays their own money, twice, for an
 * answer already sitting on their machine. Re-asking is not rare — people
 * rephrase, they reopen the panel on the same page, and a refinement chip
 * re-queries by design.
 *
 * Echo's canned responses do the same job in Redis with an exact hash plus a
 * kNN fallback. Only the exact half is ported. A near-match lookup needs a
 * query embedding, and needing the embedder would forfeit the entire saving:
 * the point of a hit is that nothing loads, nothing searches and no model runs.
 *
 * The discipline that carries over is the key. Every input that can change the
 * answer goes into it, because a cache that returns the right answer to the
 * wrong question is worse than no cache at all.
 */

import type { SherpaDatabase } from "./db.js";
import type { CachedAnswer } from "./schema.js";
import { fnv1a } from "@/lib/hash.js";

/**
 * Field separator: a NUL, because every part is free text.
 *
 * With a space, an index called "a" and a query "b c" would key identically to
 * an index "a b" and a query "c". Written as an escape rather than a literal
 * byte — a literal NUL makes the file read as binary and grep skips it in
 * silence. Same reasoning as `retrieval/cache.ts`.
 */
const SEP = "\u0000";

export interface AnswerKeyParts {
  readonly indexId: string;
  /**
   * When the index was last written.
   *
   * The most important field here. Without it a re-crawl leaves every cached
   * answer in place, and Sherpa confidently serves answers from pages that have
   * since changed or been deleted — a stale answer that *looks* freshly
   * generated, citing content that no longer says that. The cache is also
   * cleared explicitly after a crawl; this makes the key correct even if that
   * clear is ever missed.
   */
  readonly indexedAt: number;
  /** The question, normalised. See `normaliseQuery`. */
  readonly query: string;
  readonly tier: string;
  /** The exact model, so switching models never reuses the old one's answer. */
  readonly model: string;
  /** Set when the turn was scoped to one page by a refinement pick. */
  readonly focusUrl?: string;
  /**
   * Everything in Settings that changes what comes back.
   *
   * Floors change whether an answer happens at all; reranking, HyDE and query
   * rewriting change which pages ground it. A user who moves a slider and
   * re-asks is testing the slider, and serving them the pre-slider answer would
   * make the setting look broken.
   */
  readonly settingsFingerprint: string;
}

/**
 * Fold away the differences that are not differences.
 *
 * Case and surrounding whitespace only; nothing else. It is tempting to strip
 * punctuation or stem the words, and both are wrong here: "delete user" and
 * "delete user?" may well deserve one answer, but "can I delete a user" and
 * "can't I delete a user" must never collapse, and no cheap normalisation can
 * be trusted to tell those apart. A missed hit costs one ordinary query; a
 * wrong hit puts a confident answer to a question nobody asked on screen.
 */
export function normaliseQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

export function answerKey(parts: AnswerKeyParts): string {
  return fnv1a(
    [
      parts.indexId,
      String(parts.indexedAt),
      normaliseQuery(parts.query),
      parts.tier,
      parts.model,
      parts.focusUrl ?? "",
      parts.settingsFingerprint,
    ].join(SEP),
  );
}

/**
 * Fold the settings that change an answer into one opaque string.
 *
 * Primitives rather than the `Settings` object, so the storage layer does not
 * have to import from `settings` or `retrieval` to describe its own key. The
 * caller passes the *effective* floors — the ones `floorsForIndex` resolved,
 * not the raw stored ones — because a calibrated index answers by its own bands
 * and those are what actually decided the turn.
 */
export function settingsFingerprint(parts: {
  readonly refuseFloor: number;
  readonly confidentFloor: number;
  readonly rerank: boolean;
  readonly hyde: boolean;
  readonly rewriteQueries: boolean;
}): string {
  return [
    parts.refuseFloor.toFixed(3),
    parts.confidentFloor.toFixed(3),
    parts.rerank ? "rr" : "",
    parts.hyde ? "hy" : "",
    parts.rewriteQueries ? "rw" : "",
  ].join("|");
}

export interface AnswerCacheOptions {
  /**
   * How long an answer stays servable.
   *
   * A week. Documentation drifts, and a crawl invalidates by key anyway, so
   * this is only the backstop for an index nobody has refreshed — where a
   * week-old answer to a week-old page is defensible and a year-old one is not.
   */
  readonly ttlMs: number;
  /**
   * Entries kept per index.
   *
   * Answers are text, so the cost is small, but it is not nothing and it sits
   * inside the same storage quota as the index itself — which the crawl is
   * already measured against (`storage/quota.ts`). A cache that can push a
   * crawl over quota would be trading the product's main job for a convenience.
   */
  readonly maxEntriesPerIndex: number;
}

export const DEFAULT_ANSWER_CACHE: AnswerCacheOptions = {
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  maxEntriesPerIndex: 200,
};

export const answerCacheStore = {
  /**
   * Read a cached answer, or nothing.
   *
   * Never throws. A failed read must degrade to "no cache", because the
   * alternative is an unavailable object store — a failed migration, a
   * quota-evicted database — turning every question into an error when the
   * whole feature is an optimisation.
   */
  async get(
    db: SherpaDatabase,
    key: string,
    options: AnswerCacheOptions = DEFAULT_ANSWER_CACHE,
    now = Date.now(),
  ): Promise<CachedAnswer | undefined> {
    try {
      const hit = await db.get("answerCache", key);
      if (!hit) return undefined;
      if (now - hit.at > options.ttlMs) {
        await db.delete("answerCache", key).catch(() => {});
        return undefined;
      }
      // Re-dated on read, so eviction keeps what people actually re-ask and
      // drops the one-off questions. Deliberately not awaited: a hit must not
      // wait on a write to be served.
      void db.put("answerCache", { ...hit, hits: hit.hits + 1, at: now }).catch(() => {});
      return hit;
    } catch {
      return undefined;
    }
  },

  /** Store an answer, then trim the index back to its cap. Never throws. */
  async put(
    db: SherpaDatabase,
    entry: CachedAnswer,
    options: AnswerCacheOptions = DEFAULT_ANSWER_CACHE,
  ): Promise<void> {
    try {
      await db.put("answerCache", entry);
      await answerCacheStore.trim(db, entry.indexId, options);
    } catch {
      // A cache write that fails changes nothing the user can see: the answer
      // is already on screen. Reporting it would be noise.
    }
  },

  /**
   * Hold one index to its cap, least-recently-read first.
   *
   * `at` is the last *read*, not the write, so this is LRU rather than FIFO —
   * an answer asked for every day survives indefinitely, and a question asked
   * once in March does not.
   */
  async trim(
    db: SherpaDatabase,
    indexId: string,
    options: AnswerCacheOptions = DEFAULT_ANSWER_CACHE,
  ): Promise<void> {
    const all = await db.getAllFromIndex("answerCache", "byIndex", indexId);
    if (all.length <= options.maxEntriesPerIndex) return;
    const doomed = all
      .slice()
      .sort((a, b) => a.at - b.at)
      .slice(0, all.length - options.maxEntriesPerIndex);
    const tx = db.transaction("answerCache", "readwrite");
    await Promise.all([...doomed.map((e) => tx.store.delete(e.key)), tx.done]);
  },

  /**
   * Drop every answer for one index.
   *
   * Called when the index changes underneath them — a crawl, an import, a
   * refinement pick that reorders the priors. The key already carries
   * `indexedAt` so a missed call cannot serve stale content; this keeps the
   * store from accumulating generations of unreachable entries.
   */
  async clearIndex(db: SherpaDatabase, indexId: string): Promise<void> {
    try {
      const keys = await db.getAllKeysFromIndex("answerCache", "byIndex", indexId);
      const tx = db.transaction("answerCache", "readwrite");
      await Promise.all([...keys.map((k) => tx.store.delete(k)), tx.done]);
    } catch {
      // Same reasoning as `put`: this is housekeeping, not correctness.
    }
  },

  async clearAll(db: SherpaDatabase): Promise<void> {
    try {
      await db.clear("answerCache");
    } catch {
      /* see clearIndex */
    }
  },

  /** For the Options page: how much is cached, and how much it has saved. */
  async stats(db: SherpaDatabase, indexId: string): Promise<{ entries: number; hits: number }> {
    try {
      const all = await db.getAllFromIndex("answerCache", "byIndex", indexId);
      return {
        entries: all.length,
        // `hits` counts reads, so a fresh entry sits at 0 and the total is the
        // number of questions that cost nothing.
        hits: all.reduce((sum, e) => sum + e.hits, 0),
      };
    } catch {
      return { entries: 0, hits: 0 };
    }
  },
};
