/**
 * Pre-crawl preview (PRD 5.1.4, 5.5.6). Before a single page is fetched the
 * user sees how many pages are in scope, how long it will take, and whether it
 * fits on disk — and a crawl that won't fit is refused up front rather than
 * failing halfway through.
 *
 * It also probes the root page's own links. A sitemap that returns almost
 * nothing looks identical to a correctly-scoped small site, and the difference
 * only shows up after a pointless crawl: pointing at a help-centre landing page
 * like `/support/home` scopes everything to `/support/home/`, while the actual
 * articles sit at `/support/solutions/…` and get rejected as out of scope. One
 * fetch of the root tells us that up front, so the UI can say so and offer a
 * root that works.
 *
 * All I/O is injected so the whole thing is unit-testable without a network.
 */

import type { CrawlConfig } from "@/domain/config.js";
import type { Fetcher, LinkExtractor } from "@/domain/crawl.js";
import { discoverSeeds, type TextFetcher } from "./discovery.js";
import { isLoginShell } from "./authwall.js";
import { isUnsafeToFetch } from "./safety.js";
import { canonicalizeUrl, underRoot, scopePrefix } from "@/lib/url.js";
import { inScope } from "@/lib/patterns.js";
import { isAllowed, crawlDelay, type Robots } from "@/lib/robots.js";
import { estimateIndexBytes, preflight, type Preflight, type StorageEstimate } from "@/storage/quota.js";

/**
 * Seconds of embedding per page on the WASM backend. Measured against the PRD's
 * own budget (M6: 2,000 pages in under 25 min) and deliberately conservative —
 * an ETA that overshoots is far less damaging than one that undershoots.
 */
export const EMBED_SECONDS_PER_PAGE = 0.45;

/**
 * One-time cost of bringing the embedder up: instantiating the WASM runtime and
 * the ~32 MB quantised ONNX graph. Nothing is downloaded (both are bundled),
 * but the compile is not free, and a fresh offscreen document pays it before
 * the first page is embedded. Invisible on a 2,000-page crawl; on a 16-page one
 * it is a fifth of the wall clock, which is exactly when an ETA is scrutinised.
 */
export const MODEL_LOAD_SECONDS = 4;

/**
 * A wider crawl root that would reach materially more of the site than the one
 * the user chose (PRD 5.1.1).
 */
export interface ScopeSuggestion {
  readonly root: string;
  /** Links on the root page that this wider root would admit. */
  readonly reachable: number;
}

export interface CrawlPreview {
  /** URLs discovered from the sitemap, before scope filtering. */
  readonly discovered: number;
  /** URLs that survive include/exclude, robots and the max-pages cap. */
  readonly inScope: number;
  readonly excluded: number;
  readonly blockedByRobots: number;
  /** Whether a sitemap was found at all — if not, we fall back to link BFS. */
  readonly hasSitemap: boolean;
  /** The path prefix the crawl is actually confined to, shown to the user. */
  readonly scopePrefix: string;
  /** In-scope links found on the root page, i.e. what link-following will add. */
  readonly linkedInScope: number;
  /** Every in-scope link on the root page, regardless of path prefix. */
  readonly linkedOnHost: number;
  /**
   * Set when the root itself answers with a sign-in page. Crawling would index
   * the login shell and stop, so the UI must say so before anything runs
   * (PRD 5.2.8).
   */
  readonly requiresAuth: boolean;
  /** Set when the chosen root would strand most of the site (see file header). */
  readonly suggestion?: ScopeSuggestion;
  readonly estimatedSeconds: number;
  readonly estimatedBytes: number;
  readonly storage: Preflight;
  /** False when the index won't fit; the UI must refuse to start (5.5.6). */
  readonly fits: boolean;
}

/**
 * Wall-clock estimate.
 *
 * A crawl is a two-stage pipeline — fetch, then embed — so the wall clock is
 * the *slower* stage, not the sum: while the pacer waits out its interval, the
 * CPU is embedding the page that arrived before it. Summing them, as this once
 * did, over-counts every crawl.
 *
 * `concurrency` deliberately does not appear, which is the bug this replaces.
 * It cannot help either stage:
 *
 *  - **Fetching** is capped by the rate limit, not the wave width. `runCrawl`
 *    shares a single `Pacer` across the whole crawl, so `reserve()` serializes
 *    dispatches however many requests are in flight. Dividing by concurrency
 *    made every rate-limited crawl — the default, at 1 req/sec — look
 *    concurrency-times faster than it could physically run: the 16-page crawl
 *    that reported ~13 sec could not have finished in under 16.
 *  - **Embedding** is WASM on one thread, so pages queue rather than overlap.
 *    At 0.45 s/page it also sets a floor no amount of parallel fetching beats.
 *
 * Crawl-delay, when the site declares one, widens the interval and so dominates
 * everything.
 */
export function estimateSeconds(pages: number, config: CrawlConfig, robots: Robots, userAgent: string): number {
  if (pages <= 0) return 0;
  const declared = crawlDelay(robots, userAgent);
  const interval = Math.max(1 / config.requestsPerSecond, declared ?? 0);

  const fetchSeconds = pages * interval;
  const embedSeconds = pages * EMBED_SECONDS_PER_PAGE;

  // The slower stage sets the pace, plus the last page's embed — it has no
  // fetch left to hide behind — plus bringing the embedder up in the first
  // place.
  return Math.ceil(
    MODEL_LOAD_SECONDS + Math.max(fetchSeconds, embedSeconds) + EMBED_SECONDS_PER_PAGE,
  );
}

export interface PreviewDeps {
  readonly fetchText: TextFetcher;
  readonly estimate: StorageEstimate;
  readonly userAgent: string;
  /** Optional root-page probe; without it the suggestion is simply omitted. */
  readonly fetchPage?: Fetcher;
  readonly extractLinks?: LinkExtractor;
}

/** Count the root page's links, split by how wide a root would be needed. */
async function probeRootLinks(
  config: CrawlConfig,
  deps: PreviewDeps,
): Promise<{ inScopeLinks: number; hostLinks: number; requiresAuth: boolean }> {
  if (!deps.fetchPage || !deps.extractLinks) {
    return { inScopeLinks: 0, hostLinks: 0, requiresAuth: false };
  }

  const res = await deps.fetchPage(config.root).catch(() => null);
  if (!res) return { inScopeLinks: 0, hostLinks: 0, requiresAuth: false };

  // A sign-in page is the whole answer — counting its links is meaningless.
  const requiresAuth =
    res.status === 401 || res.status === 403 || isLoginShell(res.html);
  if (requiresAuth || !res.html) return { inScopeLinks: 0, hostLinks: 0, requiresAuth };

  const origin = new URL(config.root).origin + "/";
  const underCurrent = new Set<string>();
  const underOrigin = new Set<string>();

  for (const raw of deps.extractLinks(res.html, res.finalUrl || config.root)) {
    const c = canonicalizeUrl(raw, res.finalUrl || config.root);
    if (!c || !inScope(c, config.scope) || isUnsafeToFetch(c)) continue;
    if (underRoot(c, origin)) underOrigin.add(c);
    if (underRoot(c, config.root)) underCurrent.add(c);
  }
  return { inScopeLinks: underCurrent.size, hostLinks: underOrigin.size, requiresAuth: false };
}

/**
 * Would a wider root reach materially more? Compared as a difference rather
 * than "the current root reaches nothing", because a root can admit one or two
 * links and still strand the bulk of the site.
 */
const MEANINGFULLY_MORE = 3;

export async function previewCrawl(
  config: CrawlConfig,
  fetchTextOrDeps: TextFetcher | PreviewDeps,
  estimate?: StorageEstimate,
  userAgent?: string,
): Promise<CrawlPreview> {
  // Two call shapes so existing callers (and tests) that pass positional
  // arguments keep working alongside the richer dependency object.
  const deps: PreviewDeps =
    typeof fetchTextOrDeps === "function"
      ? { fetchText: fetchTextOrDeps, estimate: estimate!, userAgent: userAgent! }
      : fetchTextOrDeps;

  const { urls, robots } = await discoverSeeds(config.root, config.sitemapUrl, deps.fetchText);

  let excluded = 0;
  let blockedByRobots = 0;
  const kept = new Set<string>([config.root]);

  for (const raw of urls) {
    const c = canonicalizeUrl(raw, config.root);
    if (!c || !underRoot(c, config.root)) {
      excluded += 1;
      continue;
    }
    if (isUnsafeToFetch(c)) {
      excluded += 1;
      continue;
    }
    if (!inScope(c, config.scope)) {
      excluded += 1;
      continue;
    }
    const u = new URL(c);
    if (!isAllowed(robots, u.pathname + u.search, deps.userAgent)) {
      blockedByRobots += 1;
      continue;
    }
    kept.add(c);
  }

  const { inScopeLinks, hostLinks, requiresAuth } = await probeRootLinks(config, deps);

  // Link-following adds pages the sitemap didn't list, so fold them into the
  // estimate rather than promising "1 page, ~1 sec" for a real crawl.
  const reachable = Math.min(kept.size + inScopeLinks, config.maxPages);
  const inScopeCount = Math.max(1, reachable);
  const estimatedBytes = estimateIndexBytes(inScopeCount);
  const storage = preflight(inScopeCount, estimate ?? deps.estimate);

  const origin = new URL(config.root).origin + "/";
  const strandsTheSite =
    origin !== config.root && hostLinks - inScopeLinks >= MEANINGFULLY_MORE;

  return {
    discovered: urls.length,
    inScope: inScopeCount,
    excluded,
    blockedByRobots,
    hasSitemap: urls.length > 0,
    scopePrefix: scopePrefix(config.root),
    linkedInScope: inScopeLinks,
    linkedOnHost: hostLinks,
    requiresAuth,
    ...(strandsTheSite ? { suggestion: { root: origin, reachable: hostLinks } } : {}),
    estimatedSeconds: estimateSeconds(inScopeCount, config, robots, deps.userAgent),
    estimatedBytes,
    storage,
    fits: storage.fits,
  };
}
