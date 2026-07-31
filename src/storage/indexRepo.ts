/**
 * Index registry repository (PRD 5.6.1). Owns the site list shown in Index
 * Management and the cascade delete that reclaims storage (5.6.3).
 */

import type { IndexMeta } from "@/domain/records.js";
import type { SherpaDatabase } from "./db.js";

const STR_MAX = "￿";
const NUM_MAX = Number.MAX_SAFE_INTEGER;

export const indexRepo = {
  /** Newest-indexed first, for the management table. */
  async list(db: SherpaDatabase): Promise<IndexMeta[]> {
    const all = await db.getAll("indexRegistry");
    return all.sort((a, b) => b.lastIndexedAt - a.lastIndexedAt);
  },

  get(db: SherpaDatabase, id: string): Promise<IndexMeta | undefined> {
    return db.get("indexRegistry", id);
  },

  async upsert(db: SherpaDatabase, meta: IndexMeta): Promise<void> {
    await db.put("indexRegistry", meta);
  },

  /**
   * Drop everything an index has crawled — pages, chunks, vectors, sparse
   * index and its frontier — while keeping the registry entry. Backs the full
   * re-crawl (PRD 5.6.4), which reuses the same index id.
   */
  async clearContent(db: SherpaDatabase, id: string): Promise<void> {
    const tx = db.transaction(["pages", "chunks", "vectors", "bm25", "frontier"], "readwrite");
    await tx.objectStore("pages").delete(IDBKeyRange.bound([id], [id, STR_MAX]));
    await tx.objectStore("chunks").delete(IDBKeyRange.bound([id, 0], [id, NUM_MAX]));
    await tx.objectStore("vectors").delete(IDBKeyRange.bound([id, 0], [id, NUM_MAX]));
    await tx.objectStore("bm25").delete(id);
    await tx.objectStore("frontier").delete(IDBKeyRange.bound([id], [id, STR_MAX]));
    await tx.done;
  },

  /**
   * Delete an index and every row it owns across all stores in one
   * transaction, so a half-deleted index can never survive a crash.
   */
  async delete(db: SherpaDatabase, id: string): Promise<void> {
    const tx = db.transaction(
      ["indexRegistry", "pages", "chunks", "vectors", "bm25", "frontier", "queryLog"],
      "readwrite",
    );
    await tx.objectStore("pages").delete(IDBKeyRange.bound([id], [id, STR_MAX]));
    await tx.objectStore("chunks").delete(IDBKeyRange.bound([id, 0], [id, NUM_MAX]));
    await tx.objectStore("vectors").delete(IDBKeyRange.bound([id, 0], [id, NUM_MAX]));
    await tx.objectStore("bm25").delete(id);
    await tx.objectStore("frontier").delete(IDBKeyRange.bound([id], [id, STR_MAX]));

    // The query log is keyed by an autoincrement id, so it needs a cursor walk
    // rather than a range delete.
    const log = tx.objectStore("queryLog").index("byIndex");
    for (const entry of await log.getAll(id)) {
      if (entry.id !== undefined) await tx.objectStore("queryLog").delete(entry.id);
    }

    await tx.objectStore("indexRegistry").delete(id);
    await tx.done;
  },
};
