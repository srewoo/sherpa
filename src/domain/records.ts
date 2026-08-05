/**
 * Persisted record shapes (PRD 5.5). These are the on-disk contracts for the
 * IndexedDB object stores; the schema version guards migrations (PRD 5.5.9).
 */

import type { CrawlConfig } from "./config.js";
import type { RefusalReason } from "@/generator/answerService.js";
import type { Calibration } from "@/retrieval/calibrate.js";

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
  /**
   * The embedding model this index was built with. Vectors from different
   * models are not comparable, so querying an index built by another model
   * returns nonsense; retrieval checks this and asks for a rebuild instead.
   */
  readonly embeddingModel?: string;
  /**
   * Refusal bands measured against *this* corpus at the end of its crawl.
   *
   * A cosine threshold is a property of the model and the corpus together, not
   * of the product. The shipped constant (0.45) sat below the lowest score any
   * unanswerable question produced on three real help centres, so the refusal
   * path could never fire — and no single replacement worked, because the same
   * sweep wanted 0.75 for one site and 0.80 for another. Measured per index,
   * beside the model that measured it. See `retrieval/calibrate.ts`.
   *
   * Absent on every index built before this existed; those fall back to
   * Settings, unchanged.
   */
  readonly floors?: Calibration;
  /**
   * Rescore this index's top results with the cross-encoder.
   *
   * Per index, not global, because it was measured helping and hurting on the
   * same day: +45 points hit@1 on a help centre built from near-synonymous
   * titles, and **−30 points** on one where first-stage ranking was already
   * good. A single switch is wrong in both positions — off abandons the corpus
   * that needs it, on wrecks the corpus that doesn't.
   *
   * Undefined means "not decided for this index" and falls back to the global
   * setting, so nothing changes for anyone who never opens the toggle.
   */
  readonly rerank?: boolean;
  /**
   * Set when a scheduled refresh could not run because host access for this
   * site is no longer granted. A background job cannot show a permission
   * prompt — only a user gesture can — so it records why it stood down and the
   * Indexes page offers the re-grant, rather than the refresh failing silently
   * and the index ageing forever.
   */
  readonly autoRefreshBlocked?: boolean;
  /** The crawl config, retained so a recrawl (5.6.4/5.6.5) can reuse it. */
  readonly config: CrawlConfig;
}

/**
 * A saved citation, denormalised into the chat history (PRD 5.9.9).
 *
 * Deliberately a copy rather than a chunk reference: a recrawl reassigns vector
 * ids, and a history entry that silently repoints at different text would be
 * worse than no history at all. The URL still deep-links to the live page.
 */
export interface StoredCitation {
  readonly index: number;
  readonly title: string;
  readonly breadcrumb: string;
  readonly snippet: string;
  readonly relevance: number;
  readonly url: string;
  readonly displayUrl: string;
}

/** One question and its answer, as replayed from history. */
export interface StoredTurn {
  readonly question: string;
  /** The answer in markdown; empty when the query was refused. */
  readonly markdown: string;
  readonly tier: "extractive" | "nano" | "byok";
  readonly refused: boolean;
  /**
   * Why it was refused. Optional because conversations saved before this was
   * recorded exist; those restore as "unknown" rather than being given a reason
   * they never had.
   */
  readonly refusalReason?: RefusalReason;
  readonly sources: readonly StoredCitation[];
  readonly at: number;
}

/**
 * A saved conversation (PRD 5.9.9). Scoped to the index it was asked against,
 * so switching sites shows that site's history. Local-only, like everything
 * else — history never leaves the device (5.10.1).
 */
export interface ChatSession {
  readonly id: string;
  readonly indexId: string;
  /** The opening question, used as the list label. */
  readonly title: string;
  readonly turns: readonly StoredTurn[];
  readonly createdAt: number;
  readonly updatedAt: number;
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
