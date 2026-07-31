/**
 * Crawl pacing (PRD 5.2.3). A Pacer enforces a minimum interval between
 * dispatches (requests/sec). It's a pure scheduler — `reserve(now)` returns how
 * long to wait — so the timing logic is deterministic and testable; the engine
 * does the actual sleeping.
 */

export function intervalFromRps(rps: number): number {
  if (rps <= 0) throw new Error("requests/sec must be positive");
  return Math.ceil(1000 / rps);
}

export class Pacer {
  private nextAt = 0;
  constructor(private readonly intervalMs: number) {}

  /** Reserve the next slot; returns ms to wait from `now` before dispatching. */
  reserve(now: number): number {
    const start = Math.max(now, this.nextAt);
    this.nextAt = start + this.intervalMs;
    return start - now;
  }
}
