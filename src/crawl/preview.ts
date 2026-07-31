/**
 * Pre-crawl preview (PRD 5.1.4, 5.5.6). Before a single page is fetched the
 * user sees how many pages are in scope, how long it will take, and whether it
 * fits on disk — and a crawl that won't fit is refused up front rather than
 * failing halfway through.
 *
 * Discovery I/O and the storage estimate are injected so the whole thing is
 * unit-testable without a network or a browser.
 */

import type { CrawlConfig } from "@/domain/config.js";
import { discoverSeeds, type TextFetcher } from "./discovery.js";
import { canonicalizeUrl, underRoot } from "@/lib/url.js";
import { inScope } from "@/lib/patterns.js";
import { isAllowed, crawlDelay, type Robots } from "@/lib/robots.js";
import { estimateIndexBytes, preflight, type Preflight, type StorageEstimate } from "@/storage/quota.js";

/**
 * Seconds of embedding per page on the WASM backend. Measured against the PRD's
 * own budget (M6: 2,000 pages in under 25 min) and deliberately conservative —
 * an ETA that overshoots is far less damaging than one that undershoots.
 */
export const EMBED_SECONDS_PER_PAGE = 0.45;

export interface CrawlPreview {
  /** URLs discovered from the sitemap, before scope filtering. */
  readonly discovered: number;
  /** URLs that survive include/exclude, robots and the max-pages cap. */
  readonly inScope: number;
  readonly excluded: number;
  readonly blockedByRobots: number;
  /** Whether a sitemap was found at all — if not, we fall back to link BFS. */
  readonly hasSitemap: boolean;
  readonly estimatedSeconds: number;
  readonly estimatedBytes: number;
  readonly storage: Preflight;
  /** False when the index won't fit; the UI must refuse to start (5.5.6). */
  readonly fits: boolean;
}

/**
 * Wall-clock estimate: fetch time is governed by the politeness interval and
 * concurrency, embedding runs after each fetch. Crawl-delay, when the site
 * declares one, dominates both.
 */
export function estimateSeconds(pages: number, config: CrawlConfig, robots: Robots, userAgent: string): number {
  const declared = crawlDelay(robots, userAgent);
  const perRequest = Math.max(1 / config.requestsPerSecond, declared ?? 0);
  const fetchSeconds = (pages * perRequest) / Math.max(1, config.concurrency);
  return Math.ceil(fetchSeconds + pages * EMBED_SECONDS_PER_PAGE);
}

export async function previewCrawl(
  config: CrawlConfig,
  fetchText: TextFetcher,
  estimate: StorageEstimate,
  userAgent: string,
): Promise<CrawlPreview> {
  const { urls, robots } = await discoverSeeds(config.root, config.sitemapUrl, fetchText);

  let excluded = 0;
  let blockedByRobots = 0;
  const kept = new Set<string>([config.root]);

  for (const raw of urls) {
    const c = canonicalizeUrl(raw, config.root);
    if (!c || !underRoot(c, config.root)) {
      excluded += 1;
      continue;
    }
    if (!inScope(c, config.scope)) {
      excluded += 1;
      continue;
    }
    const u = new URL(c);
    if (!isAllowed(robots, u.pathname + u.search, userAgent)) {
      blockedByRobots += 1;
      continue;
    }
    kept.add(c);
  }

  const inScopeCount = Math.min(kept.size, config.maxPages);
  const estimatedBytes = estimateIndexBytes(inScopeCount);
  const storage = preflight(inScopeCount, estimate);

  return {
    discovered: urls.length,
    inScope: inScopeCount,
    excluded,
    blockedByRobots,
    hasSitemap: urls.length > 0,
    estimatedSeconds: estimateSeconds(inScopeCount, config, robots, userAgent),
    estimatedBytes,
    storage,
    fits: storage.fits,
  };
}
