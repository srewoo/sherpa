/**
 * Per-session retrieval cache (PRD 5.7.3, 5.7.6).
 *
 * Without this, every query re-read all vector shards, re-read every chunk row,
 * and rebuilt the BM25 index from scratch — which is what put the 150 ms p95
 * budget out of reach at 15k chunks. Vectors, chunk metadata and the sparse
 * index are loaded once per index and reused for the life of the offscreen
 * document, then invalidated when a crawl changes the index.
 */

import type { StoredChunk } from "@/domain/records.js";
import type { SherpaDatabase } from "@/storage/db.js";
import { vectorStore, type LoadedVectors } from "@/storage/vectors.js";
import { chunkStore } from "@/storage/chunks.js";
import { bm25Store } from "@/storage/bm25Store.js";
import { FieldedBm25Index } from "./fieldedBm25.js";

export interface IndexSession {
  readonly indexId: string;
  readonly vectors: LoadedVectors;
  readonly bm25: FieldedBm25Index;
  /** vectorId → chunk, so a scored row resolves without touching IndexedDB. */
  readonly byId: ReadonlyMap<number, StoredChunk>;
  /** page URL → that page's chunks in order, for neighbour expansion (5.7.5). */
  readonly byUrl: ReadonlyMap<string, readonly StoredChunk[]>;
}

const cache = new Map<string, Promise<IndexSession>>();

async function build(db: SherpaDatabase, indexId: string): Promise<IndexSession> {
  const [vectors, chunks, stored] = await Promise.all([
    vectorStore.load(db, indexId),
    chunkStore.listByIndex(db, indexId),
    bm25Store.load(db, indexId),
  ]);

  const byId = new Map<number, StoredChunk>();
  const byUrl = new Map<string, StoredChunk[]>();
  for (const c of chunks) {
    byId.set(c.vectorId, c);
    const list = byUrl.get(c.url);
    if (list) list.push(c);
    else byUrl.set(c.url, [c]);
  }
  for (const list of byUrl.values()) list.sort((a, b) => a.position - b.position);

  // Fall back to building in memory when the crawl was interrupted before the
  // sparse index was written — correctness first, speed second.
  const bm25 =
    stored ??
    FieldedBm25Index.build(
      chunks.map((c) => ({
        id: c.vectorId,
        title: c.title,
        section: c.headingPath,
        content: c.body,
      })),
    );

  return { indexId, vectors, bm25, byId, byUrl };
}

export function loadSession(db: SherpaDatabase, indexId: string): Promise<IndexSession> {
  let entry = cache.get(indexId);
  if (!entry) {
    entry = build(db, indexId).catch((err: unknown) => {
      // Never cache a rejection — the next query should get a clean attempt.
      cache.delete(indexId);
      throw err;
    });
    cache.set(indexId, entry);
  }
  return entry;
}

/** Drop the cached session — call after a crawl or recrawl mutates the index. */
export function invalidateSession(indexId?: string): void {
  if (indexId === undefined) cache.clear();
  else cache.delete(indexId);
}
