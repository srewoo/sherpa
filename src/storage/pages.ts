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
};
