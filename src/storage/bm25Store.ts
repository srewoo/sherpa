/**
 * Persisted BM25 index (PRD 5.5.4). The sparse half of hybrid retrieval is
 * built once when a crawl finishes and stored as a single blob, so a query
 * loads it rather than re-tokenising every chunk in the index — which is what
 * keeps retrieval inside the 150 ms budget at 15k chunks (5.7.6).
 */

import { Bm25Index, type Bm25Doc, type Bm25Snapshot } from "@/retrieval/bm25.js";
import type { SherpaDatabase } from "./db.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const bm25Store = {
  /** Build from the index's chunks and persist. Called at end of crawl. */
  async build(db: SherpaDatabase, indexId: string, docs: readonly Bm25Doc[]): Promise<Bm25Index> {
    const index = new Bm25Index(docs);
    await this.save(db, indexId, index);
    return index;
  },

  async save(db: SherpaDatabase, indexId: string, index: Bm25Index): Promise<void> {
    const json = JSON.stringify(index.toSnapshot());
    // Copy into a standalone ArrayBuffer — a TextEncoder view may be a slice of
    // a larger pooled buffer, which IndexedDB would store in full.
    const bytes = encoder.encode(json);
    const data = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(data).set(bytes);
    await db.put("bm25", { indexId, data });
  },

  /** Load the stored index, or undefined when the crawl never finished. */
  async load(db: SherpaDatabase, indexId: string): Promise<Bm25Index | undefined> {
    const row = await db.get("bm25", indexId);
    if (!row) return undefined;
    try {
      const snapshot = JSON.parse(decoder.decode(new Uint8Array(row.data))) as Bm25Snapshot;
      return Bm25Index.fromSnapshot(snapshot);
    } catch {
      // A corrupt blob must not break search — the caller rebuilds in memory.
      return undefined;
    }
  },
};
