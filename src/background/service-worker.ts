/**
 * Service worker (PRD §6): routing, lifecycle, shortcuts. Deliberately thin —
 * MV3 workers die at 30s idle, so no long work lives here. The crawl loop runs
 * in the offscreen document, which this worker creates on demand.
 */

import { isMessage, type Message } from "./messages.js";

const OFFSCREEN_PATH = "src/offscreen/offscreen.html";

/** Open the side panel from the toolbar action without extra clicks. */
chrome.runtime.onInstalled.addListener((details) => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  // First run: state plainly what gets crawled, where it's stored, and what
  // leaves the machine — before Sherpa touches anything (PRD 5.10.4).
  if (details.reason === "install") {
    void chrome.tabs.create({ url: chrome.runtime.getURL("src/options/index.html#welcome") });
  }
});

/**
 * Bring the offscreen document up when Chrome restarts, so a crawl interrupted
 * by that restart resumes on its own (PRD 5.2.2) — the document's load handler
 * does the rehydration.
 */
chrome.runtime.onStartup.addListener(() => {
  void ensureOffscreen();
});

/** Keyboard shortcut → open the panel and focus its input (PRD 5.9.2). */
chrome.commands.onCommand.addListener((command) => {
  if (command !== "open-sherpa") return;
  void chrome.windows.getCurrent().then(async (win) => {
    if (win.id === undefined) return;
    await chrome.sidePanel.open({ windowId: win.id });
    // The panel may still be booting; a failed send is harmless, because a
    // freshly mounted panel focuses its input anyway.
    await chrome.runtime.sendMessage({ type: "panel/open" }).catch(() => {});
  });
});

async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.offscreen.hasDocument();
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification:
      "Runs the resumable crawl loop and in-browser embedding off the service worker.",
  });
}

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  if (!isMessage(raw)) return false;
  const msg: Message = raw;

  switch (msg.type) {
    // Everything the offscreen document handles needs it alive first.
    case "ensure-offscreen":
    case "crawl/start":
    case "crawl/preview":
    case "crawl/recrawl":
    case "crawl/recrawl-full":
      ensureOffscreen().then(() => sendResponse({ ok: true }));
      return true; // async response
    default:
      return false;
  }
});
