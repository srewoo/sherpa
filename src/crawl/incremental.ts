/**
 * Incremental recrawl decision (PRD 5.6.5). Only changed pages are re-embedded.
 * We always fetch the page (crawling as the user), but skip the expensive
 * extract+embed when the content is unchanged. ETag / Last-Modified short-circuit
 * when the server provides them; the content hash is the authoritative fallback.
 */

export interface PageVersion {
  readonly etag: string | undefined;
  readonly lastmod: string | undefined;
  readonly htmlHash: string;
}

/** True when the fetched page differs from what's already indexed. */
export function shouldReindex(stored: PageVersion | undefined, fetched: PageVersion): boolean {
  if (!stored) return true; // new page
  if (stored.etag && fetched.etag) return stored.etag !== fetched.etag;
  if (stored.lastmod && fetched.lastmod) return stored.lastmod !== fetched.lastmod;
  return stored.htmlHash !== fetched.htmlHash;
}

/**
 * Does the sparse index need rebuilding after a crawl?
 *
 * The BM25 blob is derived entirely from the stored chunks, so if an
 * incremental pass re-indexed nothing — every page answered 304 or hashed
 * identical — the existing blob is still exactly correct. Rebuilding it means
 * re-tokenising every chunk in the index and writing several MB back to disk to
 * produce a byte-identical result.
 *
 * A first crawl or a full rebuild always builds, since there is nothing to
 * reuse.
 */
export function shouldRebuildSparseIndex(incremental: boolean, pagesReindexed: number): boolean {
  return !incremental || pagesReindexed > 0;
}
