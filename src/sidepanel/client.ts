/**
 * Side-panel → offscreen bridge. Sends a question and delivers the streamed
 * PanelEvents to a callback. Guarded so the same App renders in a plain browser
 * preview (no chrome APIs) as in the installed extension.
 */

import type { PanelEvent } from "@/shared/answer.js";
import { openSherpaDb } from "@/storage/db.js";
import { queryLogStore } from "@/gap/queryLog.js";
import { loadSettings } from "@/settings/settings.js";

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

/**
 * A handle on a question in flight.
 *
 * Returned rather than accepted as yet another callback, because the only thing
 * the caller can usefully *do* with a running turn is abandon it — and it needs
 * that ability at a point in time the call site cannot predict.
 */
export interface AskHandle {
  /**
   * Abandon this turn.
   *
   * Idempotent, and safe after the answer has already landed: the offscreen
   * document ignores a cancel for a request it no longer holds, which is the
   * common case when the user clicks stop just as the last token arrives.
   */
  readonly cancel: () => void;
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
): AskHandle {
  /**
   * A preview build has no `chrome` at all, so this has to come before any use
   * of it — including the listener registration below, which would throw and
   * leave the turn pending forever rather than settling it.
   *
   * App.tsx already checks `hasExtension` before calling, so this is a second
   * line of defence rather than the primary one; it exists because the first
   * version of this guard sat *after* the listener and was therefore dead code
   * that looked like protection.
   */
  if (!hasExtension) {
    onEvent({
      kind: "refusal",
      nearest: [],
      reason: "generator-error",
      detail: "Sherpa is not running as an extension here, so there is nothing to search.",
    });
    onEvent({ kind: "done" });
    return { cancel: () => {} };
  }

  const requestId = `q-${(counter += 1)}`;
  let completed = false;
  const finish = (event: PanelEvent): void => {
    if (completed) return;
    onEvent(event);
    if (event.kind === "done") {
      completed = true;
      chrome.runtime.onMessage.removeListener(listener);
    }
  };
  const listener = (msg: unknown): void => {
    const m = msg as { type?: string; requestId?: string; event?: PanelEvent };
    if (m?.type !== "query/event" || m.requestId !== requestId || !m.event) return;
    finish(m.event);
  };
  chrome.runtime.onMessage.addListener(listener);

  // An unavailable offscreen document or a rejected settings read used to
  // leave the new turn permanently blank. Report the failed request through
  // the same event path as a provider failure so the panel can settle it.
  const fail = (error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error);
    finish({ kind: "refusal", nearest: [], reason: "generator-error", detail });
    finish({ kind: "done" });
  };

  /**
   * Cancelling settles the turn locally as well as remotely.
   *
   * Two things have to happen and neither implies the other. The offscreen
   * document needs to stop the provider request — that is the message — and the
   * panel needs `done` so it clears "writing…", persists the turn and detaches
   * this listener. Waiting for the offscreen document to send `done` back would
   * leave a stop button that does nothing visible whenever the message fails to
   * deliver, which is exactly when a user presses it.
   */
  const cancel = (): void => {
    if (completed) return;
    void chrome.runtime.sendMessage({ type: "query/cancel", requestId }).catch(() => {});
    finish({ kind: "done" });
  };

  // Make sure the offscreen doc is alive, then ask.
  void chrome.runtime
    .sendMessage({ type: "ensure-offscreen" })
    // The panel reads settings and sends them, rather than letting the
    // offscreen document read for itself — see `query/ask.settings`.
    .then(() => Promise.all([activeTabUrl(), loadSettings()]))
    .then(([currentUrl, settings]) =>
      chrome.runtime.sendMessage({
        type: "query/ask",
        requestId,
        indexId,
        query,
        currentUrl,
        recentQuestions,
        focusUrl,
        pickedFor,
        settings,
      }),
    )
    .catch(fail);

  return { cancel };
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
