/**
 * Scheduled auto-refresh (PRD 5.6.5 on a timer).
 *
 * Docs drift, and an index nobody refreshes quietly becomes wrong — which is
 * worse than an index that admits it's stale, because the answers still look
 * confident. So Sherpa re-runs the incremental recrawl on a cadence: 30 days by
 * default, changeable, and switchable off.
 *
 * Two things shape the design, both learned from how `chrome.alarms` actually
 * behaves rather than how it reads:
 *
 *  1. **A 30-day alarm is not a 30-day timer.** Alarms don't accumulate while
 *     the browser is closed or the machine is asleep, so a single long-period
 *     alarm silently skips cycles on any laptop that isn't always on. What
 *     survives is a *short* recurring alarm that asks a *persisted* question:
 *     is `now - lastIndexedAt` past the cadence? A week of downtime then
 *     refreshes on the next wake instead of being lost. That question is
 *     `dueForRefresh`, and it's pure so it can be tested without a browser.
 *
 *  2. **One index per tick.** The crawl controller runs a single crawl at a
 *     time; dispatching five due indexes at once would have four silently lose.
 *     The caller takes the most-overdue index it can actually crawl and leaves
 *     the rest for the next tick — at a 6-hour check interval, a handful of
 *     sites still all refresh well inside a 30-day window.
 */

import type { CrawlConfig } from "@/domain/config.js";
import type { IndexMeta } from "@/domain/records.js";

/** Alarm name registered by the service worker. */
export const AUTO_REFRESH_ALARM = "sherpa/auto-refresh";

/**
 * How often we *ask* whether anything is due — deliberately unrelated to the
 * cadence itself (see note 1 above). Six hours keeps the worker wake-ups
 * negligible while bounding how late a refresh can start.
 */
export const AUTO_REFRESH_CHECK_MINUTES = 6 * 60;

/** Cadence shipped on a fresh install. */
export const DEFAULT_AUTO_REFRESH_DAYS = 30;

/** The cadences offered in Settings. `null` disables auto-refresh entirely. */
export const AUTO_REFRESH_CHOICES: readonly { readonly days: number | null; readonly label: string }[] =
  [
    { days: 7, label: "Every 7 days" },
    { days: 14, label: "Every 14 days" },
    { days: 30, label: "Every 30 days" },
    { days: 90, label: "Every 90 days" },
    { days: null, label: "Never — refresh manually" },
  ];

const DAY_MS = 86_400_000;

/** Has this index gone longer than the cadence without being reindexed? */
export function isDue(meta: IndexMeta, cadenceDays: number | null, now: number): boolean {
  if (cadenceDays === null || cadenceDays <= 0) return false;
  // A clock that moved backwards (timezone change, NTP correction) must not
  // make every index look infinitely fresh — or infinitely overdue.
  const age = now - meta.lastIndexedAt;
  return age >= cadenceDays * DAY_MS;
}

/**
 * Every index past its cadence, most overdue first. Order matters: the caller
 * walks this list and takes the first index it can actually crawl, so an index
 * whose host permission was revoked is skipped rather than starving the others
 * by permanently holding the top slot.
 */
export function dueForRefresh(
  indexes: readonly IndexMeta[],
  cadenceDays: number | null,
  now: number,
): IndexMeta[] {
  return indexes
    .filter((meta) => isDue(meta, cadenceDays, now))
    .sort((a, b) => a.lastIndexedAt - b.lastIndexedAt);
}

/** When this index is next due, for the Indexes table. `null` when disabled. */
export function nextRefreshAt(meta: IndexMeta, cadenceDays: number | null): number | null {
  if (cadenceDays === null || cadenceDays <= 0) return null;
  return meta.lastIndexedAt + cadenceDays * DAY_MS;
}

/** One-shot alarm used to retry sooner when a refresh was due but the user was at the keyboard. */
export const AUTO_REFRESH_RETRY_ALARM = "sherpa/auto-refresh-retry";

/** How long to wait before re-checking after deferring to an active user. */
export const AUTO_REFRESH_RETRY_MINUTES = 30;

/**
 * The crawl config a *background* refresh runs under.
 *
 * An unattended refresh must be invisible, and the honest way to buy that is to
 * make it slower rather than to hope it finishes fast: single-flight fetches at
 * half the configured rate. Because embedding is driven by page arrivals, this
 * throttles the CPU-hungry half of the pipeline too — the part that would
 * otherwise spin fans on a laptop nobody asked to be crawling. A refresh the
 * user *did* ask for keeps their configured speed.
 */
export function backgroundConfig(config: CrawlConfig): CrawlConfig {
  return {
    ...config,
    requestsPerSecond: Math.max(0.2, config.requestsPerSecond / 2),
    concurrency: 1,
  };
}
