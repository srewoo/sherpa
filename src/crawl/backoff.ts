/**
 * Failure handling (PRD 5.2.5). Exponential backoff on transient errors and an
 * abort after N consecutive failures.
 */

/** 429 and 503 are the retry-worthy signals help sites send under load. */
export function isTransient(status: number): boolean {
  return status === 429 || status === 503;
}

/** Exponential backoff with a cap. attempt is 1-based. */
export function backoffMs(attempt: number, base = 500, cap = 30_000): number {
  return Math.min(cap, base * 2 ** (attempt - 1));
}

/** Tracks consecutive failures; `record` returns true once the crawl should abort. */
export class FailureTracker {
  private consecutive = 0;
  constructor(private readonly ceiling: number) {}

  record(failed: boolean): boolean {
    this.consecutive = failed ? this.consecutive + 1 : 0;
    return this.consecutive >= this.ceiling;
  }

  get streak(): number {
    return this.consecutive;
  }
}
