/**
 * Sharded vector storage (PRD 5.5.2). Embeddings for one index are packed into
 * contiguous float32 shards of SHARD_VECTORS each, appended as the crawl embeds
 * batches, and read back concatenated into a single Float32Array for the
 * brute-force cosine scan (5.7.2). vectorId is the global row index, aligned
 * with StoredChunk.vectorId.
 */

import type { SherpaDatabase } from "./db.js";
import { SHARD_VECTORS, type VectorShard } from "./schema.js";

async function allShards(db: SherpaDatabase, indexId: string): Promise<VectorShard[]> {
  const range = IDBKeyRange.bound([indexId, 0], [indexId, Number.MAX_SAFE_INTEGER]);
  const shards = await db.getAll("vectors", range);
  return shards.sort((a, b) => a.shard - b.shard);
}

export interface LoadedVectors {
  readonly data: Float32Array;
  readonly dim: number;
  readonly count: number;
}

export const vectorStore = {
  /**
   * Append a flat batch of `batch.length / dim` vectors. Fills the tail shard
   * before opening new ones. Returns the vectorId assigned to the first vector
   * in the batch, so the caller can key the matching chunks.
   */
  async append(
    db: SherpaDatabase,
    indexId: string,
    batch: Float32Array,
    dim: number,
  ): Promise<number> {
    if (dim <= 0 || batch.length % dim !== 0) {
      throw new Error(`vector batch length ${batch.length} not a multiple of dim ${dim}`);
    }
    const existing = await allShards(db, indexId);
    const startId = existing.reduce((n, s) => n + s.count, 0);
    const vectors = batch.length / dim;

    const tx = db.transaction("vectors", "readwrite");
    let offset = 0;
    let shardIdx = existing.length;

    const last = existing[existing.length - 1];
    if (last && last.count < SHARD_VECTORS) {
      const take = Math.min(SHARD_VECTORS - last.count, vectors);
      const merged = new Float32Array(last.count * dim + take * dim);
      merged.set(new Float32Array(last.data));
      merged.set(batch.subarray(0, take * dim), last.count * dim);
      await tx.store.put({
        indexId,
        shard: last.shard,
        dim,
        count: last.count + take,
        data: merged.buffer,
      });
      offset = take;
      shardIdx = last.shard + 1;
    }

    while (offset < vectors) {
      const take = Math.min(SHARD_VECTORS, vectors - offset);
      const slice = batch.slice(offset * dim, (offset + take) * dim);
      await tx.store.put({ indexId, shard: shardIdx, dim, count: take, data: slice.buffer });
      offset += take;
      shardIdx += 1;
    }
    await tx.done;
    return startId;
  },

  /** Concatenate every shard into one Float32Array (5.7.3: load once/session). */
  async load(db: SherpaDatabase, indexId: string): Promise<LoadedVectors> {
    const shards = await allShards(db, indexId);
    const dim = shards[0]?.dim ?? 0;
    const count = shards.reduce((n, s) => n + s.count, 0);
    const data = new Float32Array(count * dim);
    let o = 0;
    for (const s of shards) {
      data.set(new Float32Array(s.data), o);
      o += s.count * dim;
    }
    return { data, dim, count };
  },

  async count(db: SherpaDatabase, indexId: string): Promise<number> {
    const shards = await allShards(db, indexId);
    return shards.reduce((n, s) => n + s.count, 0);
  },

  async delete(db: SherpaDatabase, indexId: string): Promise<void> {
    const range = IDBKeyRange.bound([indexId, 0], [indexId, Number.MAX_SAFE_INTEGER]);
    await db.delete("vectors", range);
  },
};
