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
import { hasHostPermission } from "@/permissions/host.js";
import { loadSession } from "@/retrieval/session.js";
import { retrieve } from "@/retrieval/retrieve.js";
import {
  calibrateFloors,
  PROBE_QUESTIONS,
  type Calibration,
} from "@/retrieval/calibrate.js";
import { runCrawl, type CrawlOutcome } from "@/crawl/engine.js";
import { discoverSeeds } from "@/crawl/discovery.js";
import { canonicalizeUrl, underRoot } from "@/lib/url.js";
import { inScope } from "@/lib/patterns.js";
import { fnv1a } from "@/lib/hash.js";
import { shouldReindex, shouldRebuildSparseIndex } from "@/crawl/incremental.js";
import { backgroundConfig } from "@/crawl/autoRefresh.js";
import { needsRender, blocksWordCount, renderInTab, RenderTracker } from "@/crawl/render.js";
import { chunkPage } from "@/lib/chunk.js";
import { extractPage } from "@/extract/extract.js";
import { getEmbedder, DEFAULT_EMBEDDING_MODEL_ID } from "@/embed/embedder.js";
import { browserFetch, domLinks, fetchText } from "./browserFetch.js";
import { log } from "@/lib/log.js";

/**
 * How many of the index's own titles to score when calibrating.
 *
 * Each one is a full retrieval, so this is a crawl-time latency cost paid once.
 * Twenty is enough to tell "the corpus scores well above its noise" from "this
 * corpus barely separates", which is the only judgement the positives inform.
 */
const CALIBRATION_TITLE_SAMPLES = 20;

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
  /**
   * True while this run is a scheduled refresh. It changes two things: the run
   * is paced by `backgroundConfig`, and `yieldToUser` is allowed to pause it.
   * A crawl the user started and is watching is never touched by either.
   */
  private background = false;
  /** Set when `yieldToUser` paused a background run, so idle can resume it. */
  private yielded = false;
  /** Cached per crawl so robots.txt + the sitemap aren't refetched each loop. */
  private robots: Robots | null = null;
  private embeddedThisRun = 0;
  private retrying = 0;
  /** Pages a 304 confirmed unchanged, for the progress readout. */
  private unchangedThisRun = 0;
  /** Pages actually re-extracted and re-embedded this run. */
  private reindexedThisRun = 0;
  /** The embedding model this run is using; stamped on the index at the end. */
  private modelId = DEFAULT_EMBEDDING_MODEL_ID;
  /** Per-crawl budget for the SPA render fallback. */
  private render = new RenderTracker();

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
    this.background = active.background === true;
    // Re-throttle on resume — a background crawl that came back at full speed
    // after a restart would be exactly the intrusion this is meant to avoid.
    this.config = this.background ? backgroundConfig(meta.config) : meta.config;
    this.incremental = active.incremental;
    this.paused = active.paused;
    this.yielded = this.background && active.paused;
    this.authWall = null;

    /**
     * Host access can be gone by the time a crawl resumes.
     *
     * Resuming without checking is how the offscreen document ended up throwing
     * `Access to fetch at 'https://…/robots.txt' … blocked by CORS policy` on
     * every reload: an extension fetch without host permission is an ordinary
     * cross-origin request, so the first thing a resumed crawl does — read
     * robots.txt — fails, and it fails again on the next restart, and the next.
     *
     * A resume has no user gesture, so it cannot prompt; `permissions.request`
     * only works from a click. The scheduled refresh already knows this and
     * checks first (see `service-worker.ts`) — this path simply never did.
     * Stand down the same way it does: stay paused, mark the index as needing
     * access so the Indexes table offers the re-grant, and let the user's click
     * be what asks.
     */
    if (!(await hasHostPermission(meta.root))) {
      this.paused = true;
      await this.markActive();
      await indexRepo.upsert(this.db, { ...meta, autoRefreshBlocked: true });
      await this.emit("paused", null);
      return true;
    }

    await this.emit(active.paused ? "paused" : "crawling", null);
    if (!active.paused) await this.loop();
    return true;
  }

  async start(config: CrawlConfig): Promise<void> {
    await this.resolveModel();
    this.config = config;
    this.background = false;
    this.yielded = false;
    this.paused = false;
    this.authWall = null;
    this.incremental = false;
    this.robots = null;
    this.embeddedThisRun = 0;
    this.unchangedThisRun = 0;
    this.reindexedThisRun = 0;
    this.render = new RenderTracker();
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
      embeddingModel: this.modelId,
      config,
    });
    await this.markActive();
    await this.seed(config);
    await this.loop();
  }

  /** Incremental recrawl of an existing index (PRD 5.6.5): revisit known URLs
   * plus freshly discovered ones; unchanged pages skip re-embedding. */
  async startIncremental(indexId: string, opts: { background?: boolean } = {}): Promise<void> {
    // A scheduled refresh defers to anything already in flight rather than
    // seizing the controller — losing one 6-hourly tick costs nothing, whereas
    // clobbering a crawl the user is watching is a visible failure.
    if (opts.background && (this.running || this.paused)) return;

    const meta = await indexRepo.get(this.db, indexId);
    if (!meta?.config) return;

    // An incremental pass skips pages whose content is unchanged — which is
    // exactly wrong when the *embedding model* changed rather than the pages.
    // It would re-fetch the whole site and re-embed none of it. Escalate to a
    // full rebuild so Refresh can't silently be a no-op.
    if ((meta.embeddingModel ?? "") !== (await this.resolveModel())) {
      // A model change means re-embedding every page — far too much work to do
      // behind the user's back. Leave it for the Rebuild they'll be prompted
      // for, rather than turning a quiet refresh into a full rebuild.
      if (opts.background) return;
      await this.startFullRecrawl(indexId);
      return;
    }

    // Scheduled runs are deliberately slow (see backgroundConfig): single-flight
    // at half rate, which throttles fetching and — because embedding is driven
    // by page arrivals — the CPU-heavy half of the pipeline along with it.
    this.background = opts.background === true;
    this.yielded = false;
    this.config = this.background ? backgroundConfig(meta.config) : meta.config;
    this.indexId = indexId;
    this.incremental = true;
    this.paused = false;
    this.authWall = null;
    this.robots = null;
    this.embeddedThisRun = 0;
    this.unchangedThisRun = 0;
    this.reindexedThisRun = 0;
    this.render = new RenderTracker();
    await this.markActive();
    await this.emit("discovering", null);
    await frontier.requeueAll(this.db, indexId);
    const pages = await pageStore.listByIndex(this.db, indexId);
    await frontier.seed(this.db, indexId, pages.map((p) => ({ url: p.url, depth: 0 })));
    await this.seed(this.config);
    await this.loop();
  }

  /**
   * Full re-crawl (PRD 5.6.4): discard everything indexed for this site and
   * crawl it again from the same config, keeping the index id so the user's
   * active-index selection and their place in the UI survive.
   */
  async startFullRecrawl(indexId: string, override?: CrawlConfig): Promise<void> {
    const meta = await indexRepo.get(this.db, indexId);
    if (!meta?.config) return;
    await this.resolveModel();
    // A re-crawl may carry edited settings — scope, caps, politeness.
    const config = override ?? meta.config;
    await indexRepo.clearContent(this.db, indexId);
    await indexRepo.upsert(this.db, { ...meta, pageCount: 0, chunkCount: 0, sizeBytes: 0, config });
    this.config = config;
    this.indexId = indexId;
    this.incremental = false;
    this.background = false;
    this.yielded = false;
    this.paused = false;
    this.authWall = null;
    this.robots = null;
    this.embeddedThisRun = 0;
    this.unchangedThisRun = 0;
    this.reindexedThisRun = 0;
    this.render = new RenderTracker();
    await this.markActive();
    await this.seed(config);
    await this.loop();
  }

  /**
   * The user came back to the keyboard — stand down if this is a scheduled
   * refresh. A crawl they started themselves is left alone: they can see it,
   * they asked for it, and pausing it under them would be the bug.
   */
  async yieldToUser(): Promise<void> {
    if (!this.background || this.paused) return;
    this.yielded = true;
    this.paused = true;
    await this.markActive();
  }

  /** The machine went idle again — pick a yielded background refresh back up. */
  async resumeBackground(): Promise<void> {
    if (!this.background || !this.yielded || this.running) return;
    this.yielded = false;
    this.paused = false;
    await this.markActive();
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

  /** Which embedding model this run should use, from settings. */
  private async resolveModel(): Promise<string> {
    this.modelId = (await getEmbedder()).modelId;
    return this.modelId;
  }

  private async markActive(): Promise<void> {
    if (!this.indexId) return;
    await metaRepo.setActiveCrawl(this.db, {
      indexId: this.indexId,
      incremental: this.incremental,
      paused: this.paused,
      startedAt: this.clock(),
      background: this.background,
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
    try {
      await this.runLoop();
    } catch (error) {
      // Anything unexpected — a failed discovery, storage giving out — must
      // still land the index in a consistent state and release `running`, or
      // Resume silently does nothing and the crawl can never be picked up.
      log.error("crawl_loop_failed", { error: String(error) });
      this.running = false;
      await this.finalize({ reason: "failed", status: 0 });
    }
  }

  private async runLoop(): Promise<void> {
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
      // Only an incremental pass revalidates: a full rebuild must re-read
      // every page, and a first crawl has nothing to compare against.
      ...(this.incremental
        ? {
            validatorsFor: async (url: string) => {
              const stored = await pageStore.get(this.db, indexId, url);
              return stored ? { etag: stored.etag, lastmod: stored.lastmod } : undefined;
            },
            onUnchanged: (url: string) => {
              this.unchangedThisRun += 1;
              void this.emit("crawling", url);
            },
          }
        : {}),
      onPage: async (res) => {
        await this.indexPage(indexId, res.finalUrl, res.html ?? "", res.etag, res.lastmod);
        await this.emit("embedding", res.finalUrl);
      },
      onProgress: () => void this.emit("crawling", null),
      onAuthWall: (wall) => {
        this.authWall = wall;
      },
      onRetrySweep: (requeued) => {
        this.retrying = requeued;
        void this.emit("crawling", null);
      },
      onIndexError: (url, error) => {
        // Surfaced rather than swallowed: a page that consistently fails to
        // index is a extraction bug worth seeing in the console.
        log.warn("page_index_failed", { url, error: String(error) });
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

    /**
     * JS-rendered docs return an almost-empty shell: re-read the settled DOM.
     * Budgeted, because each render opens and closes a background tab — on a
     * site where extraction is thin everywhere, an unbudgeted fallback opens
     * one per page and makes the whole browser feel hung (see RenderTracker).
     */
    if (needsRender(blocksWordCount(extracted.blocks)) && this.render.allows()) {
      const before = blocksWordCount(extracted.blocks);
      const rendered = await renderInTab(url);
      let helped = false;
      if (rendered) {
        const richer = extractPage(new DOMParser().parseFromString(rendered, "text/html"), url);
        if (blocksWordCount(richer.blocks) > before) {
          extracted = richer;
          helped = true;
        }
      }
      this.render.record(helped);
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
    this.reindexedThisRun += 1;
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
      const rebuildSparse = shouldRebuildSparseIndex(this.incremental, this.reindexedThisRun);

      // Build the sparse index once, here, instead of per query (PRD 5.5.4) —
      // but not when an incremental pass changed nothing, since the stored
      // blob is already correct and rebuilding it re-tokenises every chunk in
      // the index to produce the same bytes.
      const chunks = rebuildSparse ? await chunkStore.listByIndex(this.db, indexId) : [];
      if (rebuildSparse) {
        await bm25Store.build(
          this.db,
          indexId,
          chunks.map((c) => ({
            id: c.vectorId,
            title: c.title,
            section: c.headingPath,
            content: c.body,
          })),
        );
      }

      const meta = await indexRepo.get(this.db, indexId);
      if (meta) {
        const pageCount = await pageStore.countByIndex(this.db, indexId);
        const [vectorBytes, chunkBytes] = rebuildSparse
          ? await Promise.all([
              vectorStore.byteSize(this.db, indexId),
              chunkStore.byteSize(this.db, indexId),
            ])
          : [meta.sizeBytes, 0];

        // A crawl that indexed nothing — blocked at an auth wall, or aborted —
        // must not claim it succeeded. Stamping the model and the timestamp
        // anyway cleared the "needs rebuild" banner and left the panel
        // reporting a fresh index of 0 pages.
        const indexedSomething = pageCount > 0;

        /**
         * Calibrate the refusal floor against the corpus that was just built.
         *
         * Terminal states only, and both of them. `done` is the happy path;
         * `error` still leaves a finished, queryable index — a crawl that
         * indexed 222 pages before the failure ceiling tripped is an index
         * people will ask questions of, and leaving it uncalibrated means it
         * keeps the global floor that cannot refuse anything.
         *
         * `paused` and `auth` are excluded because they are resumable: the
         * corpus is about to change, so a floor measured now describes content
         * that will not be what gets searched. The next completed run
         * recalibrates from scratch, so an early measurement is corrected
         * rather than inherited.
         *
         * A failure here costs the calibration, never the crawl — the index
         * falls back to Settings exactly as every pre-calibration index does.
         */
        const floors =
          indexedSomething && (phase === "done" || phase === "error")
            ? await this.calibrate(indexId).catch((error) => {
                log.warn("calibration_failed", { error: String(error) });
                return undefined;
              })
            : undefined;

        await indexRepo.upsert(this.db, {
          ...meta,
          pageCount,
          chunkCount: rebuildSparse ? chunks.length : meta.chunkCount,
          // Measured, not estimated (PRD 5.6.1).
          sizeBytes: vectorBytes + chunkBytes,
          ...(indexedSomething
            ? { embeddingModel: this.modelId, lastIndexedAt: this.clock() }
            : {}),
          ...(floors ? { floors } : {}),
        });
      }

      if (phase === "done") {
        await metaRepo.clearActiveCrawl(this.db);
      } else {
        /**
         * A crawl that aborted stays resumable, but must not resume *itself*.
         *
         * `error` means the failure ceiling tripped — the site was refusing
         * requests, or access is gone. Leaving it un-paused meant the offscreen
         * document picked it straight back up on every browser start and every
         * extension reload, re-running the crawl that had just failed. Marking
         * it paused keeps the Resume button working and stops the loop.
         */
        if (phase === "error") this.paused = true;
        await this.markActive();
      }
    }
    await this.emit(phase, null);
  }

  /**
   * Measure where this index's refusal floor belongs (see calibrate.ts).
   *
   * Runs the probe questions through the *real* retrieval path rather than
   * scoring vectors directly, because the floor is compared against what
   * `retrieve` reports — fusion, article assembly and all. A threshold measured
   * on a different quantity than the one it gates is not a calibration.
   *
   * Positives come from the index's own article titles. They are the docs' own
   * words and so an optimistic upper bound; `calibrateFloors` treats them only
   * as a guard against calibrating the index into silence, never as the source
   * of the floor.
   */
  private async calibrate(indexId: string): Promise<Calibration | undefined> {
    const embedder = await getEmbedder();
    const session = await loadSession(this.db, indexId);
    if (session.vectors.count === 0) return undefined;

    const topScore = async (query: string): Promise<number> =>
      (await retrieve({ db: this.db, indexId, embedder, session }, query)).topScore;

    const negativeScores: number[] = [];
    for (const probe of PROBE_QUESTIONS) negativeScores.push(await topScore(probe));

    // A spread of titles rather than the first few, which on most help centres
    // are one navigation section and score alike.
    const titles = [...new Set([...session.byId.values()].map((c) => c.title).filter(Boolean))];
    const step = Math.max(1, Math.floor(titles.length / CALIBRATION_TITLE_SAMPLES));
    const positiveScores: number[] = [];
    for (let i = 0; i < titles.length && positiveScores.length < CALIBRATION_TITLE_SAMPLES; i += step) {
      positiveScores.push(await topScore(titles[i]!));
    }

    return calibrateFloors({ negativeScores, positiveScores }, this.clock());
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
      ...(this.retrying > 0 ? { retrying: this.retrying } : {}),
      ...(this.unchangedThisRun > 0 ? { unchanged: this.unchangedThisRun } : {}),
      ...(this.authWall
        ? { authWall: { host: this.authWall.host, blocked: counts.queued, kind: this.authWall.kind } }
        : {}),
    };
    this.post(progress);
  }
}
