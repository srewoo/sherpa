/**
 * Frontier repository (PRD 5.2.2). The crawl queue persisted to IndexedDB so a
 * crawl resumes after a browser restart or crash. Dedupe is by canonical URL
 * (the store's key), so re-seeding is idempotent.
 */

import type { SherpaDatabase } from "@/storage/db.js";
import {
  failureReason,
  isRetryable,
  type FailureReason,
  type FrontierEntry,
  type FrontierStatus,
} from "@/storage/schema.js";

export interface Counts {
  readonly queued: number;
  readonly done: number;
  readonly failed: number;
  readonly skipped: number;
}

export const frontier = {
  /** Enqueue a URL as `queued` unless it's already known (any status). */
  async enqueue(db: SherpaDatabase, indexId: string, url: string, depth: number): Promise<boolean> {
    const existing = await db.get("frontier", [indexId, url]);
    if (existing) return false;
    await db.put("frontier", { indexId, url, depth, status: "queued" });
    return true;
  },

  /** Batch seed; returns the count actually added. */
  async seed(
    db: SherpaDatabase,
    indexId: string,
    urls: readonly { url: string; depth: number }[],
  ): Promise<number> {
    let added = 0;
    for (const { url, depth } of urls) {
      if (await this.enqueue(db, indexId, url, depth)) added += 1;
    }
    return added;
  },

  /** Up to `limit` queued entries, for the next wave of fetches. */
  nextQueued(db: SherpaDatabase, indexId: string, limit: number) {
    return db.getAllFromIndex(
      "frontier",
      "byStatus",
      IDBKeyRange.only([indexId, "queued"]),
      limit,
    );
  },

  async mark(
    db: SherpaDatabase,
    indexId: string,
    url: string,
    status: FrontierStatus,
    detail?: { lastStatus?: number; reason?: FailureReason },
  ): Promise<void> {
    const entry = await db.get("frontier", [indexId, url]);
    if (!entry) return;
    await db.put("frontier", {
      ...entry,
      status,
      attempts: (entry.attempts ?? 0) + 1,
      ...(detail
        ? {
            ...(detail.lastStatus === undefined ? {} : { lastStatus: detail.lastStatus }),
            reason:
              detail.reason ??
              (detail.lastStatus === undefined ? "other" : failureReason(detail.lastStatus)),
          }
        : {}),
    });
  },

  /** Every URL that failed, for the exportable failure log (PRD 5.2.10). */
  async failures(db: SherpaDatabase, indexId: string): Promise<FrontierEntry[]> {
    const range = IDBKeyRange.only([indexId, "failed" as FrontierStatus]);
    return db.getAllFromIndex("frontier", "byStatus", range);
  },

  /**
   * Requeue transient failures for one more pass (PRD 5.2.5). A 500 or a
   * dropped connection midway through a long crawl usually succeeds on a second
   * attempt; a 404 never will, so those stay failed. Returns how many were
   * requeued.
   */
  async requeueRetryable(db: SherpaDatabase, indexId: string, maxAttempts = 2): Promise<number> {
    const tx = db.transaction("frontier", "readwrite");
    const range = IDBKeyRange.only([indexId, "failed" as FrontierStatus]);
    let requeued = 0;
    for (const entry of await tx.store.index("byStatus").getAll(range)) {
      if (!isRetryable(entry.reason)) continue;
      if ((entry.attempts ?? 0) >= maxAttempts) continue;
      await tx.store.put({ ...entry, status: "queued" });
      requeued += 1;
    }
    await tx.done;
    return requeued;
  },

  /** Reset every entry to `queued` so a recrawl revisits all known URLs (5.6.5). */
  async requeueAll(db: SherpaDatabase, indexId: string): Promise<void> {
    const range = IDBKeyRange.bound([indexId, ""], [indexId, "￿"]);
    const tx = db.transaction("frontier", "readwrite");
    for (const entry of await tx.store.index("byStatus").getAll(range)) {
      await tx.store.put({ ...entry, status: "queued" });
    }
    await tx.done;
  },

  async counts(db: SherpaDatabase, indexId: string): Promise<Counts> {
    const one = (s: FrontierStatus) =>
      db.countFromIndex("frontier", "byStatus", IDBKeyRange.only([indexId, s]));
    const [queued, done, failed, skipped] = await Promise.all([
      one("queued"),
      one("done"),
      one("failed"),
      one("skipped"),
    ]);
    return { queued, done, failed, skipped };
  },
};
