/**
 * Offscreen crawl controller. Owns one crawl's lifecycle: discover seeds, seed
 * the frontier, run the engine with the real browser fetch/DOM deps, persist a
 * page record per fetch, and stream progress to the side panel. Extraction +
 * embedding (the richer job inside onPage) arrives in milestones #4/#5.
 */

import type { CrawlConfig } from "@/domain/config.js";
import type { CrawlProgress } from "@/background/messages.js";
import type { AuthWall } from "@/domain/crawl.js";
import type { StoredChunk, StoredPage } from "@/domain/records.js";
import { SCHEMA_VERSION } from "@/domain/records.js";
import type { SherpaDatabase } from "@/storage/db.js";
import { indexRepo } from "@/storage/indexRepo.js";
import { pageStore } from "@/storage/pages.js";
import { chunkStore } from "@/storage/chunks.js";
import { vectorStore } from "@/storage/vectors.js";
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

const USER_AGENT = "SherpaBot (+local-index)";

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

  constructor(
    private readonly db: SherpaDatabase,
    private readonly post: Post,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  async start(config: CrawlConfig): Promise<void> {
    this.config = config;
    this.paused = false;
    this.authWall = null;
    this.incremental = false;
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
    await this.emit("discovering", null);
    await frontier.requeueAll(this.db, indexId);
    const pages = await pageStore.listByIndex(this.db, indexId);
    await frontier.seed(this.db, indexId, pages.map((p) => ({ url: p.url, depth: 0 })));
    await this.seed(meta.config);
    await this.loop();
  }

  pause(): void {
    this.paused = true;
  }

  async resume(): Promise<void> {
    if (this.config && this.indexId && !this.running) {
      this.paused = false;
      await this.loop();
    }
  }

  private async seed(config: CrawlConfig): Promise<void> {
    await this.emit("discovering", null);
    const { urls } = await discoverSeeds(config.root, config.sitemapUrl, fetchText);
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
    const outcome = await runCrawl({
      db: this.db,
      indexId,
      config,
      robots: (await discoverSeeds(config.root, config.sitemapUrl, fetchText)).robots,
      userAgent: USER_AGENT,
      fetcher: browserFetch,
      extractLinks: domLinks,
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
    url: string,
    html: string,
    etag: string | undefined,
    lastmod: string | undefined,
  ): Promise<void> {
    const htmlHash = fnv1a(html);
    const stored = await pageStore.get(this.db, indexId, url);

    // Incremental: unchanged page keeps its chunks and skips re-embedding (5.6.5).
    if (this.incremental && stored && !shouldReindex(stored, { etag, lastmod, htmlHash })) {
      await pageStore.put(this.db, { ...stored, fetchedAt: this.clock() });
      return;
    }
    // Changed page: drop its old chunks before re-indexing.
    if (stored) await chunkStore.deleteByUrl(this.db, indexId, url);

    let extracted = extractPage(new DOMParser().parseFromString(html, "text/html"), url);

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
      const counts = await frontier.counts(this.db, this.indexId);
      const chunkCount = await chunkStore.countByIndex(this.db, this.indexId);
      const meta = await indexRepo.get(this.db, this.indexId);
      if (meta) {
        await indexRepo.upsert(this.db, {
          ...meta,
          pageCount: counts.done,
          chunkCount,
          lastIndexedAt: this.clock(),
        });
      }
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
      embedded: 0,
      currentUrl,
      phase,
      ...(this.authWall
        ? { authWall: { host: this.authWall.host, blocked: counts.queued, kind: this.authWall.kind } }
        : {}),
    };
    this.post(progress);
  }
}
