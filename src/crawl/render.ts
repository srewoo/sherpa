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
 * Budget for the render fallback across one crawl.
 *
 * Rendering opens a background tab, waits for load, waits another 1.5s to
 * settle, injects a script and closes it — a few seconds of browser-wide churn
 * per page. That is a fair price for the handful of JS-rendered pages it was
 * built for, and ruinous when *every* page trips the heuristic: a login-gated
 * or unusually-marked-up site extracts under 50 words everywhere, and a
 * 1,400-page crawl then opens 1,400 tabs. The browser feels broken, and none of
 * it helps.
 *
 * So the fallback gets a budget and gives up when it stops paying. The tracker
 * is per crawl, not global — a site that genuinely needs rendering gets its
 * full allowance on every run.
 */
export interface RenderBudget {
  /** Hard ceiling on renders per crawl, however well they work. */
  readonly max: number;
  /** Give up after this many consecutive renders that returned nothing better. */
  readonly maxConsecutiveFailures: number;
}

export const DEFAULT_RENDER_BUDGET: RenderBudget = { max: 50, maxConsecutiveFailures: 5 };

export class RenderTracker {
  private used = 0;
  private consecutiveFailures = 0;
  private abandoned = false;

  constructor(private readonly budget: RenderBudget = DEFAULT_RENDER_BUDGET) {}

  /** Should we spend a render on this page? */
  allows(): boolean {
    return !this.abandoned && this.used < this.budget.max;
  }

  /**
   * Record the outcome. "Helped" means the rendered DOM actually yielded more
   * text than the raw fetch — a render that returns the same empty shell is a
   * failure even though nothing threw.
   */
  record(helped: boolean): void {
    this.used += 1;
    if (helped) {
      this.consecutiveFailures = 0;
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.budget.maxConsecutiveFailures) this.abandoned = true;
  }

  /** True once the fallback has been switched off for this crawl. */
  get givenUp(): boolean {
    return this.abandoned;
  }

  get rendersUsed(): number {
    return this.used;
  }
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
