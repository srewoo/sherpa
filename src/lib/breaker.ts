/**
 * A circuit breaker per answering provider.
 *
 * The failure this fixes is specific and was easy to hit: save a key with a
 * typo, and every question re-ran the full retry schedule against a provider
 * that had already rejected the same key three times. Query understanding calls
 * `complete()` too, so one question could mean six rejected requests and
 * several seconds of sleeping before the panel admitted anything was wrong.
 *
 * Ported from Echo's `resilience/breaker.py`, with two differences that follow
 * from being in a browser rather than a server process. `performance.now()`
 * replaces a monotonic clock — `Date.now` would let a system clock change or a
 * laptop waking from sleep close a breaker that should still be open. And the
 * registry is per offscreen document, so it dies with the document: a fresh
 * one starts trusting the provider again, which is the right default for a
 * process whose lifetime is minutes.
 */

import { kindForThrown, policyFor } from "./errorKind.js";
import type { ByokProvider } from "@/domain/generator.js";

/** Failures inside the window that trip the circuit. */
export const CB_FAILURE_THRESHOLD = 4;
/** How far back failures are counted. Older ones are forgiven. */
export const CB_RECOVERY_WINDOW_MS = 60_000;
/** How long the circuit stays open before one call is allowed through. */
export const CB_HALF_OPEN_AFTER_MS = 30_000;

export type BreakerRole = "answer" | "complete";

/**
 * Roles are kept apart on purpose.
 *
 * Query understanding (`complete`) and answering hit the same provider with
 * very different requests: a rewrite is tiny, an answer carries several
 * thousand tokens of context. A context-length rejection on the answer path
 * says nothing about whether a rewrite would work, and letting it block
 * rewriting would silently switch off two settings the user turned on.
 */
export function providerBreakerName(provider: ByokProvider, role: BreakerRole): string {
  return `llm:${role}:${provider}`;
}

export class CircuitOpenError extends Error {
  constructor(readonly breaker: string, readonly openForMs: number) {
    super(`${breaker} circuit is open`);
    this.name = "CircuitOpenError";
  }
}

export class CircuitBreaker {
  private failures: number[] = [];
  private openSince: number | null = null;

  constructor(
    readonly name: string,
    private readonly opts: {
      readonly threshold?: number;
      readonly recoveryWindowMs?: number;
      readonly halfOpenAfterMs?: number;
      /** Injected for tests; production uses the monotonic browser clock. */
      readonly now?: () => number;
    } = {},
  ) {}

  private get now(): number {
    return (this.opts.now ?? (() => performance.now()))();
  }

  private get threshold(): number {
    return this.opts.threshold ?? CB_FAILURE_THRESHOLD;
  }

  get isOpen(): boolean {
    if (this.openSince === null) return false;
    const elapsed = this.now - this.openSince;
    if (elapsed < (this.opts.halfOpenAfterMs ?? CB_HALF_OPEN_AFTER_MS)) return true;
    /**
     * Half-open: let exactly one call through to find out.
     *
     * Clearing `openSince` here rather than on the next success is what makes
     * it one call and not a flood — the probe closes the breaker if it works
     * and reopens it immediately if it doesn't, because the failure count is
     * still sitting at the threshold.
     */
    this.openSince = null;
    return false;
  }

  /** Milliseconds since the circuit tripped, or null while closed. */
  get openForMs(): number | null {
    return this.openSince === null ? null : this.now - this.openSince;
  }

  recordSuccess(): void {
    this.openSince = null;
    this.failures = [];
  }

  recordFailure(): void {
    const now = this.now;
    const cutoff = now - (this.opts.recoveryWindowMs ?? CB_RECOVERY_WINDOW_MS);
    this.failures = this.failures.filter((t) => t >= cutoff);
    this.failures.push(now);
    if (this.failures.length >= this.threshold) this.openSince = now;
  }

  /**
   * Record an outcome by classifying the error, so callers don't each decide
   * what counts. Only failures the provider is answerable for move the needle
   * — see `ErrorPolicy.trips`.
   */
  record(error: unknown): void {
    if (error === undefined) {
      this.recordSuccess();
      return;
    }
    if (policyFor(kindForThrown(error)).trips) this.recordFailure();
  }

  /** Throw rather than make a call we expect to fail. */
  check(): void {
    if (this.isOpen) throw new CircuitOpenError(this.name, this.openForMs ?? 0);
  }

  /** Guard a call: fail fast when open, and record the outcome when not. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.check();
    try {
      const out = await fn();
      this.recordSuccess();
      return out;
    } catch (error) {
      this.record(error);
      throw error;
    }
  }
}

/** Name-keyed breakers, created on first use. */
export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(private readonly opts: ConstructorParameters<typeof CircuitBreaker>[1] = {}) {}

  get(name: string): CircuitBreaker {
    const existing = this.breakers.get(name);
    if (existing) return existing;
    const created = new CircuitBreaker(name, this.opts);
    this.breakers.set(name, created);
    return created;
  }

  reset(): void {
    this.breakers.clear();
  }
}

/**
 * The process-wide registry.
 *
 * Module-level state, which is right here and would be wrong almost anywhere
 * else in this codebase: the whole value of a breaker is that it remembers
 * across the calls that would otherwise repeat the same mistake, and every
 * caller in one offscreen document must consult the same memory.
 */
export const breakers = new CircuitBreakerRegistry();
