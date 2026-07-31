/**
 * Offscreen crawl controller. Owns one crawl's lifecycle: discover seeds, seed
 * the frontier, run the engine with the real browser fetch/DOM deps, extract →
 * chunk → embed each page, and stream progress to the UI.
 *
 * The controller keeps no state that matters across restarts: everything needed
 * to continue lives in IndexedDB (the frontier holds the queue, `meta` holds
 * which crawl that queue belongs to, the registry holds the config), so
 * `rehydrate()` can pick a crawl back up after the offscreen document is torn
 * down or the browser restarts (PRD 5.2.2).
 */

import type { CrawlConfig } from "@/domain/config.js";
import type { CrawlProgress } from "@/background/messages.js";
import type { AuthWall } from "@/domain/crawl.js";
import type { StoredChunk, StoredPage } from "@/domain/records.js";
import { SCHEMA_VERSION } from "@/domain/records.js";
import type { Robots } from "@/lib/robots.js";
import type { SherpaDatabase } from "@/storage/db.js";
import { indexRepo } from "@/storage/indexRepo.js";
import { pageStore } from "@/storage/pages.js";
import { chunkStore } from "@/storage/chunks.js";
import { vectorStore } from "@/storage/vectors.js";
import { bm25Store } from "@/storage/bm25Store.js";
import { metaRepo } from "@/storage/metaRepo.js";
import { frontier } from "@/crawl/frontier.js";
import { runCrawl, type CrawlOutcome } from "@/crawl/engine.js";
import { discoverSeeds } from "@/crawl/discovery.js";
import { canonicalizeUrl, underRoot } from "@/lib/url.js";
import { inScope } from "@/lib/patterns.js";
import { fnv1a } from "@/lib/hash.js";
import { shouldReindex } from "@/crawl/incremental.js";
import { needsRender, blocksWordCount, renderInTab } from "@/crawl/render.js";
import { chunkPage } from "@/lib/chunk.js";
import { extractPage } from "@/extract/extract.js";
import { getEmbedder } from "@/embed/embedder.js";
import { browserFetch, domLinks, fetchText } from "./browserFetch.js";

export const USER_AGENT = "SherpaBot (+local-index)";

function titleOf(html: string | null): string {
  const m = html?.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m?.[1]?.trim() ?? "";
}

export type Post = (progress: CrawlProgress) => void;

export class CrawlController {
  private paused = false;
  private running = false;
  private config: CrawlConfig | null = null;
  private indexId: string | null = null;
  private authWall: AuthWall | null = null;
  private incremental = false;
  /** Cached per crawl so robots.txt + the sitemap aren't refetched each loop. */
  private robots: Robots | null = null;
  private embeddedThisRun = 0;

  constructor(
    private readonly db: SherpaDatabase,
    private readonly post: Post,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /**
   * Pick up a crawl left unfinished by a previous session (PRD 5.2.2). Called
   * once when the offscreen document loads. A crawl the user paused stays
   * paused — restarting it is their call — but its state is restored so the
   * Resume button works after a browser restart.
   */
  async rehydrate(): Promise<boolean> {
    const active = await metaRepo.activeCrawl(this.db);
    if (!active) return false;
    const meta = await indexRepo.get(this.db, active.indexId);
    if (!meta) {
      await metaRepo.clearActiveCrawl(this.db);
      return false;
    }
    this.indexId = active.indexId;
    this.config = meta.config;
    this.incremental = active.incremental;
    this.paused = active.paused;
    this.authWall = null;
    await this.emit(active.paused ? "paused" : "crawling", null);
    if (!active.paused) await this.loop();
    return true;
  }

  async start(config: CrawlConfig): Promise<void> {
    this.config = config;
    this.paused = false;
    this.authWall = null;
    this.incremental = false;
    this.robots = null;
    this.embeddedThisRun = 0;
    this.indexId = `${new URL(config.root).hostname}-${this.clock()}`;
    await indexRepo.upsert(this.db, {
      id: this.indexId,
      root: config.root,
      host: new URL(config.root).hostname,
      title: new URL(config.root).hostname,
      pageCount: 0,
      chunkCount: 0,
      sizeBytes: 0,
      createdAt: this.clock(),
      lastIndexedAt: this.clock(),
      schemaVersion: SCHEMA_VERSION,
      config,
    });
    await this.markActive();
    await this.seed(config);
    await this.loop();
  }

  /** Incremental recrawl of an existing index (PRD 5.6.5): revisit known URLs
   * plus freshly discovered ones; unchanged pages skip re-embedding. */
  async startIncremental(indexId: string): Promise<void> {
    const meta = await indexRepo.get(this.db, indexId);
    if (!meta?.config) return;
    this.config = meta.config;
    this.indexId = indexId;
    this.incremental = true;
    this.paused = false;
    this.authWall = null;
    this.robots = null;
    this.embeddedThisRun = 0;
    await this.markActive();
    await this.emit("discovering", null);
    await frontier.requeueAll(this.db, indexId);
    const pages = await pageStore.listByIndex(this.db, indexId);
    await frontier.seed(this.db, indexId, pages.map((p) => ({ url: p.url, depth: 0 })));
    await this.seed(meta.config);
    await this.loop();
  }

  /**
   * Full re-crawl (PRD 5.6.4): discard everything indexed for this site and
   * crawl it again from the same config, keeping the index id so the user's
   * active-index selection and their place in the UI survive.
   */
  async startFullRecrawl(indexId: string): Promise<void> {
    const meta = await indexRepo.get(this.db, indexId);
    if (!meta?.config) return;
    await indexRepo.clearContent(this.db, indexId);
    await indexRepo.upsert(this.db, { ...meta, pageCount: 0, chunkCount: 0, sizeBytes: 0 });
    this.config = meta.config;
    this.indexId = indexId;
    this.incremental = false;
    this.paused = false;
    this.authWall = null;
    this.robots = null;
    this.embeddedThisRun = 0;
    await this.markActive();
    await this.seed(meta.config);
    await this.loop();
  }

  async pause(): Promise<void> {
    this.paused = true;
    await this.markActive();
  }

  async resume(): Promise<void> {
    if (this.config && this.indexId && !this.running) {
      this.paused = false;
      await this.markActive();
      await this.loop();
    }
  }

  private async markActive(): Promise<void> {
    if (!this.indexId) return;
    await metaRepo.setActiveCrawl(this.db, {
      indexId: this.indexId,
      incremental: this.incremental,
      paused: this.paused,
      startedAt: this.clock(),
    });
  }

  /** robots.txt + sitemap, fetched once per crawl and reused across resumes. */
  private async discovery(config: CrawlConfig): Promise<{ urls: readonly string[]; robots: Robots }> {
    const result = await discoverSeeds(config.root, config.sitemapUrl, fetchText);
    this.robots = result.robots;
    return result;
  }

  private async seed(config: CrawlConfig): Promise<void> {
    await this.emit("discovering", null);
    const { urls } = await this.discovery(config);
    const seeds = [{ url: config.root, depth: 0 }];
    for (const raw of urls) {
      const c = canonicalizeUrl(raw, config.root);
      if (c && underRoot(c, config.root) && inScope(c, config.scope)) {
        seeds.push({ url: c, depth: 0 });
      }
    }
    await frontier.seed(this.db, this.indexId!, seeds);
  }

  private async loop(): Promise<void> {
    const config = this.config!;
    const indexId = this.indexId!;
    this.running = true;

    const robots = this.robots ?? (await this.discovery(config)).robots;
    // Pages already fetched count against max-pages, so a resumed crawl doesn't
    // start its ceiling over (PRD 5.2.2 / 5.1.6).
    const { done } = await frontier.counts(this.db, indexId);

    const outcome = await runCrawl({
      db: this.db,
      indexId,
      config,
      robots,
      userAgent: USER_AGENT,
      fetcher: browserFetch,
      extractLinks: domLinks,
      alreadyDone: done,
      onPage: async (res) => {
        await this.indexPage(indexId, res.finalUrl, res.html ?? "", res.etag, res.lastmod);
        await this.emit("embedding", res.finalUrl);
      },
      onProgress: () => void this.emit("crawling", null),
      onAuthWall: (wall) => {
        this.authWall = wall;
      },
      shouldStop: () => this.paused,
    });
    this.running = false;
    await this.finalize(outcome);
  }

  /** Extract → chunk → embed → persist vectors + chunks for one page. */
  private async indexPage(
    indexId: string,
    fetchedUrl: string,
    html: string,
    etag: string | undefined,
    lastmod: string | undefined,
  ): Promise<void> {
    const htmlHash = fnv1a(html);

    let extracted = extractPage(new DOMParser().parseFromString(html, "text/html"), fetchedUrl);

    // `<link rel=canonical>` is the site telling us this page's real identity;
    // index it under that URL so aliases collapse into one page (PRD 5.2.6).
    const declared = extracted.canonical ? canonicalizeUrl(extracted.canonical) : null;
    const url = declared && underRoot(declared, this.config?.root ?? fetchedUrl) ? declared : fetchedUrl;

    const stored = await pageStore.get(this.db, indexId, url);

    // Incremental: unchanged page keeps its chunks and skips re-embedding (5.6.5).
    if (this.incremental && stored && !shouldReindex(stored, { etag, lastmod, htmlHash })) {
      await pageStore.put(this.db, { ...stored, fetchedAt: this.clock() });
      return;
    }

    // Identical content already indexed under a different URL (PRD 5.2.7).
    if (!stored && (await pageStore.findDuplicate(this.db, indexId, htmlHash, url))) return;

    // Changed page: drop its old chunks before re-indexing.
    if (stored) await chunkStore.deleteByUrl(this.db, indexId, url);

    // JS-rendered docs return an almost-empty shell: re-read the settled DOM.
    if (needsRender(blocksWordCount(extracted.blocks))) {
      const rendered = await renderInTab(url);
      if (rendered) {
        const richer = extractPage(new DOMParser().parseFromString(rendered, "text/html"), url);
        if (blocksWordCount(richer.blocks) > blocksWordCount(extracted.blocks)) extracted = richer;
      }
    }
    const title = extracted.title || titleOf(html);

    const page: StoredPage = {
      indexId,
      url,
      htmlHash,
      etag,
      lastmod,
      title,
      breadcrumb: [...extracted.breadcrumb],
      fetchedAt: this.clock(),
    };
    await pageStore.put(this.db, page);

    const drafts = chunkPage(extracted.blocks, { title, breadcrumb: extracted.breadcrumb });
    if (drafts.length === 0) return;

    const embedder = await getEmbedder();
    const flat = await embedder.embed(drafts.map((d) => d.text));
    const startId = await vectorStore.append(this.db, indexId, flat, embedder.dim);
    const chunks: StoredChunk[] = drafts.map((d, i) => ({
      indexId,
      vectorId: startId + i,
      text: d.text,
      body: d.body,
      url,
      anchor: d.anchor,
      headingPath: d.headingPath,
      position: d.position,
      title,
      contentHash: fnv1a(d.body),
    }));
    await chunkStore.putBatch(this.db, chunks);
    this.embeddedThisRun += chunks.length;
  }

  private async finalize(outcome: CrawlOutcome): Promise<void> {
    const phase =
      outcome.reason === "done"
        ? "done"
        : outcome.reason === "auth"
          ? "paused"
          : outcome.reason === "failed"
            ? "error"
            : "paused";

    if (this.indexId) {
      const indexId = this.indexId;
      const chunks = await chunkStore.listByIndex(this.db, indexId);

      // Build the sparse index once, here, instead of per query (PRD 5.5.4).
      await bm25Store.build(this.db, indexId, chunks.map((c) => ({ id: c.vectorId, text: c.text })));

      const meta = await indexRepo.get(this.db, indexId);
      if (meta) {
        const [vectorBytes, chunkBytes, pageCount] = await Promise.all([
          vectorStore.byteSize(this.db, indexId),
          chunkStore.byteSize(this.db, indexId),
          pageStore.countByIndex(this.db, indexId),
        ]);
        await indexRepo.upsert(this.db, {
          ...meta,
          pageCount,
          chunkCount: chunks.length,
          // Measured, not estimated (PRD 5.6.1).
          sizeBytes: vectorBytes + chunkBytes,
          lastIndexedAt: this.clock(),
        });
      }

      if (phase === "done") await metaRepo.clearActiveCrawl(this.db);
      else await this.markActive();
    }
    await this.emit(phase, null);
  }

  private async emit(phase: CrawlProgress["phase"], currentUrl: string | null): Promise<void> {
    const counts = this.indexId
      ? await frontier.counts(this.db, this.indexId)
      : { queued: 0, done: 0, failed: 0, skipped: 0 };
    const progress: CrawlProgress = {
      fetched: counts.done,
      queued: counts.queued,
      failed: counts.failed,
      skipped: counts.skipped,
      embedded: this.embeddedThisRun,
      currentUrl,
      phase,
      ...(this.authWall
        ? { authWall: { host: this.authWall.host, blocked: counts.queued, kind: this.authWall.kind } }
        : {}),
    };
    this.post(progress);
  }
}
