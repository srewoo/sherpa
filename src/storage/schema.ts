/**
 * IndexedDB schema (PRD 5.5). One database, six object stores. The DB version
 * carries the migration path (5.5.9); bump it and extend `migrate` in db.ts.
 */

import type { DBSchema } from "idb";
import type { ChatSession, IndexMeta, StoredChunk, StoredPage } from "@/domain/records.js";

export const DB_NAME = "sherpa";
export const DB_VERSION = 4;

/**
 * How many conversations to keep (PRD 5.9.9). Old sessions are evicted oldest
 * first, so history stays useful without growing without bound next to the
 * index it belongs to.
 */
export const MAX_CHAT_SESSIONS = 50;

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
  /**
   * A scheduled refresh rather than a user-initiated crawl. Persisted so a
   * crawl resumed after a browser restart is still known to be background work
   * — otherwise it would come back at full speed and stop yielding.
   */
  readonly background?: boolean;
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
  /**
   * What actually happened. `answered` is kept for records written before this
   * field existed — `gap.ts` still reads it, and back-filling would mean a
   * migration over a log whose whole purpose is to be cheap.
   */
  readonly outcome?: "answered" | "refused" | "refined";
  /**
   * The page the user chose from a refinement chip. A relevance label, produced
   * by ordinary use and never leaving the machine (retrieval/prior.ts).
   */
  readonly pickedUrl?: string;
  /**
   * The question the pick actually answered.
   *
   * Load-bearing, and easy to get wrong: `query` on a pick turn is the chip's
   * *label* — a page title. Learning "Zoom Phone" → the Zoom Phone page teaches
   * nothing, because a title trivially matches its own page. The label worth
   * binding to that URL is the question the user originally typed, which is the
   * wording the next person will use too.
   */
  readonly pickedFor?: string;
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
  /** HTTP status of the last attempt; 0 for a network-level failure. */
  readonly lastStatus?: number;
  /** Reason code for the failure log (PRD 5.2.10). */
  readonly reason?: FailureReason;
  /** Fetch attempts so far, so a retry sweep doesn't loop forever. */
  readonly attempts?: number;
}

/**
 * Why a URL failed, in terms a user can act on (PRD 5.2.10). `server` and
 * `network` are worth retrying at the end of a crawl; `missing` and `forbidden`
 * are not — the page is genuinely gone or genuinely gated.
 */
export type FailureReason =
  | "network"
  | "server"
  | "throttled"
  | "missing"
  | "forbidden"
  /** Fetched fine, but extract/chunk/embed threw — often transient. */
  | "indexing"
  | "other";

/** Classify a response status into a reason code. */
export function failureReason(status: number): FailureReason {
  if (status === 0) return "network";
  if (status === 404 || status === 410) return "missing";
  if (status === 401 || status === 403) return "forbidden";
  if (status === 408 || status === 429) return "throttled";
  if (status >= 500) return "server";
  return "other";
}

/** Transient failures worth one more attempt once the frontier drains. */
export function isRetryable(reason: FailureReason | undefined): boolean {
  return (
    reason === "network" ||
    reason === "server" ||
    reason === "throttled" ||
    // An embedding or storage hiccup usually passes on a second attempt; a
    // genuinely unparseable page fails twice and is then left alone.
    reason === "indexing"
  );
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
  chatSessions: {
    key: string;
    value: ChatSession;
    /** `byUpdated` orders the history list and drives eviction. */
    indexes: { byIndex: string; byUpdated: number };
  };
}
