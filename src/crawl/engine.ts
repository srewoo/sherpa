/**
 * Crawl orchestrator (PRD 5.2). Pulls the frontier in concurrency-sized waves,
 * paces dispatches, honours robots + scope + caps, retries transient errors
 * with backoff, and pauses on an auth wall. All I/O is injected (fetcher, link
 * extractor, sleep, clock) so the loop is unit-testable without a network.
 */

import type { CrawlConfig } from "@/domain/config.js";
import type { AuthWall, Fetcher, FetchResult, LinkExtractor } from "@/domain/crawl.js";
import type { SherpaDatabase } from "@/storage/db.js";
import { canonicalizeUrl, underRoot } from "@/lib/url.js";
import { inScope } from "@/lib/patterns.js";
import { isAllowed, type Robots } from "@/lib/robots.js";
import { frontier } from "./frontier.js";
import { Pacer, intervalFromRps } from "./politeness.js";
import { FailureTracker, backoffMs, isTransient } from "./backoff.js";
import { detectAuthWall } from "./authwall.js";

const MAX_ATTEMPTS = 4;

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
  /** Hand a fetched page to extraction/embedding (milestone #4). */
  readonly onPage: (res: FetchResult, depth: number) => Promise<void>;
  readonly onProgress?: () => void;
  readonly onAuthWall?: (wall: AuthWall) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly shouldStop?: () => boolean;
}

interface Stop {
  flag: boolean;
  outcome: CrawlOutcome | null;
}

export async function runCrawl(deps: CrawlDeps): Promise<CrawlOutcome> {
  const { db, indexId, config } = deps;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => performance.now());
  const pacer = new Pacer(intervalFromRps(config.requestsPerSecond));
  const failures = new FailureTracker(config.failureCeiling);
  const stop: Stop = { flag: false, outcome: null };
  let donePages = 0;

  const rootHost = new URL(config.root).hostname;

  const harvest = async (res: FetchResult, depth: number): Promise<void> => {
    if (depth >= config.maxDepth) return;
    for (const raw of deps.extractLinks(res.html ?? "", res.finalUrl)) {
      const c = canonicalizeUrl(raw, res.finalUrl);
      if (!c || !underRoot(c, config.root) || !inScope(c, config.scope)) continue;
      await frontier.enqueue(db, indexId, c, depth + 1);
    }
  };

  const fetchWithRetry = async (url: string): Promise<FetchResult> => {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      await sleep(pacer.reserve(now()));
      const res = await deps.fetcher(url);
      if (isTransient(res.status) && attempt < MAX_ATTEMPTS) {
        await sleep(backoffMs(attempt));
        continue;
      }
      return res;
    }
  };

  const processEntry = async (url: string, depth: number): Promise<void> => {
    if (stop.flag) return;
    const path = new URL(url).pathname + new URL(url).search;
    if (depth > config.maxDepth || donePages >= config.maxPages || !isAllowed(deps.robots, path, deps.userAgent)) {
      await frontier.mark(db, indexId, url, "skipped");
      return;
    }

    const res = await fetchWithRetry(url);
    const wall = detectAuthWall(res, rootHost);
    if (wall) {
      deps.onAuthWall?.(wall);
      stop.flag = true;
      stop.outcome = { reason: "auth", wall };
      return;
    }

    if (res.status >= 200 && res.status < 300 && res.html !== null) {
      await deps.onPage(res, depth);
      await frontier.mark(db, indexId, url, "done");
      donePages += 1;
      failures.record(false);
      await harvest(res, depth);
    } else {
      await frontier.mark(db, indexId, url, "failed");
      if (failures.record(true)) {
        stop.flag = true;
        stop.outcome = { reason: "failed", status: res.status };
      }
    }
  };

  for (;;) {
    if (deps.shouldStop?.()) return { reason: "paused" };
    const batch = await frontier.nextQueued(db, indexId, config.concurrency);
    if (batch.length === 0) return stop.outcome ?? { reason: "done" };
    await Promise.all(batch.map((e) => processEntry(e.url, e.depth)));
    deps.onProgress?.();
    if (stop.outcome) return stop.outcome;
  }
}
