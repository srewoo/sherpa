/**
 * Persisted BM25 index (PRD 5.5.4). The sparse half of hybrid retrieval is
 * built once when a crawl finishes and stored as a single blob, so a query
 * loads it rather than re-tokenising every chunk in the index — which is what
 * keeps retrieval inside the 150 ms budget at 15k chunks (5.7.6).
 *
 * The stored form is field-weighted (title / section / content). Blobs written
 * by an older build hold a single flat index; those are simply treated as
 * absent, and the session rebuilds in memory rather than ranking with a
 * structure the scorer no longer understands.
 */

import { FieldedBm25Index, type FieldedDoc, type FieldedSnapshot } from "@/retrieval/fieldedBm25.js";
import type { SherpaDatabase } from "./db.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const bm25Store = {
  /** Build from the index's chunks and persist. Called at end of crawl. */
  async build(db: SherpaDatabase, indexId: string, docs: readonly FieldedDoc[]): Promise<FieldedBm25Index> {
    const index = FieldedBm25Index.build(docs);
    await this.save(db, indexId, index);
    return index;
  },

  async save(db: SherpaDatabase, indexId: string, index: FieldedBm25Index): Promise<void> {
    const json = JSON.stringify(index.toSnapshot());
    // Copy into a standalone ArrayBuffer — a TextEncoder view may be a slice of
    // a larger pooled buffer, which IndexedDB would store in full.
    const bytes = encoder.encode(json);
    const data = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(data).set(bytes);
    await db.put("bm25", { indexId, data });
  },

  /** Load the stored index, or undefined when absent, corrupt, or older-format. */
  async load(db: SherpaDatabase, indexId: string): Promise<FieldedBm25Index | undefined> {
    const row = await db.get("bm25", indexId);
    if (!row) return undefined;
    try {
      const parsed = JSON.parse(decoder.decode(new Uint8Array(row.data))) as Partial<FieldedSnapshot>;
      // A pre-field snapshot has `postings` at the top level and no `fields`.
      if (!parsed.fields) return undefined;
      return FieldedBm25Index.fromSnapshot(parsed as FieldedSnapshot);
    } catch {
      // A corrupt blob must not break search — the caller rebuilds in memory.
      return undefined;
    }
  },
};
