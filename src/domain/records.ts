/**
 * Persisted record shapes (PRD 5.5). These are the on-disk contracts for the
 * IndexedDB object stores; the schema version guards migrations (PRD 5.5.9).
 */

import type { CrawlConfig } from "./config.js";

export const SCHEMA_VERSION = 2;

/** Registry entry for one indexed site (PRD 5.6.1). */
export interface IndexMeta {
  readonly id: string;
  readonly root: string;
  readonly host: string;
  readonly title: string;
  readonly pageCount: number;
  readonly chunkCount: number;
  readonly sizeBytes: number;
  readonly createdAt: number;
  readonly lastIndexedAt: number;
  readonly schemaVersion: number;
  /** The crawl config, retained so a recrawl (5.6.4/5.6.5) can reuse it. */
  readonly config: CrawlConfig;
}

/** One crawled page's metadata (PRD 5.3.6). Body lives in its chunks. */
export interface StoredPage {
  readonly indexId: string;
  readonly url: string;
  readonly htmlHash: string;
  readonly etag: string | undefined;
  readonly lastmod: string | undefined;
  readonly title: string;
  readonly breadcrumb: readonly string[];
  readonly fetchedAt: number;
}

/**
 * One chunk, keyed by its position in the vector store (PRD 5.5.3). `vectorId`
 * is the row index into the sharded vector blobs, so text and vector stay
 * aligned without duplicating the embedding into this record.
 */
export interface StoredChunk {
  readonly indexId: string;
  readonly vectorId: number;
  readonly text: string;
  readonly body: string;
  readonly url: string;
  readonly anchor: string | undefined;
  readonly headingPath: string;
  readonly position: number;
  readonly title: string;
  readonly contentHash: string;
}
