/**
 * Side-panel → offscreen query bridge. Sends a question and delivers the
 * streamed PanelEvents to a callback. Guarded so the same App renders in a plain
 * browser preview (no chrome APIs) as in the installed extension.
 */

import type { PanelEvent } from "@/shared/answer.js";

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

export async function activeIndexId(): Promise<string> {
  if (!hasExtension) return "";
  const s = await chrome.storage.local.get("activeIndexId");
  return (s["activeIndexId"] as string | undefined) ?? "";
}
