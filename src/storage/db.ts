/**
 * Database open + migration (PRD 5.5.9). All schema creation lives in
 * `migrate`, switched on the previous version so upgrades are additive and
 * ordered.
 */

import { openDB, type IDBPDatabase, type IDBPTransaction, type StoreNames } from "idb";
import { DB_NAME, DB_VERSION, type SherpaDB } from "./schema.js";

export type SherpaDatabase = IDBPDatabase<SherpaDB>;

/** The transaction handed to `upgrade` — the only place existing stores can
 * gain new indexes. */
type UpgradeTx = IDBPTransaction<SherpaDB, StoreNames<SherpaDB>[], "versionchange">;

function migrate(db: IDBPDatabase<SherpaDB>, oldVersion: number, transaction: UpgradeTx): void {
  if (oldVersion < 1) {
    db.createObjectStore("indexRegistry", { keyPath: "id" });

    const frontier = db.createObjectStore("frontier", { keyPath: ["indexId", "url"] });
    frontier.createIndex("byStatus", ["indexId", "status"]);

    const pages = db.createObjectStore("pages", { keyPath: ["indexId", "url"] });
    pages.createIndex("byIndex", "indexId");
    pages.createIndex("byHash", ["indexId", "htmlHash"]);

    const chunks = db.createObjectStore("chunks", {
      keyPath: ["indexId", "vectorId"],
    });
    chunks.createIndex("byIndex", "indexId");
    chunks.createIndex("byUrl", ["indexId", "url"]);

    db.createObjectStore("vectors", { keyPath: ["indexId", "shard"] });
    db.createObjectStore("bm25", { keyPath: "indexId" });
    db.createObjectStore("meta", { keyPath: "key" });
  }
  if (oldVersion < 2) {
    // Query log for the content-gap report (PRD 5.11).
    const log = db.createObjectStore("queryLog", { keyPath: "id", autoIncrement: true });
    log.createIndex("byIndex", "indexId");
  }
  if (oldVersion < 3) {
    // Content-hash dedupe (PRD 5.2.7) needs a lookup by (indexId, htmlHash);
    // neighbour expansion (5.7.5) reads by page rather than scanning the index.
    // Guarded because a fresh database already got both in the v1 block above.
    const pages = transaction.objectStore("pages");
    if (!pages.indexNames.contains("byHash")) pages.createIndex("byHash", ["indexId", "htmlHash"]);

    const chunks = transaction.objectStore("chunks");
    if (!chunks.indexNames.contains("byUrl")) chunks.createIndex("byUrl", ["indexId", "url"]);
  }
  if (oldVersion < 4) {
    // Chat history (PRD 5.9.9).
    const sessions = db.createObjectStore("chatSessions", { keyPath: "id" });
    sessions.createIndex("byIndex", "indexId");
    sessions.createIndex("byUpdated", "updatedAt");
  }
}

/**
 * One connection per context, reused. Held so it can be closed on demand —
 * `indexedDB.deleteDatabase` blocks indefinitely while any connection is open,
 * which is what made "delete everything" silently do nothing (PRD 5.10.6).
 */
let open: { name: string; db: Promise<SherpaDatabase> } | null = null;

/** Open (and migrate) the Sherpa database. */
export function openSherpaDb(name = DB_NAME): Promise<SherpaDatabase> {
  if (open?.name === name) return open.db;

  const db = openDB<SherpaDB>(name, DB_VERSION, {
    upgrade(database, oldVersion, _newVersion, transaction) {
      migrate(database, oldVersion, transaction);
    },
    terminated() {
      // Connection lost (tab discarded, storage cleared) — drop the cache so
      // the next call reopens rather than handing back a dead handle.
      if (open?.name === name) open = null;
    },
  }).catch((err: unknown) => {
    if (open?.name === name) open = null;
    throw err;
  });

  open = { name, db };
  return db;
}

/** Close this context's connection so the database can be deleted. */
export async function closeSherpaDb(): Promise<void> {
  const current = open;
  open = null;
  if (!current) return;
  await current.db.then((db) => db.close()).catch(() => {});
}
