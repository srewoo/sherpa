/**
 * Small key/value repository over the `meta` store. Holds the crawl-resume
 * pointer (PRD 5.2.2): the frontier already persists *what* is left to fetch,
 * this records *which* crawl that frontier belongs to so a new offscreen
 * document — after a pause, a crash, or a browser restart — can pick it up.
 */

import type { ActiveCrawl } from "./schema.js";
import type { SherpaDatabase } from "./db.js";

const ACTIVE_CRAWL = "activeCrawl";

export const metaRepo = {
  async get<T>(db: SherpaDatabase, key: string): Promise<T | undefined> {
    const row = await db.get("meta", key);
    return row?.value as T | undefined;
  },

  async set(db: SherpaDatabase, key: string, value: unknown): Promise<void> {
    await db.put("meta", { key, value });
  },

  async remove(db: SherpaDatabase, key: string): Promise<void> {
    await db.delete("meta", key);
  },

  activeCrawl(db: SherpaDatabase): Promise<ActiveCrawl | undefined> {
    return this.get<ActiveCrawl>(db, ACTIVE_CRAWL);
  },

  setActiveCrawl(db: SherpaDatabase, crawl: ActiveCrawl): Promise<void> {
    return this.set(db, ACTIVE_CRAWL, crawl);
  },

  clearActiveCrawl(db: SherpaDatabase): Promise<void> {
    return this.remove(db, ACTIVE_CRAWL);
  },
};
