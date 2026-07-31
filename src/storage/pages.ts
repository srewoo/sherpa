/**
 * Page repository (PRD 5.3.6). Stores per-page metadata used for incremental
 * recrawl (ETag / Last-Modified / html hash, 5.6.5) and the page count shown in
 * index management.
 */

import type { StoredPage } from "@/domain/records.js";
import type { SherpaDatabase } from "./db.js";

export const pageStore = {
  async put(db: SherpaDatabase, page: StoredPage): Promise<void> {
    await db.put("pages", page);
  },

  get(db: SherpaDatabase, indexId: string, url: string): Promise<StoredPage | undefined> {
    return db.get("pages", [indexId, url]);
  },

  countByIndex(db: SherpaDatabase, indexId: string): Promise<number> {
    return db.countFromIndex("pages", "byIndex", indexId);
  },

  listByIndex(db: SherpaDatabase, indexId: string): Promise<StoredPage[]> {
    return db.getAllFromIndex("pages", "byIndex", indexId);
  },

  /**
   * An already-indexed page with identical content under a different URL
   * (PRD 5.2.7). Help sites routinely serve one article at several paths;
   * indexing each copy inflates storage and lets near-duplicate chunks crowd
   * out genuinely different pages in retrieval.
   */
  async findDuplicate(
    db: SherpaDatabase,
    indexId: string,
    htmlHash: string,
    url: string,
  ): Promise<StoredPage | undefined> {
    const matches = await db.getAllFromIndex("pages", "byHash", IDBKeyRange.only([indexId, htmlHash]));
    return matches.find((p) => p.url !== url);
  },
};
