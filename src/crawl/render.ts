/**
 * SPA render fallback (PRD 5.2.11). Some doc sites ship an empty shell and
 * hydrate content with JS, so a static fetch yields almost no words. When that
 * happens we load the page in a background tab, let it settle, and read the
 * rendered DOM. The trigger (`needsRender`) is pure and tested; the tab render
 * is browser-only.
 */

import type { Block } from "@/domain/content.js";

export const MIN_WORDS = 50;
const SETTLE_MS = 1500;

export function wordCount(text: string): number {
  const t = text.trim();
  return t === "" ? 0 : t.split(/\s+/).length;
}

export function blocksWordCount(blocks: readonly Block[]): number {
  return blocks.reduce((n, b) => n + wordCount(b.text), 0);
}

export function needsRender(wordTotal: number, min = MIN_WORDS): boolean {
  return wordTotal < min;
}

/**
 * Ask for `url` to be rendered and return the settled DOM.
 *
 * The crawl runs in the offscreen document, which may only use
 * `chrome.runtime` — `chrome.tabs` and `chrome.scripting` are unavailable
 * there. So the offscreen doc asks the service worker to do the tab work and
 * hand back the HTML; `renderPageInTab` below is the worker-side half.
 */
export async function renderInTab(url: string): Promise<string | null> {
  try {
    const response = (await chrome.runtime.sendMessage({ type: "render/page", url })) as
      | { html?: string | null }
      | undefined;
    return response?.html ?? null;
  } catch {
    // No listener, or the render failed — fall back to the static HTML.
    return null;
  }
}

/**
 * Service-worker side: load the page in a background tab, let it settle, read
 * the rendered DOM, and always clean the tab up.
 */
export async function renderPageInTab(url: string): Promise<string | null> {
  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    if (tabId === undefined) return null;
    await waitForComplete(tabId);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.documentElement.outerHTML,
    });
    return (result?.result as string | undefined) ?? null;
  } catch {
    return null;
  } finally {
    if (tabId !== undefined) await chrome.tabs.remove(tabId).catch(() => {});
  }
}

function waitForComplete(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    const listener = (id: number, info: chrome.tabs.TabChangeInfo): void => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Safety timeout so a stalled load can't hang the crawl.
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 8000);
  });
}
