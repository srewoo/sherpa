/**
 * Build an eval corpus by crawling a live help site (`npm run eval:corpus`).
 *
 * The normal route is Options → Indexes → **Export**, which dumps the index the
 * extension actually built. This is the offline equivalent, for when you want a
 * corpus without driving the browser — a fresh machine, CI, or a site nobody
 * has crawled yet.
 *
 * It reuses the extension's own `extractPage` and `chunkPage` rather than
 * reimplementing them, because a corpus chunked differently from the product's
 * is a corpus that measures something the product doesn't do. The only pieces
 * replaced are the ones that need a browser: `fetch` instead of the offscreen
 * fetcher, and linkedom instead of the DOM.
 *
 *   SHERPA_ROOT=https://help.mindtickle.com/support/solutions \
 *   SHERPA_MAX_PAGES=400 npm run eval:corpus
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { describe, it, expect } from "vitest";
import { parseHTML } from "linkedom";

import { extractPage } from "@/extract/extract.js";
import { chunkPage } from "@/lib/chunk.js";
import { canonicalizeUrl, underRoot } from "@/lib/url.js";
import { parseRobots, isAllowed, crawlDelay } from "@/lib/robots.js";
import { isUnsafeToFetch } from "@/crawl/safety.js";
import { isLoginShell } from "@/crawl/authwall.js";
import { fnv1a } from "@/lib/hash.js";
import { CORPUS_EXPORT_VERSION, type CorpusExport, type ExportedChunk } from "@/storage/corpusExport.js";

const ROOT = process.env["SHERPA_ROOT"] ?? "";
const OUT = process.env["SHERPA_CORPUS"] ?? "eval/corpus.json";
const MAX_PAGES = Number(process.env["SHERPA_MAX_PAGES"] ?? 400);
/** Requests per second. Deliberately gentle — this is someone's live site. */
const RPS = Number(process.env["SHERPA_RPS"] ?? 2);
const USER_AGENT = "SherpaBot (+local-index; eval corpus builder)";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Same-host links, canonicalised and scope-filtered. */
function linksFrom(html: string, base: string, root: string): string[] {
  const { document } = parseHTML(html);
  const out = new Set<string>();
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    if (!href) continue;
    const canonical = canonicalizeUrl(href, base);
    if (!canonical || isUnsafeToFetch(canonical)) continue;
    if (!underRoot(canonical, root)) continue;
    out.add(canonical);
  }
  return [...out];
}

describe.skipIf(ROOT === "")("build eval corpus", () => {
  it(
    "crawls the site and writes a corpus the eval can run against",
    async () => {
      const origin = new URL(ROOT).origin;
      const host = new URL(ROOT).hostname;

      const robots = parseRobots(
        await getText(`${origin}/robots.txt`).catch(() => ""),
      );
      const declared = crawlDelay(robots, USER_AGENT);
      const intervalMs = Math.max(1000 / RPS, (declared ?? 0) * 1000);
      process.stdout.write(
        `crawling ${ROOT}\n  max ${MAX_PAGES} pages, one request every ${intervalMs}ms\n`,
      );

      const queue: string[] = [canonicalizeUrl(ROOT) ?? ROOT];
      const seen = new Set(queue);
      /** Content hash → first URL, so mirrored pages are indexed once. */
      const byContent = new Map<string, string>();
      const chunks: ExportedChunk[] = [];
      let vectorId = 0;
      let fetched = 0;
      let skipped = 0;

      while (queue.length > 0 && fetched < MAX_PAGES) {
        const url = queue.shift()!;
        if (!isAllowed(robots, USER_AGENT, url)) {
          skipped += 1;
          continue;
        }

        await sleep(intervalMs);

        let html: string;
        try {
          html = await getText(url);
        } catch {
          skipped += 1;
          continue;
        }
        fetched += 1;

        /**
         * Many help centres are behind a login — Mindtickle's is. The extension
         * crawls in the user's browser and inherits their session cookies; this
         * builder has no session, so it gets a redirect stub instead of an
         * article. Say that plainly on the first page rather than writing an
         * empty corpus and letting the eval report 0% recall as if retrieval
         * were at fault.
         */
        if (isLoginShell(html) || html.length < 512) {
          if (fetched === 1) {
            throw new Error(
              `${url} returned ${html.length} bytes that look like a sign-in redirect.\n` +
                "This site requires authentication, so it cannot be crawled anonymously.\n" +
                "Use the extension instead: crawl it while signed in, then\n" +
                "Options → Indexes → Export to produce eval/corpus.json.",
            );
          }
          skipped += 1;
          continue;
        }

        // Content-hash dedupe, exactly as the crawler does it: help centres
        // serve the same article under several paths.
        const hash = fnv1a(html);
        if (byContent.has(hash)) {
          continue;
        }
        byContent.set(hash, url);

        for (const link of linksFrom(html, url, ROOT)) {
          if (seen.has(link) || seen.size >= MAX_PAGES * 4) continue;
          seen.add(link);
          queue.push(link);
        }

        const { document } = parseHTML(html);
        const extracted = extractPage(document as unknown as Document, url);
        const drafts = chunkPage(extracted.blocks, {
          title: extracted.title,
          breadcrumb: extracted.breadcrumb,
        });

        for (const draft of drafts) {
          chunks.push({
            vectorId: vectorId++,
            text: draft.text,
            body: draft.body,
            url,
            headingPath: draft.headingPath,
            title: extracted.title,
            position: draft.position,
            contentHash: fnv1a(draft.body),
          });
        }

        if (fetched % 25 === 0) {
          process.stdout.write(
            `  ${fetched} pages, ${chunks.length} chunks, ${queue.length} queued\n`,
          );
        }
      }

      const corpus: CorpusExport = {
        version: CORPUS_EXPORT_VERSION,
        indexId: `${host}-eval`,
        host,
        root: ROOT,
        exportedAt: 0, // stamped by the caller; kept deterministic here
        pageCount: byContent.size,
        chunks,
      };

      mkdirSync(dirname(OUT), { recursive: true });
      writeFileSync(OUT, JSON.stringify(corpus));
      process.stdout.write(
        `\ncorpus: ${byContent.size} pages, ${chunks.length} chunks → ${OUT}` +
          `\n  ${fetched} fetched, ${skipped} skipped (robots or error)\n`,
      );

      expect(chunks.length).toBeGreaterThan(0);
    },
    60 * 60_000,
  );
});
