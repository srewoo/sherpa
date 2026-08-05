/**
 * Crawl orchestrator (PRD 5.2). Pulls the frontier in concurrency-sized waves,
 * paces dispatches, honours robots + scope + caps, retries transient errors
 * with backoff, and pauses on an auth wall. All I/O is injected (fetcher, link
 * extractor, sleep, clock) so the loop is unit-testable without a network.
 */

import type { CrawlConfig } from "@/domain/config.js";
import type { AuthWall, Fetcher, FetchResult, LinkExtractor, Validators } from "@/domain/crawl.js";
import type { SherpaDatabase } from "@/storage/db.js";
import { canonicalizeUrl, underRoot } from "@/lib/url.js";
import { inScope } from "@/lib/patterns.js";
import { isAllowed, crawlDelay, type Robots } from "@/lib/robots.js";
import { isNoindex } from "@/lib/noindex.js";
import { frontier } from "./frontier.js";
import { Pacer, intervalFromRps } from "./politeness.js";
import { FailureTracker, backoffMs, isTransient, isInfrastructureFailure } from "./backoff.js";
import { detectAuthWall, isLoginShell } from "./authwall.js";
import { isUnsafeToFetch } from "./safety.js";

const MAX_ATTEMPTS = 4;

/**
 * How many consecutive auth-blocked responses before we treat the site as
 * genuinely gated and stop. A single 403 is routine on a help centre — one
 * admin-only article must not abort a 2,000-page crawl (PRD 5.2.8).
 */
export const AUTH_WALL_STREAK = 3;

export type CrawlOutcome =
  | { readonly reason: "done" }
  | { readonly reason: "paused" }
  | { readonly reason: "auth"; readonly wall: AuthWall }
  | { readonly reason: "failed"; readonly status: number };

export interface CrawlDeps {
  readonly db: SherpaDatabase;
  readonly indexId: string;
  readonly config: CrawlConfig;
  readonly robots: Robots;
  readonly userAgent: string;
  readonly fetcher: Fetcher;
  readonly extractLinks: LinkExtractor;
  /** Hand a fetched page to extraction/embedding. */
  readonly onPage: (res: FetchResult, depth: number) => Promise<void>;
  readonly onProgress?: () => void;
  readonly onAuthWall?: (wall: AuthWall) => void;
  /** Fired when transient failures are requeued for a final attempt. */
  readonly onRetrySweep?: (requeued: number) => void;
  /** Fired when a fetched page could not be indexed. */
  readonly onIndexError?: (url: string, error: unknown) => void;
  /**
   * Cache validators for a URL from a previous crawl. Supplied on an
   * incremental recrawl so unchanged pages answer 304 with no body — the
   * difference between re-downloading a 1,000-page site and confirming it
   * (PRD 5.6.5). Omitted for a first crawl or a full rebuild.
   */
  readonly validatorsFor?: (url: string) => Promise<Validators | undefined>;
  /** Fired when a page came back 304, so progress can report it. */
  readonly onUnchanged?: (url: string) => void;
  /** How many end-of-crawl retry passes to make. Defaults to one. */
  readonly retrySweeps?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly shouldStop?: () => boolean;
  /**
   * Pages already indexed for this crawl, so the max-pages ceiling survives a
   * pause/resume or a browser restart instead of re-arming from zero (5.2.2).
   */
  readonly alreadyDone?: number;
}

interface Stop {
  flag: boolean;
  outcome: CrawlOutcome | null;
}

export async function runCrawl(deps: CrawlDeps): Promise<CrawlOutcome> {
  const { db, indexId, config } = deps;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => performance.now());

  // Politeness is the *slower* of the user's rate and the site's Crawl-delay:
  // robots.txt asking us to back off always wins (PRD 5.2.4).
  const declared = crawlDelay(deps.robots, deps.userAgent);
  const interval = Math.max(
    intervalFromRps(config.requestsPerSecond),
    declared !== undefined ? Math.ceil(declared * 1000) : 0,
  );
  const pacer = new Pacer(interval);

  const failures = new FailureTracker(config.failureCeiling);
  const stop: Stop = { flag: false, outcome: null };
  let donePages = deps.alreadyDone ?? 0;
  let authStreak = 0;

  const rootHost = new URL(config.root).hostname;

  const harvest = async (res: FetchResult, depth: number): Promise<void> => {
    if (depth >= config.maxDepth) return;
    for (const raw of deps.extractLinks(res.html ?? "", res.finalUrl)) {
      const c = canonicalizeUrl(raw, res.finalUrl);
      if (!c || !underRoot(c, config.root) || !inScope(c, config.scope)) continue;
      // Never queue a logout link or a binary attachment (see safety.ts).
      if (isUnsafeToFetch(c)) continue;
      await frontier.enqueue(db, indexId, c, depth + 1);
    }
  };

  const fetchWithRetry = async (url: string): Promise<FetchResult> => {
    const validators = await deps.validatorsFor?.(url);
    let attempt = 0;
    for (;;) {
      attempt += 1;
      await sleep(pacer.reserve(now()));
      const res = await deps.fetcher(url, validators);
      if (isTransient(res.status) && attempt < MAX_ATTEMPTS) {
        await sleep(backoffMs(attempt));
        continue;
      }
      return res;
    }
  };

  const processEntry = async (url: string, depth: number): Promise<void> => {
    if (stop.flag) return;

    // Second line of defence: a URL can reach the frontier from a sitemap or a
    // resumed crawl seeded before this check existed.
    if (isUnsafeToFetch(url)) {
      await frontier.mark(db, indexId, url, "skipped");
      return;
    }

    const path = new URL(url).pathname + new URL(url).search;
    if (depth > config.maxDepth || donePages >= config.maxPages || !isAllowed(deps.robots, path, deps.userAgent)) {
      await frontier.mark(db, indexId, url, "skipped");
      return;
    }

    const res = await fetchWithRetry(url);

    // 304 Not Modified: the page is byte-for-byte what we already indexed, so
    // there is nothing to extract, chunk or embed. It still counts as done.
    if (res.status === 304) {
      deps.onUnchanged?.(url);
      await frontier.mark(db, indexId, url, "done");
      donePages += 1;
      failures.record(false);
      return;
    }

    const wall = detectAuthWall(res, rootHost);
    if (wall) {
      authStreak += 1;
      await frontier.mark(db, indexId, url, "failed");
      // A 401 challenge or a served login page is unambiguous — stop at once.
      // A bare 403 only counts once several cluster, since one gated article
      // is normal on a help centre.
      const unambiguous = res.status === 401 || isLoginShell(res.html);
      if (unambiguous || authStreak >= AUTH_WALL_STREAK) {
        deps.onAuthWall?.(wall);
        stop.flag = true;
        stop.outcome = { reason: "auth", wall };
      }
      return;
    }
    authStreak = 0;

    if (res.status >= 200 && res.status < 300 && res.html !== null) {
      // `noindex` keeps a page out of the index but not out of the crawl — its
      // links still lead to indexable pages (PRD 5.2.4).
      if (isNoindex(res.html, res.robotsTag)) {
        await frontier.mark(db, indexId, url, "skipped");
        failures.record(false);
        await harvest(res, depth);
        return;
      }
      try {
        await deps.onPage(res, depth);
      } catch (err) {
        // Extraction, chunking, embedding or storage threw. Previously this
        // rejected straight out of the crawl loop: one unparseable page, or a
        // momentary IndexedDB error, silently killed a 2,000-page crawl with
        // no record of why. Fail the page, keep the crawl, let the end-of-run
        // sweep try it once more.
        deps.onIndexError?.(url, err);
        await frontier.mark(db, indexId, url, "failed", { reason: "indexing" });
        if (failures.record(true)) {
          stop.flag = true;
          stop.outcome = { reason: "failed", status: res.status };
        }
        // Its links may still lead somewhere indexable.
        await harvest(res, depth);
        return;
      }
      await frontier.mark(db, indexId, url, "done");
      donePages += 1;
      failures.record(false);
      await harvest(res, depth);
    } else {
      // Record the status so the failure log can explain it and the end-of-run
      // sweep can tell a transient 500 from a permanent 404 (PRD 5.2.10).
      await frontier.mark(db, indexId, url, "failed", { lastStatus: res.status });

      /**
       * Only an infrastructure failure counts toward stopping (see
       * `isInfrastructureFailure`). A 404 is logged and left failed, but it is
       * deliberately *neutral* for the streak — neither incrementing it nor
       * resetting it. Resetting would be just as wrong as counting: a run of
       * 503s interrupted by one dead link is still a site falling over, and
       * clearing the streak there would disarm the breaker exactly when it
       * matters.
       */
      if (isInfrastructureFailure(res.status) && failures.record(true)) {
        stop.flag = true;
        stop.outcome = { reason: "failed", status: res.status };
      }
    }
  };

  let sweepsLeft = deps.retrySweeps ?? 1;

  for (;;) {
    if (deps.shouldStop?.()) return { reason: "paused" };
    const batch = await frontier.nextQueued(db, indexId, config.concurrency);

    if (batch.length === 0) {
      if (stop.outcome) return stop.outcome;
      // The frontier has drained. Before calling it done, give transient
      // failures — a 5xx or a dropped connection during a long crawl — one
      // more attempt (PRD 5.2.5). Permanent ones stay failed.
      if (sweepsLeft > 0) {
        sweepsLeft -= 1;
        const requeued = await frontier.requeueRetryable(db, indexId);
        if (requeued > 0) {
          deps.onRetrySweep?.(requeued);
          deps.onProgress?.();
          continue;
        }
      }
      return { reason: "done" };
    }

    await Promise.all(batch.map((e) => processEntry(e.url, e.depth)));
    deps.onProgress?.();
    if (stop.outcome) return stop.outcome;
  }
}
