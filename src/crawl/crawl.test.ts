import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { openSherpaDb } from "@/storage/db.js";
import { parseCrawlConfig, type CrawlConfig } from "@/domain/config.js";
import { parseRobots } from "@/lib/robots.js";
import type { FetchResult, LinkExtractor } from "@/domain/crawl.js";
import { frontier } from "./frontier.js";
import { runCrawl } from "./engine.js";
import { parseSitemap } from "./sitemap.js";
import { discoverSeeds, type TextFetcher } from "./discovery.js";
import { Pacer, intervalFromRps } from "./politeness.js";
import { backoffMs, isTransient, FailureTracker } from "./backoff.js";
import { detectAuthWall } from "./authwall.js";

let seq = 0;
const freshDb = () => openSherpaDb(`crawl-test-${seq++}`);
const ROOT = "https://docs.x.com/";

const extractLinks: LinkExtractor = (html, base) => {
  const out: string[] = [];
  const re = /href="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) if (m[1]) out.push(new URL(m[1], base).toString());
  return out;
};

function cfg(over: Partial<CrawlConfig> = {}): CrawlConfig {
  return parseCrawlConfig({ root: ROOT, ...over });
}

function fetcherFrom(pages: Record<string, string | number>) {
  return async (url: string): Promise<FetchResult> => {
    const path = new URL(url).pathname;
    const entry = pages[path];
    if (typeof entry === "number") {
      return { url, finalUrl: url, status: entry, html: null, etag: undefined, lastmod: undefined };
    }
    const status = entry === undefined ? 404 : 200;
    return { url, finalUrl: url, status, html: entry ?? null, etag: undefined, lastmod: undefined };
  };
}

const noSleep = async (): Promise<void> => {};
let clock = 0;
const now = () => (clock += 1);

describe("pure crawl helpers", () => {
  it("parses a urlset and a sitemapindex", () => {
    const urls = parseSitemap("<urlset><url><loc>https://x.com/a</loc></url></urlset>");
    expect(urls).toEqual({ isIndex: false, urls: ["https://x.com/a"], sitemaps: [] });
    const idx = parseSitemap("<sitemapindex><sitemap><loc>https://x.com/s1.xml</loc></sitemap></sitemapindex>");
    expect(idx.isIndex).toBe(true);
    expect(idx.sitemaps).toEqual(["https://x.com/s1.xml"]);
  });

  it("decodes entities in loc", () => {
    expect(parseSitemap("<urlset><url><loc>https://x.com/a?b=1&amp;c=2</loc></url></urlset>").urls[0]).toBe(
      "https://x.com/a?b=1&c=2",
    );
  });

  it("paces with a minimum interval", () => {
    const p = new Pacer(intervalFromRps(2)); // 500ms
    expect(p.reserve(0)).toBe(0); // first dispatch immediate, nextAt=500
    expect(p.reserve(0)).toBe(500); // must wait to 500, nextAt=1000
    expect(p.reserve(600)).toBe(400); // now 600, slot at 1000 → wait 400
    expect(p.reserve(2000)).toBe(0); // well past the reserved slot
  });

  it("backoff grows and transient statuses are recognised", () => {
    expect(backoffMs(1)).toBe(500);
    expect(backoffMs(3)).toBe(2000);
    expect(isTransient(429)).toBe(true);
    expect(isTransient(404)).toBe(false);
  });

  it("failure tracker aborts after the ceiling and resets on success", () => {
    const t = new FailureTracker(2);
    expect(t.record(true)).toBe(false);
    expect(t.record(false)).toBe(false);
    expect(t.record(true)).toBe(false);
    expect(t.record(true)).toBe(true);
  });

  it("detects basic vs session auth walls", () => {
    const base = { url: ROOT, etag: undefined, lastmod: undefined, html: null };
    expect(detectAuthWall({ ...base, finalUrl: ROOT, status: 401 }, "docs.x.com")?.kind).toBe("basic");
    expect(detectAuthWall({ ...base, finalUrl: ROOT, status: 403 }, "docs.x.com")?.kind).toBe("session");
    expect(
      detectAuthWall({ ...base, url: ROOT, finalUrl: "https://docs.x.com/login", status: 200 }, "docs.x.com")?.kind,
    ).toBe("session");
    expect(detectAuthWall({ ...base, finalUrl: ROOT, status: 200 }, "docs.x.com")).toBeNull();
  });
});

describe("discoverSeeds", () => {
  const textFrom = (map: Record<string, string>): TextFetcher => async (url) => {
    if (url in map) return map[url]!;
    throw new Error(`404 ${url}`);
  };

  it("uses the Sitemap directive from robots.txt", async () => {
    const d = await discoverSeeds(
      ROOT,
      undefined,
      textFrom({
        "https://docs.x.com/robots.txt": "User-agent: *\nSitemap: https://docs.x.com/sm.xml",
        "https://docs.x.com/sm.xml": "<urlset><url><loc>https://docs.x.com/a</loc></url></urlset>",
      }),
    );
    expect(d.urls).toEqual(["https://docs.x.com/a"]);
  });

  it("follows a sitemap index one level deep", async () => {
    const d = await discoverSeeds(
      ROOT,
      "https://docs.x.com/index.xml",
      textFrom({
        "https://docs.x.com/robots.txt": "",
        "https://docs.x.com/index.xml":
          "<sitemapindex><sitemap><loc>https://docs.x.com/c.xml</loc></sitemap></sitemapindex>",
        "https://docs.x.com/c.xml": "<urlset><url><loc>https://docs.x.com/deep</loc></url></urlset>",
      }),
    );
    expect(d.urls).toEqual(["https://docs.x.com/deep"]);
  });

  it("falls back to /sitemap.xml and tolerates a missing robots.txt", async () => {
    const d = await discoverSeeds(
      ROOT,
      undefined,
      textFrom({
        "https://docs.x.com/sitemap.xml": "<urlset><url><loc>https://docs.x.com/home</loc></url></urlset>",
      }),
    );
    expect(d.urls).toEqual(["https://docs.x.com/home"]);
  });
});

describe("runCrawl", () => {
  const base = { robots: parseRobots(""), userAgent: "SherpaBot", extractLinks, sleep: noSleep, now };

  it("crawls in scope, dedupes, and ignores external links", async () => {
    const db = await freshDb();
    await frontier.seed(db, "i", [{ url: ROOT, depth: 0 }]);
    const seen: string[] = [];
    const outcome = await runCrawl({
      db,
      indexId: "i",
      config: cfg(),
      ...base,
      fetcher: fetcherFrom({
        "/": '<a href="/a">a</a><a href="/b">b</a><a href="https://other.com/z">z</a><a href="/a">dup</a>',
        "/a": '<a href="/b">b</a>',
        "/b": "",
      }),
      onPage: async (res) => {
        seen.push(new URL(res.url).pathname);
      },
    });
    expect(outcome).toEqual({ reason: "done" });
    expect(seen.sort()).toEqual(["/", "/a", "/b"]);
    const counts = await frontier.counts(db, "i");
    expect(counts.done).toBe(3);
    expect(counts.queued).toBe(0);
  });

  it("honours maxPages (strict at concurrency 1)", async () => {
    const db = await freshDb();
    await frontier.seed(db, "i", [{ url: ROOT, depth: 0 }]);
    await runCrawl({
      db,
      indexId: "i",
      config: cfg({ maxPages: 2, concurrency: 1 }),
      ...base,
      fetcher: fetcherFrom({ "/": '<a href="/a">a</a><a href="/b">b</a>', "/a": "", "/b": "" }),
      onPage: async () => {},
    });
    const counts = await frontier.counts(db, "i");
    expect(counts.done).toBe(2);
    expect(counts.skipped).toBeGreaterThanOrEqual(1);
  });

  it("pauses on an auth wall", async () => {
    const db = await freshDb();
    await frontier.seed(db, "i", [{ url: ROOT, depth: 0 }]);
    let wallHost = "";
    const outcome = await runCrawl({
      db,
      indexId: "i",
      config: cfg(),
      ...base,
      fetcher: fetcherFrom({ "/": 401 }),
      onAuthWall: (w) => {
        wallHost = w.host;
      },
      onPage: async () => {},
    });
    expect(outcome.reason).toBe("auth");
    expect(wallHost).toBe("docs.x.com");
  });

  it("aborts after consecutive failures", async () => {
    const db = await freshDb();
    await frontier.seed(db, "i", [
      { url: "https://docs.x.com/a", depth: 0 },
      { url: "https://docs.x.com/b", depth: 0 },
      { url: "https://docs.x.com/c", depth: 0 },
    ]);
    const outcome = await runCrawl({
      db,
      indexId: "i",
      config: cfg({ failureCeiling: 2, concurrency: 1 }),
      ...base,
      fetcher: fetcherFrom({ "/a": 500, "/b": 500, "/c": 500 }),
      onPage: async () => {},
    });
    expect(outcome).toEqual({ reason: "failed", status: 500 });
  });

  /**
   * The regression that stopped a working crawl of help.egain.com. Dead links
   * on a help centre cluster — a retired section is linked from one page, so
   * its 404s are harvested together and therefore fetched together. Counting
   * them toward the abort ceiling turned 222 successfully indexed pages into
   * "Stopped", with pages still queued and the index left uncalibrated.
   */
  it("does not abort on a run of dead links", async () => {
    const db = await freshDb();
    const urls = ["a", "b", "c", "d", "e"];
    await frontier.seed(
      db,
      "i",
      urls.map((u) => ({ url: `https://docs.x.com/${u}`, depth: 0 })),
    );
    const outcome = await runCrawl({
      db,
      indexId: "i",
      config: cfg({ failureCeiling: 2, concurrency: 1 }),
      ...base,
      fetcher: fetcherFrom(Object.fromEntries(urls.map((u) => [`/${u}`, 404]))),
      onPage: async () => {},
    });
    expect(outcome).toEqual({ reason: "done" });
    expect((await frontier.counts(db, "i")).failed).toBe(urls.length);
  });

  /**
   * The other half: the breaker still has to fire for the thing it exists for.
   * A 404 between two server errors must not reset the streak either — a site
   * falling over with one dead link mixed in is still a site falling over.
   */
  it("still aborts when the server is failing, even past a dead link", async () => {
    const db = await freshDb();
    await frontier.seed(db, "i", [
      { url: "https://docs.x.com/a", depth: 0 },
      { url: "https://docs.x.com/b", depth: 0 },
      { url: "https://docs.x.com/c", depth: 0 },
    ]);
    const outcome = await runCrawl({
      db,
      indexId: "i",
      config: cfg({ failureCeiling: 2, concurrency: 1 }),
      ...base,
      fetcher: fetcherFrom({ "/a": 500, "/b": 404, "/c": 500 }),
      onPage: async () => {},
    });
    expect(outcome).toEqual({ reason: "failed", status: 500 });
  });

  /** A dropped connection is the clearest infrastructure signal there is. */
  it("aborts on repeated network errors", async () => {
    const db = await freshDb();
    await frontier.seed(db, "i", [
      { url: "https://docs.x.com/a", depth: 0 },
      { url: "https://docs.x.com/b", depth: 0 },
    ]);
    const outcome = await runCrawl({
      db,
      indexId: "i",
      config: cfg({ failureCeiling: 2, concurrency: 1 }),
      ...base,
      fetcher: fetcherFrom({ "/a": 0, "/b": 0 }),
      onPage: async () => {},
    });
    expect(outcome).toEqual({ reason: "failed", status: 0 });
  });

  it("skips robots-disallowed paths", async () => {
    const db = await freshDb();
    await frontier.seed(db, "i", [{ url: "https://docs.x.com/private/x", depth: 0 }]);
    const outcome = await runCrawl({
      db,
      indexId: "i",
      config: cfg(),
      ...base,
      robots: parseRobots("User-agent: *\nDisallow: /private/"),
      fetcher: fetcherFrom({ "/private/x": "" }),
      onPage: async () => {},
    });
    expect(outcome).toEqual({ reason: "done" });
    expect((await frontier.counts(db, "i")).skipped).toBe(1);
  });

  it("tolerates an isolated 403 instead of aborting the crawl (5.2.8)", async () => {
    const db = await freshDb();
    await frontier.seed(db, "i", [
      { url: "https://docs.x.com/a", depth: 0 },
      { url: "https://docs.x.com/admin", depth: 0 },
      { url: "https://docs.x.com/b", depth: 0 },
    ]);
    const seen: string[] = [];
    const outcome = await runCrawl({
      db,
      indexId: "i",
      config: cfg({ concurrency: 1 }),
      ...base,
      fetcher: fetcherFrom({ "/a": "ok", "/admin": 403, "/b": "ok" }),
      onPage: async (res) => {
        seen.push(new URL(res.url).pathname);
      },
    });
    expect(outcome).toEqual({ reason: "done" });
    // One gated article must not cost us the other pages.
    expect(seen.sort()).toEqual(["/a", "/b"]);
  });

  it("stops once 403s cluster into a real auth wall", async () => {
    const db = await freshDb();
    await frontier.seed(db, "i", [
      { url: "https://docs.x.com/a", depth: 0 },
      { url: "https://docs.x.com/b", depth: 0 },
      { url: "https://docs.x.com/c", depth: 0 },
    ]);
    const outcome = await runCrawl({
      db,
      indexId: "i",
      config: cfg({ concurrency: 1 }),
      ...base,
      fetcher: fetcherFrom({ "/a": 403, "/b": 403, "/c": 403 }),
      onPage: async () => {},
    });
    expect(outcome.reason).toBe("auth");
  });

  it("indexes nothing from a noindex page but still follows its links (5.2.4)", async () => {
    const db = await freshDb();
    await frontier.seed(db, "i", [{ url: ROOT, depth: 0 }]);
    const seen: string[] = [];
    await runCrawl({
      db,
      indexId: "i",
      config: cfg({ concurrency: 1 }),
      ...base,
      fetcher: fetcherFrom({
        "/": '<meta name="robots" content="noindex"><a href="/keep">keep</a>',
        "/keep": "real content",
      }),
      onPage: async (res) => {
        seen.push(new URL(res.url).pathname);
      },
    });
    expect(seen).toEqual(["/keep"]);
    expect((await frontier.counts(db, "i")).skipped).toBe(1);
  });

  it("honours an X-Robots-Tag: noindex header", async () => {
    const db = await freshDb();
    await frontier.seed(db, "i", [{ url: ROOT, depth: 0 }]);
    const seen: string[] = [];
    await runCrawl({
      db,
      indexId: "i",
      config: cfg(),
      ...base,
      fetcher: async (url) => ({
        url,
        finalUrl: url,
        status: 200,
        html: "plenty of words here",
        etag: undefined,
        lastmod: undefined,
        robotsTag: "noindex",
      }),
      onPage: async (res) => {
        seen.push(res.url);
      },
    });
    expect(seen).toEqual([]);
  });

  it("counts pages already fetched against maxPages when resuming (5.2.2)", async () => {
    const db = await freshDb();
    await frontier.seed(db, "i", [
      { url: "https://docs.x.com/a", depth: 0 },
      { url: "https://docs.x.com/b", depth: 0 },
    ]);
    const seen: string[] = [];
    await runCrawl({
      db,
      indexId: "i",
      config: cfg({ maxPages: 3, concurrency: 1 }),
      ...base,
      // Two pages were indexed before the interruption.
      alreadyDone: 2,
      fetcher: fetcherFrom({ "/a": "ok", "/b": "ok" }),
      onPage: async (res) => {
        seen.push(new URL(res.url).pathname);
      },
    });
    // Only one slot was left under the ceiling.
    expect(seen).toHaveLength(1);
  });

  it("retries a transient failure once the frontier drains (5.2.5)", async () => {
    const db = await freshDb();
    await frontier.seed(db, "i", [{ url: "https://docs.x.com/flaky", depth: 0 }]);

    // Fails with a 500 on the first attempt, succeeds on the retry sweep.
    let attempt = 0;
    const seen: string[] = [];
    let swept = 0;
    const outcome = await runCrawl({
      db,
      indexId: "i",
      config: cfg({ concurrency: 1 }),
      ...base,
      fetcher: async (url) => {
        attempt += 1;
        return attempt === 1
          ? { url, finalUrl: url, status: 500, html: null, etag: undefined, lastmod: undefined }
          : { url, finalUrl: url, status: 200, html: "recovered", etag: undefined, lastmod: undefined };
      },
      onRetrySweep: (n) => {
        swept = n;
      },
      onPage: async (res) => {
        seen.push(res.url);
      },
    });

    expect(outcome).toEqual({ reason: "done" });
    expect(swept).toBe(1);
    expect(seen).toHaveLength(1);
    const counts = await frontier.counts(db, "i");
    expect(counts).toMatchObject({ done: 1, failed: 0 });
  });

  it("does not retry a permanent failure", async () => {
    const db = await freshDb();
    await frontier.seed(db, "i", [{ url: "https://docs.x.com/gone", depth: 0 }]);

    let calls = 0;
    await runCrawl({
      db,
      indexId: "i",
      config: cfg({ concurrency: 1 }),
      ...base,
      fetcher: async (url) => {
        calls += 1;
        return { url, finalUrl: url, status: 404, html: null, etag: undefined, lastmod: undefined };
      },
      onPage: async () => {},
    });

    // A 404 will never succeed; one attempt is the right number.
    expect(calls).toBe(1);
    const [failure] = await frontier.failures(db, "i");
    expect(failure?.reason).toBe("missing");
    expect(failure?.lastStatus).toBe(404);
  });

  it("gives up after the sweep rather than looping forever", async () => {
    const db = await freshDb();
    await frontier.seed(db, "i", [{ url: "https://docs.x.com/down", depth: 0 }]);

    let calls = 0;
    const outcome = await runCrawl({
      db,
      indexId: "i",
      config: cfg({ concurrency: 1, failureCeiling: 99 }),
      ...base,
      fetcher: async (url) => {
        calls += 1;
        return { url, finalUrl: url, status: 500, html: null, etag: undefined, lastmod: undefined };
      },
      onPage: async () => {},
    });

    expect(outcome).toEqual({ reason: "done" });
    expect(calls).toBe(2); // original attempt + one sweep
    expect((await frontier.counts(db, "i")).failed).toBe(1);
  });

  it("records a reason code for the failure log (5.2.10)", async () => {
    const db = await freshDb();
    await frontier.seed(db, "i", [
      { url: "https://docs.x.com/a", depth: 0 },
      { url: "https://docs.x.com/b", depth: 0 },
    ]);
    await runCrawl({
      db,
      indexId: "i",
      config: cfg({ concurrency: 1, failureCeiling: 99 }),
      ...base,
      retrySweeps: 0,
      fetcher: fetcherFrom({ "/a": 404, "/b": 0 }),
      onPage: async () => {},
    });

    const reasons = (await frontier.failures(db, "i")).map((f) => f.reason).sort();
    expect(reasons).toEqual(["missing", "network"]);
  });

  it("fails only the page when indexing throws, not the whole crawl", async () => {
    // The regression: onPage rejecting propagated out of the loop, so one
    // unparseable page or a momentary IndexedDB error killed everything after
    // it — with no record of which page or why.
    const db = await freshDb();
    await frontier.seed(db, "i", [
      { url: "https://docs.x.com/a", depth: 0 },
      { url: "https://docs.x.com/poison", depth: 0 },
      { url: "https://docs.x.com/b", depth: 0 },
    ]);

    const indexed: string[] = [];
    const errors: string[] = [];
    const outcome = await runCrawl({
      db,
      indexId: "i",
      config: cfg({ concurrency: 1, failureCeiling: 99 }),
      ...base,
      retrySweeps: 0,
      fetcher: fetcherFrom({ "/a": "ok", "/poison": "ok", "/b": "ok" }),
      onIndexError: (url) => errors.push(new URL(url).pathname),
      onPage: async (res) => {
        if (res.url.includes("poison")) throw new Error("embedder exploded");
        indexed.push(new URL(res.url).pathname);
      },
    });

    expect(outcome).toEqual({ reason: "done" });
    expect(indexed.sort()).toEqual(["/a", "/b"]);
    expect(errors).toEqual(["/poison"]);

    const [failure] = await frontier.failures(db, "i");
    expect(failure?.reason).toBe("indexing");
  });

  it("retries a page that failed to index (5.2.5)", async () => {
    const db = await freshDb();
    await frontier.seed(db, "i", [{ url: "https://docs.x.com/flaky", depth: 0 }]);

    let attempts = 0;
    const outcome = await runCrawl({
      db,
      indexId: "i",
      config: cfg({ concurrency: 1, failureCeiling: 99 }),
      ...base,
      fetcher: fetcherFrom({ "/flaky": "ok" }),
      onPage: async () => {
        attempts += 1;
        // Transient: succeeds on the end-of-crawl sweep.
        if (attempts === 1) throw new Error("IndexedDB busy");
      },
    });

    expect(outcome).toEqual({ reason: "done" });
    expect(attempts).toBe(2);
    expect((await frontier.counts(db, "i"))).toMatchObject({ done: 1, failed: 0 });
  });

  it("revalidates with stored ETags and skips unchanged pages (5.6.5)", async () => {
    const db = await freshDb();
    await frontier.seed(db, "i", [
      { url: "https://docs.x.com/same", depth: 0 },
      { url: "https://docs.x.com/changed", depth: 0 },
    ]);

    const sent: { url: string; etag: string | undefined }[] = [];
    const indexed: string[] = [];
    const unchanged: string[] = [];

    const outcome = await runCrawl({
      db,
      indexId: "i",
      config: cfg({ concurrency: 1 }),
      ...base,
      validatorsFor: async (url) => ({ etag: `etag-for-${new URL(url).pathname}`, lastmod: undefined }),
      onUnchanged: (url) => unchanged.push(new URL(url).pathname),
      fetcher: async (url, validators) => {
        sent.push({ url: new URL(url).pathname, etag: validators?.etag });
        const path = new URL(url).pathname;
        // The server says "not modified" for the page that hasn't changed.
        if (path === "/same") {
          return { url, finalUrl: url, status: 304, html: null, etag: validators?.etag, lastmod: undefined };
        }
        return { url, finalUrl: url, status: 200, html: "fresh content", etag: "new", lastmod: undefined };
      },
      onPage: async (res) => {
        indexed.push(new URL(res.url).pathname);
      },
    });

    expect(outcome).toEqual({ reason: "done" });
    // Both were revalidated, each carrying its own stored validator. The
    // frontier yields in key order, so compare as a set.
    expect(sent.map((c) => c.etag).sort()).toEqual([
      "etag-for-/changed",
      "etag-for-/same",
    ]);
    // Only the changed page was extracted, chunked and embedded.
    expect(indexed).toEqual(["/changed"]);
    expect(unchanged).toEqual(["/same"]);
    // A 304 is a completed page, not a failure.
    expect(await frontier.counts(db, "i")).toMatchObject({ done: 2, failed: 0 });
  });

  it("sends no validators on a first crawl", async () => {
    const db = await freshDb();
    await frontier.seed(db, "i", [{ url: ROOT, depth: 0 }]);
    const seen: (string | undefined)[] = [];
    await runCrawl({
      db,
      indexId: "i",
      config: cfg(),
      ...base,
      fetcher: async (url, validators) => {
        seen.push(validators?.etag);
        return { url, finalUrl: url, status: 200, html: "ok", etag: "e", lastmod: undefined };
      },
      onPage: async () => {},
    });
    expect(seen).toEqual([undefined]);
  });

  it("never follows a logout link, even when robots.txt permits it", async () => {
    // The bug this exists for: a help centre linked /logout from every article
    // and did not disallow it. Fetching it ended the user's session, and every
    // page after that redirected to a sign-in screen.
    const db = await freshDb();
    await frontier.seed(db, "i", [{ url: ROOT, depth: 0 }]);

    const requested: string[] = [];
    await runCrawl({
      db,
      indexId: "i",
      config: cfg({ concurrency: 1 }),
      ...base,
      fetcher: async (url) => {
        requested.push(new URL(url).pathname);
        const path = new URL(url).pathname;
        const body =
          path === "/"
            ? '<a href="/logout">Sign out</a><a href="/guide">Guide</a><a href="/f/report.pdf">PDF</a>'
            : "content";
        return { url, finalUrl: url, status: 200, html: body, etag: undefined, lastmod: undefined };
      },
      onPage: async () => {},
    });

    expect(requested).toContain("/guide");
    expect(requested).not.toContain("/logout");
    // Binary attachments are skipped too — they cost a download and index nothing.
    expect(requested).not.toContain("/f/report.pdf");
  });

  it("skips an unsafe URL already sitting in the frontier", async () => {
    // A crawl seeded before this check existed, or a sitemap listing it.
    const db = await freshDb();
    await frontier.seed(db, "i", [{ url: "https://docs.x.com/logout", depth: 0 }]);

    const requested: string[] = [];
    await runCrawl({
      db,
      indexId: "i",
      config: cfg(),
      ...base,
      fetcher: async (url) => {
        requested.push(url);
        return { url, finalUrl: url, status: 200, html: "x", etag: undefined, lastmod: undefined };
      },
      onPage: async () => {},
    });

    expect(requested).toEqual([]);
    expect((await frontier.counts(db, "i")).skipped).toBe(1);
  });

  it("respects a robots.txt Crawl-delay over the configured rate (5.2.4)", async () => {
    const db = await freshDb();
    await frontier.seed(db, "i", [
      { url: "https://docs.x.com/a", depth: 0 },
      { url: "https://docs.x.com/b", depth: 0 },
    ]);
    const waits: number[] = [];
    await runCrawl({
      db,
      indexId: "i",
      config: cfg({ requestsPerSecond: 10, concurrency: 1 }),
      ...base,
      robots: parseRobots("User-agent: *\nCrawl-delay: 2"),
      sleep: async (ms) => {
        waits.push(ms);
      },
      now: () => 0, // freeze time so the wait reflects the reserved interval
      fetcher: fetcherFrom({ "/a": "ok", "/b": "ok" }),
      onPage: async () => {},
    });
    // 10 req/s would be a 100ms interval; Crawl-delay: 2 forces 2000ms.
    expect(Math.max(...waits)).toBeGreaterThanOrEqual(2000);
  });
});
