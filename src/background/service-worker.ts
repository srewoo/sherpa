/**
 * Service worker (PRD §6): routing, lifecycle, shortcuts. Deliberately thin —
 * MV3 workers die at 30s idle, so no long work lives here. The crawl loop runs
 * in the offscreen document, which this worker creates on demand.
 */

import { isMessage, type Message } from "./messages.js";

const OFFSCREEN_PATH = "src/offscreen/offscreen.html";

/** Open the side panel from the toolbar action without extra clicks. */
chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

/** Keyboard shortcut → open the panel for the focused window (PRD 5.9.2). */
chrome.commands.onCommand.addListener((command) => {
  if (command !== "open-sherpa") return;
  chrome.windows.getCurrent().then((win) => {
    if (win.id !== undefined) void chrome.sidePanel.open({ windowId: win.id });
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
    case "ensure-offscreen":
    case "crawl/start":
      ensureOffscreen().then(() => sendResponse({ ok: true }));
      return true; // async response
    default:
      return false;
  }
});
