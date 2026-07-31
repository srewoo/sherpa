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

export function askQuery(
  indexId: string,
  query: string,
  onEvent: (event: PanelEvent) => void,
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
  void chrome.runtime.sendMessage({ type: "ensure-offscreen" }).finally(() => {
    void chrome.runtime.sendMessage({ type: "query/ask", requestId, indexId, query });
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
