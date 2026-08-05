/**
 * Service worker (PRD §6): routing, lifecycle, shortcuts. Deliberately thin —
 * MV3 workers die at 30s idle, so no long work lives here. The crawl loop runs
 * in the offscreen document, which this worker creates on demand.
 */

import { isMessage, type Message } from "./messages.js";
import { renderPageInTab } from "@/crawl/render.js";
import { panelEnabledFor } from "./panelScope.js";
import { openSherpaDb, closeSherpaDb } from "@/storage/db.js";
import { indexRepo } from "@/storage/indexRepo.js";
import { loadSettings } from "@/settings/settings.js";
import { hasHostPermission } from "@/permissions/host.js";
import {
  AUTO_REFRESH_ALARM,
  AUTO_REFRESH_RETRY_ALARM,
  AUTO_REFRESH_CHECK_MINUTES,
  AUTO_REFRESH_RETRY_MINUTES,
  dueForRefresh,
} from "@/crawl/autoRefresh.js";

const OFFSCREEN_PATH = "src/offscreen/offscreen.html";

/**
 * How long the machine must be untouched before a scheduled refresh may start.
 * Long enough that it never fires between two keystrokes, short enough that a
 * coffee break is a usable window.
 */
const IDLE_THRESHOLD_SECONDS = 5 * 60;

const SIDE_PANEL_PATH = "src/sidepanel/index.html";

/** Port the panel opens while it is mounted, so the worker knows it is up. */
export const PANEL_PORT = "sherpa-panel";

/**
 * Sherpa's panel belongs to the tab it was opened from, not to the browser.
 *
 * See panelScope.ts for the rule and why it is shaped that way. The state here
 * is deliberately cheap to lose: if the worker is torn down, `panelOpen` falls
 * back to false, every tab becomes enabled again, and the worst case is that
 * the panel is available where it need not be — never that the icon stops
 * working.
 */
let ownerTabId: number | null = null;
let panelOpen = false;

/** Apply the enabled/disabled rule to one tab. */
async function scopeTab(tabId: number): Promise<void> {
  await chrome.sidePanel
    .setOptions({
      tabId,
      path: SIDE_PANEL_PATH,
      enabled: panelEnabledFor(tabId, ownerTabId, panelOpen),
    })
    .catch(() => {
      // The tab can be gone by now (closed mid-flight); nothing to scope.
    });
}

/** Re-apply the rule across every open tab. */
async function scopeAllTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((t) => (t.id === undefined ? undefined : scopeTab(t.id))));
}

/**
 * Open the panel in one tab.
 *
 * `sidePanel.open()` is called *first and unawaited* — it must run inside the
 * user-gesture task, and putting any `await` in front of it (as an earlier
 * version did, to set options first) loses the gesture and makes the click do
 * nothing at all. Everything else happens afterwards.
 */
function openPanelForTab(tabId: number): void {
  chrome.sidePanel.open({ tabId }).then(
    () => {
      ownerTabId = tabId;
      panelOpen = true;
      void scopeAllTabs();
      // The panel may still be booting; a failed send is harmless, because a
      // freshly mounted panel focuses its input anyway.
      void chrome.runtime.sendMessage({ type: "panel/open" }).catch(() => {});
    },
    (err: unknown) => {
      // Never swallow this: a silent failure here is indistinguishable from a
      // dead toolbar icon, which is exactly how it was reported.
      console.error("sherpa: could not open the side panel", err);
    },
  );
}

/** The tab the user is actually looking at, in the window they're using. */
async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id;
}

/**
 * Opening the panel is handled here rather than by `openPanelOnActionClick`,
 * because Chrome's built-in behaviour opens the *global* panel and gives no
 * hook to record which tab asked for it.
 */
chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  openPanelForTab(tab.id);
});

/**
 * The panel connects this port while it is mounted, which is the only way the
 * worker can tell whether it is actually open — there is no query API. When it
 * disconnects (the user closed it), every tab becomes eligible again so the
 * next click works wherever they are.
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PANEL_PORT) return;
  panelOpen = true;
  port.onDisconnect.addListener(() => {
    panelOpen = false;
    ownerTabId = null;
    void scopeAllTabs();
  });
});

/** Switching tabs: hide the panel outside its owner, without disabling clicks. */
chrome.tabs.onActivated.addListener(({ tabId }) => {
  void scopeTab(tabId);
});

/** A tab that never asked for Sherpa should not inherit an open panel. */
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id === undefined) return;
  void scopeTab(tab.id);
});

/** The owner going away releases the panel, rather than stranding it. */
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== ownerTabId) return;
  ownerTabId = null;
  panelOpen = false;
  void scopeAllTabs();
});

/**
 * Baseline: the built-in open-on-click is off (it would open the global panel),
 * and the global default is *enabled* so `open()` always has a panel to open.
 * Confinement comes from disabling other tabs once one is open, never from
 * disabling the default.
 */
function resetPanelScope(): void {
  ownerTabId = null;
  panelOpen = false;
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  void chrome.sidePanel.setOptions({ path: SIDE_PANEL_PATH, enabled: true });
  void scopeAllTabs();
}

chrome.runtime.onInstalled.addListener((details) => {
  resetPanelScope();
  // Alarms don't survive an extension update, so re-register on every install
  // *and* update, not just the first run.
  ensureAlarms();
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
  resetPanelScope();
  ensureAlarms();
  void ensureOffscreen();
});

/** Keyboard shortcut → open the panel in the active tab (PRD 5.9.2). */
chrome.commands.onCommand.addListener((command) => {
  if (command !== "open-sherpa") return;
  void activeTabId().then((tabId) => {
    if (tabId !== undefined) openPanelForTab(tabId);
  });
});

/* ---------------------------------------------------------------- *
 * Scheduled auto-refresh (5.6.6)
 * ---------------------------------------------------------------- */

/**
 * Register the recurring due-check. Idempotent, and re-registered on both
 * install and startup because alarms do not survive an extension update.
 *
 * The period is the *check* interval, not the cadence — see the note in
 * autoRefresh.ts on why a single 30-day alarm silently skips cycles on any
 * machine that sleeps.
 */
function ensureAlarms(): void {
  void chrome.alarms.create(AUTO_REFRESH_ALARM, {
    periodInMinutes: AUTO_REFRESH_CHECK_MINUTES,
    delayInMinutes: 1,
  });
  chrome.idle.setDetectionInterval(IDLE_THRESHOLD_SECONDS);
}

/** Is the machine free enough to crawl on it? */
async function userIsAway(): Promise<boolean> {
  const state = await chrome.idle.queryState(IDLE_THRESHOLD_SECONDS);
  return state === "idle" || state === "locked";
}

/**
 * Run at most one scheduled refresh.
 *
 * "At most one" is deliberate: the crawl controller runs a single crawl at a
 * time, so dispatching every due index would have all but one silently lose.
 * The due list is walked in most-overdue-first order and the first index we can
 * actually crawl wins — which also means an index whose host permission was
 * revoked is recorded and stepped over, instead of permanently holding the top
 * slot and starving the rest.
 */
async function runDueRefresh(): Promise<void> {
  const { autoRefreshDays } = await loadSettings();
  if (autoRefreshDays === null) return;

  // Never crawl on a machine someone is using. Deferring is cheap; the retry
  // alarm brings us back in half an hour rather than in six hours.
  if (!(await userIsAway())) {
    void chrome.alarms.create(AUTO_REFRESH_RETRY_ALARM, {
      delayInMinutes: AUTO_REFRESH_RETRY_MINUTES,
    });
    return;
  }

  const db = await openSherpaDb();
  try {
    const due = dueForRefresh(await indexRepo.list(db), autoRefreshDays, Date.now());
    for (const meta of due) {
      // A background job has no user gesture, so it cannot prompt for host
      // access it no longer has. Record why it stood down and move on.
      if (!(await hasHostPermission(meta.root))) {
        if (!meta.autoRefreshBlocked) {
          await indexRepo.upsert(db, { ...meta, autoRefreshBlocked: true });
        }
        continue;
      }
      if (meta.autoRefreshBlocked) {
        await indexRepo.upsert(db, { ...meta, autoRefreshBlocked: false });
      }
      await ensureOffscreen();
      await chrome.runtime.sendMessage({
        type: "crawl/recrawl",
        indexId: meta.id,
        background: true,
      });
      return; // one per tick
    }
  } finally {
    // Held only for the length of this check: a lingering connection blocks
    // "Delete everything", which cannot complete while any context has the
    // database open (5.10.6).
    await closeSherpaDb();
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AUTO_REFRESH_ALARM && alarm.name !== AUTO_REFRESH_RETRY_ALARM) return;
  void runDueRefresh().catch((err: unknown) => {
    console.error("sherpa: scheduled refresh failed", err);
  });
});

/**
 * Hand the machine back the instant the user returns, and pick the work up
 * again when they leave. Both messages are no-ops unless the crawl in flight is
 * a scheduled one, so a crawl the user started is never paused under them.
 */
chrome.idle.onStateChanged.addListener((state) => {
  if (state === "active") {
    void chrome.runtime.sendMessage({ type: "crawl/yield" }).catch(() => {});
    return;
  }
  // Idle again: resume anything we yielded, then see if something else is due.
  void chrome.runtime.sendMessage({ type: "crawl/unyield" }).catch(() => {});
  void runDueRefresh().catch(() => {});
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
    case "index/import":
      ensureOffscreen().then(() => sendResponse({ ok: true }));
      return true; // async response

    /**
     * The offscreen document can only use chrome.runtime, so the SPA render
     * fallback (PRD 5.2.11) has to borrow the worker's tabs access.
     */
    case "render/page":
      renderPageInTab(msg.url).then((html) => sendResponse({ html }));
      return true;
    default:
      return false;
  }
});
