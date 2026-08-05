import { describe, it, expect } from "vitest";
import { parseCrawlConfig } from "@/domain/config.js";
import { parseRobots } from "@/lib/robots.js";
import {
  previewCrawl,
  estimateSeconds,
  EMBED_SECONDS_PER_PAGE,
  MODEL_LOAD_SECONDS,
} from "./preview.js";
import type { TextFetcher } from "./discovery.js";
import { BYTES_PER_PAGE } from "@/storage/quota.js";

const ROOT = "https://docs.x.com/";
const UA = "SherpaBot";

const urls = (paths: readonly string[]): string =>
  `<urlset>${paths.map((p) => `<url><loc>https://docs.x.com${p}</loc></url>`).join("")}</urlset>`;

function textFrom(map: Record<string, string>): TextFetcher {
  return async (url) => {
    if (url in map) return map[url]!;
    throw new Error(`404 ${url}`);
  };
}

const roomy = { usage: 0, quota: 10_000_000_000 };

describe("estimateSeconds", () => {
  const noRobots = parseRobots("");

  it("scales with pages", () => {
    const config = parseCrawlConfig({ root: ROOT, requestsPerSecond: 1, concurrency: 1 });
    expect(estimateSeconds(200, config, noRobots, UA)).toBeGreaterThan(
      estimateSeconds(100, config, noRobots, UA),
    );
  });

  /**
   * The engine shares one Pacer across the whole crawl, so `reserve()`
   * serializes dispatches however wide the wave is — concurrency hides latency,
   * it does not beat the rate limit — and embedding runs single-threaded on
   * top. The estimate used to divide by concurrency, making every rate-limited
   * crawl look concurrency-times faster than it could physically run.
   */
  it("does not let concurrency beat the politeness rate", () => {
    const serial = parseCrawlConfig({ root: ROOT, requestsPerSecond: 1, concurrency: 1 });
    const wide = parseCrawlConfig({ root: ROOT, requestsPerSecond: 1, concurrency: 8 });
    expect(estimateSeconds(100, wide, noRobots, UA)).toBe(
      estimateSeconds(100, serial, noRobots, UA),
    );
  });

  it("does not let concurrency beat the embedder either", () => {
    const serial = parseCrawlConfig({ root: ROOT, requestsPerSecond: 10, concurrency: 1 });
    const wide = parseCrawlConfig({ root: ROOT, requestsPerSecond: 10, concurrency: 8 });
    expect(estimateSeconds(2000, wide, noRobots, UA)).toBe(
      estimateSeconds(2000, serial, noRobots, UA),
    );
  });

  it("never estimates below the time the pacer alone will take", () => {
    const config = parseCrawlConfig({ root: ROOT, requestsPerSecond: 1, concurrency: 3 });
    // 16 pages at 1 req/sec cannot be dispatched in under 16 seconds.
    expect(estimateSeconds(16, config, noRobots, UA)).toBeGreaterThanOrEqual(16);
  });

  /** Embedding, not the network, is the constraint on a fast site. */
  it("is bounded below by embedding when fetching is effectively free", () => {
    const config = parseCrawlConfig({ root: ROOT, requestsPerSecond: 10, concurrency: 8 });
    expect(estimateSeconds(100, config, noRobots, UA)).toBeGreaterThanOrEqual(
      100 * EMBED_SECONDS_PER_PAGE,
    );
  });

  it("counts bringing the embedder up, which dominates a small crawl", () => {
    const config = parseCrawlConfig({ root: ROOT, requestsPerSecond: 10, concurrency: 8 });
    expect(estimateSeconds(1, config, noRobots, UA)).toBeGreaterThanOrEqual(MODEL_LOAD_SECONDS);
  });

  it("estimates nothing for an empty scope", () => {
    const config = parseCrawlConfig({ root: ROOT });
    expect(estimateSeconds(0, config, noRobots, UA)).toBe(0);
  });

  it("lets a robots.txt Crawl-delay dominate the estimate", () => {
    const config = parseCrawlConfig({ root: ROOT, requestsPerSecond: 10, concurrency: 1 });
    const fast = estimateSeconds(100, config, noRobots, UA);
    const slow = estimateSeconds(100, config, parseRobots("User-agent: *\nCrawl-delay: 5"), UA);
    expect(slow).toBeGreaterThan(fast);
    // 100 pages at one every 5 seconds is 500 seconds of pacing, at minimum.
    expect(slow).toBeGreaterThanOrEqual(500);
  });
});

describe("previewCrawl", () => {
  it("counts pages in scope before anything is fetched (5.1.4)", async () => {
    const preview = await previewCrawl(
      parseCrawlConfig({ root: ROOT }),
      textFrom({
        "https://docs.x.com/robots.txt": "",
        "https://docs.x.com/sitemap.xml": urls(["/a", "/b", "/c"]),
      }),
      roomy,
      UA,
    );
    expect(preview.discovered).toBe(3);
    // The root itself is always crawled, so it joins the three sitemap URLs.
    expect(preview.inScope).toBe(4);
    expect(preview.hasSitemap).toBe(true);
    expect(preview.estimatedSeconds).toBeGreaterThan(0);
    expect(preview.fits).toBe(true);
  });

  it("applies exclude patterns and reports what they removed", async () => {
    const preview = await previewCrawl(
      parseCrawlConfig({ root: ROOT, scope: { include: [], exclude: ["*/blog/*"] } }),
      textFrom({
        "https://docs.x.com/robots.txt": "",
        "https://docs.x.com/sitemap.xml": urls(["/docs/a", "/blog/x", "/blog/y"]),
      }),
      roomy,
      UA,
    );
    expect(preview.excluded).toBe(2);
    expect(preview.inScope).toBe(2); // root + /docs/a
  });

  it("counts robots-disallowed URLs separately from excludes", async () => {
    const preview = await previewCrawl(
      parseCrawlConfig({ root: ROOT }),
      textFrom({
        "https://docs.x.com/robots.txt": "User-agent: *\nDisallow: /private/",
        "https://docs.x.com/sitemap.xml": urls(["/ok", "/private/a", "/private/b"]),
      }),
      roomy,
      UA,
    );
    expect(preview.blockedByRobots).toBe(2);
    expect(preview.excluded).toBe(0);
  });

  it("caps the estimate at maxPages", async () => {
    const preview = await previewCrawl(
      parseCrawlConfig({ root: ROOT, maxPages: 2 }),
      textFrom({
        "https://docs.x.com/robots.txt": "",
        "https://docs.x.com/sitemap.xml": urls(["/a", "/b", "/c", "/d", "/e"]),
      }),
      roomy,
      UA,
    );
    expect(preview.inScope).toBe(2);
  });

  it("refuses a crawl that won't fit on disk (5.5.6)", async () => {
    const preview = await previewCrawl(
      parseCrawlConfig({ root: ROOT }),
      textFrom({
        "https://docs.x.com/robots.txt": "",
        "https://docs.x.com/sitemap.xml": urls(["/a", "/b", "/c"]),
      }),
      // Room for one page, not four.
      { usage: 0, quota: BYTES_PER_PAGE },
      UA,
    );
    expect(preview.fits).toBe(false);
    expect(preview.estimatedBytes).toBeGreaterThan(preview.storage.available);
  });

  it("warns when the root scopes the crawl down to a single page", async () => {
    // The real case: a help-centre landing page whose articles are siblings,
    // not children, so the path prefix rejects every link on it.
    const root = "https://help.acme.test/support/home";
    const preview = await previewCrawl(
      parseCrawlConfig({ root }),
      {
        fetchText: textFrom({
          "https://help.acme.test/robots.txt": "",
          "https://help.acme.test/sitemap.xml": `<urlset><url><loc>${root}</loc></url></urlset>`,
        }),
        estimate: roomy,
        userAgent: UA,
        fetchPage: async (url) => ({
          url,
          finalUrl: url,
          status: 200,
          html: `
            <a href="/support/solutions/articles/1">one</a>
            <a href="/support/solutions/articles/2">two</a>
            <a href="/support/tickets/new">three</a>`,
          etag: undefined,
          lastmod: undefined,
        }),
        extractLinks: (html, base) =>
          [...html.matchAll(/href="([^"]+)"/g)].map((m) => new URL(m[1]!, base).toString()),
      },
      undefined,
      UA,
    );

    expect(preview.scopePrefix).toBe("/support/home/");
    expect(preview.linkedInScope).toBe(0);
    expect(preview.suggestion).toEqual({ root: "https://help.acme.test/", reachable: 3 });
  });

  it("stays quiet when the root reaches its own links", async () => {
    const root = "https://help.acme.test/support/";
    const preview = await previewCrawl(
      parseCrawlConfig({ root }),
      {
        fetchText: textFrom({
          "https://help.acme.test/robots.txt": "",
          "https://help.acme.test/sitemap.xml": `<urlset><url><loc>${root}</loc></url></urlset>`,
        }),
        estimate: roomy,
        userAgent: UA,
        fetchPage: async (url) => ({
          url,
          finalUrl: url,
          status: 200,
          html: '<a href="/support/a">a</a><a href="/support/b">b</a>',
          etag: undefined,
          lastmod: undefined,
        }),
        extractLinks: (html, base) =>
          [...html.matchAll(/href="([^"]+)"/g)].map((m) => new URL(m[1]!, base).toString()),
      },
      undefined,
      UA,
    );

    expect(preview.suggestion).toBeUndefined();
    expect(preview.linkedInScope).toBe(2);
    // Linked pages count toward the estimate, not just the sitemap's one URL.
    expect(preview.inScope).toBe(3);
  });

  it("reports no sitemap so the caller can fall back to link BFS (5.1.3)", async () => {
    const preview = await previewCrawl(
      parseCrawlConfig({ root: ROOT }),
      textFrom({}),
      roomy,
      UA,
    );
    expect(preview.hasSitemap).toBe(false);
    expect(preview.inScope).toBe(1); // just the root
  });
});
