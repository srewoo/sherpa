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
import { openSherpaDb } from "@/storage/db.js";
import { storageEstimate } from "@/storage/quota.js";
import { previewCrawl } from "@/crawl/preview.js";
import { invalidateSession } from "@/retrieval/session.js";
import { CrawlController, USER_AGENT } from "./runCrawlJob.js";
import { fetchText } from "./browserFetch.js";
import { runQuery } from "./answerQueryJob.js";

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
      const { indexId } = raw;
      void getController().then((c) => afterCrawl(c.startIncremental(indexId)));
      break;
    }
    case "crawl/recrawl-full": {
      const { indexId } = raw;
      void getController().then((c) => afterCrawl(c.startFullRecrawl(indexId)));
      break;
    }
    case "crawl/preview": {
      const { requestId, config } = raw;
      void (async () => {
        try {
          const preview = await previewCrawl(config, fetchText, await storageEstimate(), USER_AGENT);
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
    case "query/ask": {
      const { requestId, indexId, query } = raw;
      const emit = (event: PanelEvent): void => {
        void chrome.runtime.sendMessage({ type: "query/event", requestId, event }).catch(() => {});
      };
      void openSherpaDb()
        .then((db) => runQuery(db, indexId, query, emit))
        .catch(() => emit({ kind: "done" }));
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
