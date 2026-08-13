/**
 * Offscreen document entrypoint (PRD 5.2.1). Hosts the crawl loop, the embedder
 * and the query path — everything too slow for the service worker, which MV3
 * kills at 30s idle.
 *
 * On load it also resumes any crawl left unfinished by a previous session
 * (PRD 5.2.2), which is what lets a 2,000-page crawl survive a browser restart
 * instead of starting over.
 */

import { isMessage } from "@/background/messages.js";
import type { CrawlProgress } from "@/background/messages.js";
import type { PanelEvent } from "@/shared/answer.js";
import { openSherpaDb, closeSherpaDb } from "@/storage/db.js";
import { storageEstimate } from "@/storage/quota.js";
import { previewCrawl } from "@/crawl/preview.js";
import { invalidateSession, loadSession } from "@/retrieval/session.js";
import { getEmbedder } from "@/embed/embedder.js";
import { CrawlController, USER_AGENT } from "./runCrawlJob.js";
import { fetchText, browserFetch, domLinks } from "./browserFetch.js";
import { runQuery } from "./answerQueryJob.js";
import { importCorpus } from "./importCorpusJob.js";
import { parseCorpusExport } from "@/eval/corpusExport.js";

const post = (progress: CrawlProgress): void => {
  void chrome.runtime.sendMessage({ type: "crawl/progress", progress }).catch(() => {});
};

let controller: CrawlController | null = null;

async function getController(): Promise<CrawlController> {
  if (!controller) controller = new CrawlController(await openSherpaDb(), post);
  return controller;
}

/**
 * A crawl mutates the index underneath a cached retrieval session, so the cache
 * is dropped when one finishes — otherwise queries keep answering from the
 * pre-crawl snapshot.
 */
function afterCrawl(run: Promise<void>): void {
  void run.finally(() => invalidateSession());
}

chrome.runtime.onMessage.addListener((raw: unknown) => {
  if (!isMessage(raw)) return;
  switch (raw.type) {
    case "crawl/start": {
      const { config } = raw;
      void getController().then((c) => afterCrawl(c.start(config)));
      break;
    }
    case "crawl/pause":
      void getController().then((c) => c.pause());
      break;
    case "crawl/resume":
      void getController().then((c) => afterCrawl(c.resume()));
      break;
    case "crawl/recrawl": {
      const { indexId, background } = raw;
      void getController().then((c) =>
        afterCrawl(c.startIncremental(indexId, { background: background === true })),
      );
      break;
    }
    // Idle-state transitions (5.6.6). Both are no-ops unless the crawl in
    // flight is a scheduled one, so a crawl the user is watching is untouched.
    case "crawl/yield":
      void getController().then((c) => c.yieldToUser());
      break;
    case "crawl/unyield":
      void getController().then((c) => afterCrawl(c.resumeBackground()));
      break;
    case "crawl/recrawl-full": {
      const { indexId, config } = raw;
      void getController().then((c) => afterCrawl(c.startFullRecrawl(indexId, config)));
      break;
    }
    /**
     * Import runs here rather than in the options page because it needs the
     * embedder, which is loaded once in this document.
     */
    case "index/import": {
      const { url } = raw;
      void (async () => {
        try {
          const corpus = parseCorpusExport(await (await fetch(url)).json());
          const db = await openSherpaDb();
          await importCorpus(db, corpus, (progress) => {
            void chrome.runtime.sendMessage({ type: "index/import-progress", progress }).catch(() => {});
          });
          invalidateSession();
        } catch (err) {
          void chrome.runtime
            .sendMessage({
              type: "index/import-progress",
              progress: {
                phase: "error",
                done: 0,
                total: 0,
                host: "",
                error: err instanceof Error ? err.message : "import failed",
              },
            })
            .catch(() => {});
        }
      })();
      break;
    }
    case "crawl/preview": {
      const { requestId, config } = raw;
      void (async () => {
        try {
          const preview = await previewCrawl(config, {
            fetchText,
            estimate: await storageEstimate(),
            userAgent: USER_AGENT,
            // Probing the root's own links is what catches a root that scopes
            // the crawl down to a single page (PRD 5.1.4).
            fetchPage: browserFetch,
            extractLinks: domLinks,
          });
          await chrome.runtime.sendMessage({ type: "crawl/preview-result", requestId, preview });
        } catch (err) {
          await chrome.runtime
            .sendMessage({
              type: "crawl/preview-result",
              requestId,
              preview: null,
              error: err instanceof Error ? err.message : "discovery failed",
            })
            .catch(() => {});
        }
      })();
      break;
    }
    // "Delete everything" can't drop the database while we hold it open.
    case "db/close":
      invalidateSession();
      controller = null;
      void closeSherpaDb();
      break;
    /**
     * Warm the caches. Fire-and-forget by design: this is an optimisation, and
     * a failure here must cost nothing — whatever didn't load will simply load
     * on the first query, exactly as it did before.
     */
    case "query/warm": {
      const { indexId } = raw;
      void getEmbedder().catch(() => {});
      void openSherpaDb()
        .then((db) => loadSession(db, indexId))
        .catch(() => {});
      break;
    }
    case "query/ask": {
      /**
       * `recentQuestions` was sent by the panel and dropped here, so
       * `resolveFollowUp` has only ever seen an empty history — the whole
       * follow-up feature was inert in the shipped extension while its unit
       * tests passed. Destructured now, along with the new `focusUrl`.
      */
      const { requestId, indexId, query, currentUrl, recentQuestions, focusUrl, pickedFor, settings } = raw;
      // `sendMessage` is asynchronous. Preserve source/delta/refusal/done
      // ordering so a terminal event cannot remove the panel listener before
      // the answer body reaches it.
      let delivery = Promise.resolve();
      const emit = (event: PanelEvent): void => {
        delivery = delivery
          .catch(() => {})
          .then(() => chrome.runtime.sendMessage({ type: "query/event", requestId, event }))
          .catch(() => {});
      };
      void openSherpaDb()
        .then((db) =>
          runQuery(db, indexId, query, emit, currentUrl, recentQuestions ?? [], focusUrl, pickedFor, settings),
        )
        .catch((error: unknown) => {
          emit({
            kind: "refusal",
            nearest: [],
            reason: "generator-error",
            detail: error instanceof Error ? error.message : String(error),
          });
          emit({ kind: "done" });
        });
      break;
    }
    default:
      break;
  }
});

// Resume an interrupted crawl as soon as the document is alive (PRD 5.2.2).
void getController()
  .then((c) => c.rehydrate())
  .catch(() => {});
