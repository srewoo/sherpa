/**
 * Database open + migration (PRD 5.5.9). All schema creation lives in
 * `migrate`, switched on the previous version so upgrades are additive and
 * ordered.
 */

import { openDB, type IDBPDatabase } from "idb";
import { DB_NAME, DB_VERSION, type SherpaDB } from "./schema.js";

export type SherpaDatabase = IDBPDatabase<SherpaDB>;

function migrate(db: IDBPDatabase<SherpaDB>, oldVersion: number): void {
  if (oldVersion < 1) {
    db.createObjectStore("indexRegistry", { keyPath: "id" });

    const frontier = db.createObjectStore("frontier", { keyPath: ["indexId", "url"] });
    frontier.createIndex("byStatus", ["indexId", "status"]);

    const pages = db.createObjectStore("pages", { keyPath: ["indexId", "url"] });
    pages.createIndex("byIndex", "indexId");

    const chunks = db.createObjectStore("chunks", {
      keyPath: ["indexId", "vectorId"],
    });
    chunks.createIndex("byIndex", "indexId");

    db.createObjectStore("vectors", { keyPath: ["indexId", "shard"] });
    db.createObjectStore("bm25", { keyPath: "indexId" });
    db.createObjectStore("meta", { keyPath: "key" });
  }
  if (oldVersion < 2) {
    // Query log for the content-gap report (PRD 5.11).
    const log = db.createObjectStore("queryLog", { keyPath: "id", autoIncrement: true });
    log.createIndex("byIndex", "indexId");
  }
}

/** Open (and migrate) the Sherpa database. */
export function openSherpaDb(name = DB_NAME): Promise<SherpaDatabase> {
  return openDB<SherpaDB>(name, DB_VERSION, {
    upgrade(db, oldVersion) {
      migrate(db, oldVersion);
    },
  });
}
