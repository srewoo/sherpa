/**
 * Frontier repository (PRD 5.2.2). The crawl queue persisted to IndexedDB so a
 * crawl resumes after a browser restart or crash. Dedupe is by canonical URL
 * (the store's key), so re-seeding is idempotent.
 */

import type { SherpaDatabase } from "@/storage/db.js";
import type { FrontierStatus } from "@/storage/schema.js";

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
  ): Promise<void> {
    const entry = await db.get("frontier", [indexId, url]);
    if (entry) await db.put("frontier", { ...entry, status });
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
