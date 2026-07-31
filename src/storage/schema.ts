/**
 * IndexedDB schema (PRD 5.5). One database, six object stores. The DB version
 * carries the migration path (5.5.9); bump it and extend `migrate` in db.ts.
 */

import type { DBSchema } from "idb";
import type { IndexMeta, StoredChunk, StoredPage } from "@/domain/records.js";

export const DB_NAME = "sherpa";
export const DB_VERSION = 3;

/**
 * The crawl in flight, persisted so it survives the offscreen document being
 * torn down or the whole browser restarting (PRD 5.2.2). The frontier holds the
 * queue; this holds which index that queue belongs to.
 */
export interface ActiveCrawl {
  readonly indexId: string;
  readonly incremental: boolean;
  /** True when the user paused, or an auth wall stopped us. */
  readonly paused: boolean;
  readonly startedAt: number;
}

/** Vectors are stored as sharded ArrayBuffer blobs, not one row per vector
 * (5.5.2). ~5k vectors per shard keeps per-read cost flat at 15k+ chunks. */
export const SHARD_VECTORS = 5_000;

/** A contiguous block of float32 embeddings for one index. */
export interface VectorShard {
  readonly indexId: string;
  readonly shard: number;
  readonly dim: number;
  readonly count: number;
  /** count * dim little-endian float32 values. */
  readonly data: ArrayBuffer;
}

/** Serialised BM25 inverted index for one site (5.5.4). Built in milestone #5. */
export interface Bm25Blob {
  readonly indexId: string;
  readonly data: ArrayBuffer;
}

/** One logged query, for the content-gap report (PRD 5.11.1). */
export interface QueryLogEntry {
  readonly id?: number; // autoIncrement key
  readonly indexId: string;
  readonly query: string;
  readonly topScore: number;
  readonly answered: boolean;
  readonly feedback?: "up" | "down";
  readonly at: number;
}

/** One URL in the resumable crawl frontier (PRD 5.2.2). */
export type FrontierStatus = "queued" | "done" | "failed" | "skipped";
export interface FrontierEntry {
  readonly indexId: string;
  readonly url: string;
  readonly depth: number;
  readonly status: FrontierStatus;
}

export interface SherpaDB extends DBSchema {
  indexRegistry: { key: string; value: IndexMeta };
  frontier: {
    key: [string, string];
    value: FrontierEntry;
    indexes: { byStatus: [string, FrontierStatus] };
  };
  pages: {
    key: [string, string];
    value: StoredPage;
    /** `byHash` backs content-hash dedupe — help sites serve the same article
     * on many URLs (PRD 5.2.7). */
    indexes: { byIndex: string; byHash: [string, string] };
  };
  chunks: {
    key: [string, number];
    value: StoredChunk;
    /** `byUrl` makes neighbour expansion (5.7.5) a keyed range read instead of
     * a scan over every chunk in the index. */
    indexes: { byIndex: string; byUrl: [string, string] };
  };
  vectors: { key: [string, number]; value: VectorShard };
  bm25: { key: string; value: Bm25Blob };
  meta: { key: string; value: { key: string; value: unknown } };
  queryLog: { key: number; value: QueryLogEntry; indexes: { byIndex: string } };
}
