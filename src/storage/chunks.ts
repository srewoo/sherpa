/**
 * Chunk repository (PRD 5.5.3). Chunk text + metadata keyed by vectorId, so a
 * cosine hit at row N resolves to its chunk in one get. Neighbour expansion
 * (5.7.5) pulls the adjacent chunks of the same page.
 */

import type { StoredChunk } from "@/domain/records.js";
import type { SherpaDatabase } from "./db.js";

export const chunkStore = {
  async putBatch(db: SherpaDatabase, chunks: readonly StoredChunk[]): Promise<void> {
    const tx = db.transaction("chunks", "readwrite");
    for (const c of chunks) await tx.store.put(c);
    await tx.done;
  },

  get(db: SherpaDatabase, indexId: string, vectorId: number): Promise<StoredChunk | undefined> {
    return db.get("chunks", [indexId, vectorId]);
  },

  async getMany(
    db: SherpaDatabase,
    indexId: string,
    vectorIds: readonly number[],
  ): Promise<StoredChunk[]> {
    const tx = db.transaction("chunks", "readonly");
    const rows = await Promise.all(vectorIds.map((id) => tx.store.get([indexId, id])));
    await tx.done;
    return rows.filter((r): r is StoredChunk => r !== undefined);
  },

  countByIndex(db: SherpaDatabase, indexId: string): Promise<number> {
    return db.countFromIndex("chunks", "byIndex", indexId);
  },

  listByIndex(db: SherpaDatabase, indexId: string): Promise<StoredChunk[]> {
    return db.getAllFromIndex("chunks", "byIndex", indexId);
  },

  /** Approximate stored size of this index's chunk text (PRD 5.6.1). UTF-16 in
   * memory, but IndexedDB stores UTF-8, so one byte per char is the honest
   * lower bound for mostly-ASCII documentation. */
  async byteSize(db: SherpaDatabase, indexId: string): Promise<number> {
    const chunks = await this.listByIndex(db, indexId);
    return chunks.reduce((n, c) => n + c.text.length + c.body.length + c.url.length + c.headingPath.length, 0);
  },

  /** Remove all chunks of one page (its vectors are left orphaned but resolve
   * to nothing, so retrieval skips them). Used by incremental recrawl (5.6.5). */
  async deleteByUrl(db: SherpaDatabase, indexId: string, url: string): Promise<void> {
    const tx = db.transaction("chunks", "readwrite");
    const range = IDBKeyRange.only([indexId, url]);
    for (const c of await tx.store.index("byUrl").getAll(range)) {
      await tx.store.delete([indexId, c.vectorId]);
    }
    await tx.done;
  },

  /** Every chunk of one page, in document order. */
  async listByUrl(db: SherpaDatabase, indexId: string, url: string): Promise<StoredChunk[]> {
    const rows = await db.getAllFromIndex("chunks", "byUrl", IDBKeyRange.only([indexId, url]));
    return rows.sort((a, b) => a.position - b.position);
  },

  /**
   * Chunks of the same page immediately before/after `chunk`, matched by URL
   * and position — so a retrieved procedure isn't truncated mid-steps.
   */
  async neighbours(
    db: SherpaDatabase,
    chunk: StoredChunk,
    span = 1,
  ): Promise<StoredChunk[]> {
    const wanted = new Set<number>();
    for (let d = 1; d <= span; d++) {
      wanted.add(chunk.position - d);
      wanted.add(chunk.position + d);
    }
    const same = await this.listByUrl(db, chunk.indexId, chunk.url);
    return same.filter((c) => wanted.has(c.position));
  },
};
