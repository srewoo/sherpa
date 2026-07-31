import { describe, it, expect } from "vitest";
import { parseCrawlConfig } from "@/domain/config.js";
import { parseRobots } from "@/lib/robots.js";
import { previewCrawl, estimateSeconds } from "./preview.js";
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
  it("scales with pages and shrinks with concurrency", () => {
    const config = parseCrawlConfig({ root: ROOT, requestsPerSecond: 1, concurrency: 1 });
    const parallel = parseCrawlConfig({ root: ROOT, requestsPerSecond: 1, concurrency: 4 });
    const robots = parseRobots("");
    expect(estimateSeconds(100, config, robots, UA)).toBeGreaterThan(
      estimateSeconds(100, parallel, robots, UA),
    );
    expect(estimateSeconds(200, config, robots, UA)).toBeGreaterThan(
      estimateSeconds(100, config, robots, UA),
    );
  });

  it("lets a robots.txt Crawl-delay dominate the estimate", () => {
    const config = parseCrawlConfig({ root: ROOT, requestsPerSecond: 10, concurrency: 1 });
    const fast = estimateSeconds(100, config, parseRobots(""), UA);
    const slow = estimateSeconds(100, config, parseRobots("User-agent: *\nCrawl-delay: 5"), UA);
    expect(slow).toBeGreaterThan(fast);
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
