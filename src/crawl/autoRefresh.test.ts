import { describe, it, expect } from "vitest";
import type { IndexMeta } from "@/domain/records.js";
import { parseCrawlConfig } from "@/domain/config.js";
import {
  isDue,
  dueForRefresh,
  nextRefreshAt,
  backgroundConfig,
  DEFAULT_AUTO_REFRESH_DAYS,
  AUTO_REFRESH_CHOICES,
} from "./autoRefresh.js";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function index(id: string, ageDays: number): IndexMeta {
  return {
    id,
    root: `https://${id}.test/`,
    host: `${id}.test`,
    title: id,
    pageCount: 10,
    chunkCount: 40,
    sizeBytes: 1000,
    createdAt: NOW - ageDays * DAY,
    lastIndexedAt: NOW - ageDays * DAY,
    schemaVersion: 4,
    config: parseCrawlConfig({ root: `https://${id}.test/` }),
  };
}

describe("isDue", () => {
  it("is due once the cadence has elapsed", () => {
    expect(isDue(index("a", 31), 30, NOW)).toBe(true);
  });

  it("is not due before the cadence", () => {
    expect(isDue(index("a", 29), 30, NOW)).toBe(false);
  });

  it("is due exactly on the boundary", () => {
    expect(isDue(index("a", 30), 30, NOW)).toBe(true);
  });

  it("is never due when auto-refresh is disabled", () => {
    expect(isDue(index("a", 400), null, NOW)).toBe(false);
  });

  it("treats a non-positive cadence as disabled rather than refreshing constantly", () => {
    expect(isDue(index("a", 400), 0, NOW)).toBe(false);
    expect(isDue(index("a", 400), -7, NOW)).toBe(false);
  });

  /**
   * The scheduler asks "how old is this?" rather than "has a timer fired?",
   * which is the whole reason a laptop asleep past its cadence still refreshes
   * on the next wake instead of skipping the cycle.
   */
  it("stays due after downtime far longer than the cadence", () => {
    expect(isDue(index("a", 365), 30, NOW)).toBe(true);
  });

  /** A clock correction must not make a fresh index look overdue. */
  it("is not due for an index stamped in the future", () => {
    const future = { ...index("a", 0), lastIndexedAt: NOW + 10 * DAY };
    expect(isDue(future, 30, NOW)).toBe(false);
  });
});

describe("dueForRefresh", () => {
  it("returns only overdue indexes, most overdue first", () => {
    const rows = [index("fresh", 2), index("old", 90), index("due", 31)];
    expect(dueForRefresh(rows, 30, NOW).map((r) => r.id)).toEqual(["old", "due"]);
  });

  it("returns nothing when disabled, however stale the indexes are", () => {
    expect(dueForRefresh([index("old", 900)], null, NOW)).toEqual([]);
  });

  it("returns nothing for an empty registry", () => {
    expect(dueForRefresh([], 30, NOW)).toEqual([]);
  });

  /**
   * Ordering is load-bearing: the caller walks this list and takes the first
   * index it can actually crawl, so a blocked index at the head must not be
   * able to starve the rest — the list has to be a queue, not a single pick.
   */
  it("orders deterministically so a skipped index leaves a usable successor", () => {
    const rows = [index("b", 40), index("a", 60), index("c", 35)];
    expect(dueForRefresh(rows, 30, NOW).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

describe("nextRefreshAt", () => {
  it("is the last index time plus the cadence", () => {
    expect(nextRefreshAt(index("a", 10), 30)).toBe(NOW - 10 * DAY + 30 * DAY);
  });

  it("is null when auto-refresh is off", () => {
    expect(nextRefreshAt(index("a", 10), null)).toBeNull();
  });
});

describe("backgroundConfig", () => {
  const base = parseCrawlConfig({
    root: "https://docs.test/",
    requestsPerSecond: 2,
    concurrency: 4,
  });

  it("halves the request rate and drops to single-flight", () => {
    const bg = backgroundConfig(base);
    expect(bg.requestsPerSecond).toBe(1);
    expect(bg.concurrency).toBe(1);
  });

  it("keeps the rate positive so the pacer can never divide by zero", () => {
    const slow = { ...base, requestsPerSecond: 0.2 };
    expect(backgroundConfig(slow).requestsPerSecond).toBeGreaterThan(0);
  });

  it("leaves scope and caps untouched — only pacing changes", () => {
    const bg = backgroundConfig(base);
    expect(bg.root).toBe(base.root);
    expect(bg.maxPages).toBe(base.maxPages);
    expect(bg.maxDepth).toBe(base.maxDepth);
    expect(bg.scope).toEqual(base.scope);
  });
});

describe("cadence choices", () => {
  it("offers the default cadence and a way to turn it off", () => {
    expect(AUTO_REFRESH_CHOICES.some((c) => c.days === DEFAULT_AUTO_REFRESH_DAYS)).toBe(true);
    expect(AUTO_REFRESH_CHOICES.some((c) => c.days === null)).toBe(true);
  });
});
