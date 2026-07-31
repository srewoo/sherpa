/**
 * Storage persistence + quota pre-flight (PRD 5.5.5, 5.5.6). We ask for
 * persistent storage to avoid silent eviction, and refuse a crawl we can't fit
 * rather than failing halfway.
 */

/** Rough on-disk cost per page (float32), from the PRD storage budget:
 * ~46 MB for 2,000 pages ≈ 23 KB/page. */
export const BYTES_PER_PAGE = 23_000;

export interface StorageEstimate {
  readonly usage: number;
  readonly quota: number;
}

export function estimateIndexBytes(pageCount: number): number {
  return Math.ceil(pageCount * BYTES_PER_PAGE);
}

export interface Preflight {
  readonly needed: number;
  readonly available: number;
  readonly fits: boolean;
}

/** Pure fit check so the refusal logic is testable without the browser. */
export function preflight(pageCount: number, estimate: StorageEstimate): Preflight {
  const needed = estimateIndexBytes(pageCount);
  const available = Math.max(0, estimate.quota - estimate.usage);
  return { needed, available, fits: needed <= available };
}

export async function storageEstimate(): Promise<StorageEstimate> {
  const e = await navigator.storage.estimate();
  return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
}

/** Request durable storage; returns whether it's now persisted. */
export async function requestPersistent(): Promise<boolean> {
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
