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
   * Delete an index and every row it owns across all stores in one
   * transaction, so a half-deleted index can never survive a crash.
   */
  async delete(db: SherpaDatabase, id: string): Promise<void> {
    const tx = db.transaction(
      ["indexRegistry", "pages", "chunks", "vectors", "bm25"],
      "readwrite",
    );
    await tx.objectStore("pages").delete(IDBKeyRange.bound([id], [id, STR_MAX]));
    await tx.objectStore("chunks").delete(IDBKeyRange.bound([id, 0], [id, NUM_MAX]));
    await tx.objectStore("vectors").delete(IDBKeyRange.bound([id, 0], [id, NUM_MAX]));
    await tx.objectStore("bm25").delete(id);
    await tx.objectStore("indexRegistry").delete(id);
    await tx.done;
  },
};
