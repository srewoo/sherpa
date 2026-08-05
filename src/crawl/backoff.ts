/**
 * Failure handling (PRD 5.2.5). Exponential backoff on transient errors and an
 * abort after N consecutive failures.
 */

/** 429 and 503 are the retry-worthy signals help sites send under load. */
export function isTransient(status: number): boolean {
  return status === 429 || status === 503;
}

/**
 * Does this failure mean the *site or the network* is in trouble, rather than
 * one page being missing?
 *
 * The distinction decides whether a failure counts toward aborting the crawl,
 * and getting it wrong is what stopped a working crawl of help.egain.com. Every
 * non-2xx used to feed the consecutive-failure streak, 404 included — so a help
 * centre with a retired section, whose dead links are harvested together and
 * therefore fetched together, produced twenty 404s in a row and tripped a
 * circuit breaker meant for "the server has gone away". The crawl had already
 * indexed 222 pages successfully and was reported as *Stopped*, with pages
 * still queued.
 *
 * A 404 is information about one URL. A 503, a 429, a 500 or a dead socket is
 * information about whether continuing is worth anything at all. Only the
 * second kind is evidence for stopping.
 *
 * `status === 0` is `browserFetch`'s network-error sentinel: DNS failure, a
 * dropped connection, offline. That is the clearest infrastructure signal there
 * is, and the one the ceiling most needs to catch.
 */
export function isInfrastructureFailure(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
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
