/**
 * Offscreen document entrypoint (PRD 5.2.1). Hosts the resumable crawl loop off
 * the service worker. The transformers.js embedding worker joins here in #4/#5.
 */

import { isMessage } from "@/background/messages.js";
import type { CrawlProgress } from "@/background/messages.js";
import type { PanelEvent } from "@/shared/answer.js";
import { openSherpaDb } from "@/storage/db.js";
import { CrawlController } from "./runCrawlJob.js";
import { runQuery } from "./answerQueryJob.js";

const post = (progress: CrawlProgress): void => {
  void chrome.runtime.sendMessage({ type: "crawl/progress", progress }).catch(() => {});
};

let controller: CrawlController | null = null;

async function getController(): Promise<CrawlController> {
  if (!controller) controller = new CrawlController(await openSherpaDb(), post);
  return controller;
}

chrome.runtime.onMessage.addListener((raw: unknown) => {
  if (!isMessage(raw)) return;
  switch (raw.type) {
    case "crawl/start":
      void getController().then((c) => c.start(raw.config));
      break;
    case "crawl/pause":
      void getController().then((c) => c.pause());
      break;
    case "crawl/resume":
      void getController().then((c) => c.resume());
      break;
    case "crawl/recrawl": {
      const { indexId } = raw;
      void getController().then((c) => c.startIncremental(indexId));
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
