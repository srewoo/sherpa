/**
 * Side-panel → offscreen bridge. Sends a question and delivers the streamed
 * PanelEvents to a callback. Guarded so the same App renders in a plain browser
 * preview (no chrome APIs) as in the installed extension.
 */

import type { PanelEvent } from "@/shared/answer.js";
import { openSherpaDb } from "@/storage/db.js";
import { queryLogStore } from "@/gap/queryLog.js";

export const hasExtension =
  typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);

let counter = 0;

/** The page the user is reading, so retrieval can favour its section. */
async function activeTabUrl(): Promise<string | undefined> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.url && /^https?:/.test(tab.url) ? tab.url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Preload the embedder and index session.
 *
 * Called when the panel learns which index is active, which is well before the
 * user finishes typing. The work is identical either way; this only moves it
 * off the critical path and into the seconds the user spends reading the page
 * and composing a question.
 */
export function warmIndex(indexId: string): void {
  if (!hasExtension) return;
  void chrome.runtime
    .sendMessage({ type: "ensure-offscreen" })
    .then(() => chrome.runtime.sendMessage({ type: "query/warm", indexId }))
    .catch(() => {});
}

export function askQuery(
  indexId: string,
  query: string,
  onEvent: (event: PanelEvent) => void,
  /**
   * Earlier questions, most recent first. Retrieval resolves a follow-up
   * against them — without this the panel shows the context on screen and the
   * search cannot see it.
   */
  recentQuestions: readonly string[] = [],
  /**
   * Scope retrieval to one page. Set when the question came from a refinement
   * chip, where the user has named an exact document — searching for its title
   * instead discards that and re-runs the query most likely to scatter again.
   */
  focusUrl?: string,
  /** The question the pick answered, for the learned prior (prior.ts). */
  pickedFor?: string,
): void {
  const requestId = `q-${(counter += 1)}`;
  const listener = (msg: unknown): void => {
    const m = msg as { type?: string; requestId?: string; event?: PanelEvent };
    if (m?.type !== "query/event" || m.requestId !== requestId || !m.event) return;
    onEvent(m.event);
    if (m.event.kind === "done") chrome.runtime.onMessage.removeListener(listener);
  };
  chrome.runtime.onMessage.addListener(listener);
  // Make sure the offscreen doc is alive, then ask.
  void chrome.runtime
    .sendMessage({ type: "ensure-offscreen" })
    .then(() => activeTabUrl())
    .then((currentUrl) => {
      void chrome.runtime.sendMessage({
        type: "query/ask",
        requestId,
        indexId,
        query,
        currentUrl,
        recentQuestions,
        focusUrl,
        pickedFor,
      });
    });
}

/** Record 👍/👎 against the logged query, feeding the gap report (PRD 5.9.8). */
export async function sendFeedback(
  indexId: string,
  query: string,
  feedback: "up" | "down",
): Promise<void> {
  if (!hasExtension) return;
  const db = await openSherpaDb();
  await queryLogStore.setFeedback(db, indexId, query, feedback);
}

/** Kick off an incremental refresh of the active index from the panel (5.6.2). */
export function requestRefresh(indexId: string): void {
  if (!hasExtension) return;
  void chrome.runtime.sendMessage({ type: "ensure-offscreen" }).finally(() => {
    void chrome.runtime.sendMessage({ type: "crawl/recrawl", indexId });
  });
}

/** Rebuild an index from scratch — needed after an embedding-model change. */
export function requestFullRecrawl(indexId: string): void {
  if (!hasExtension) return;
  void chrome.runtime.sendMessage({ type: "ensure-offscreen" }).finally(() => {
    void chrome.runtime.sendMessage({ type: "crawl/recrawl-full", indexId });
  });
}

/**
 * Open the options page — crawl setup, indexes, gap report, settings.
 *
 * The panel is the only surface most users ever see, so without this the whole
 * of Options is reachable only through chrome://extensions.
 */
export function openOptions(hash?: string): void {
  if (!hasExtension) return;
  if (hash) {
    void chrome.tabs.create({ url: chrome.runtime.getURL(`src/options/index.html#${hash}`) });
    return;
  }
  chrome.runtime.openOptionsPage();
}
