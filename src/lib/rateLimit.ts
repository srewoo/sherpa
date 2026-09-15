/**
 * A ceiling on how fast Sherpa may call a paid provider.
 *
 * Echo rate-limits chat server-side (`core/chat_rate_limit.py`) to protect the
 * service from its users. Here the limit protects the *user* — from their own
 * key, and from Sherpa. There is no server between the panel and OpenAI, so
 * every loop, every stuck retry and every accidental keypress that fires a turn
 * spends real money with nothing in the way.
 *
 * The failure this exists for is not abuse, it is a bug. One refinement chip
 * that re-asks on render, one auto-retry that does not settle, and a user can
 * discover a hundred requests on their statement without ever having done
 * anything unusual. A sliding window makes that bug expensive to Sherpa (it
 * stops) rather than to the user (they pay).
 *
 * Deliberately generous. A limit a real person can reach by asking questions
 * quickly is a broken product, so the defaults sit far above human pace and
 * only a runaway can trip them.
 */

export interface RateLimitOptions {
  /** Calls permitted inside the window. */
  readonly max: number;
  readonly windowMs: number;
}

/**
 * Twenty calls a minute.
 *
 * A question can cost up to two provider calls — one for query understanding,
 * one for the answer — so this is roughly ten questions a minute, sustained.
 * Nobody reads answers that fast; a loop reaches it in under a second.
 */
export const DEFAULT_LIMIT: RateLimitOptions = { max: 20, windowMs: 60_000 };

export class RateLimitedError extends Error {
  constructor(
    readonly retryAfterMs: number,
    readonly limit: RateLimitOptions,
  ) {
    super(
      `Sherpa has made ${limit.max} provider calls in the last ` +
        `${Math.round(limit.windowMs / 1000)}s and has paused to avoid running up ` +
        `your bill. It will resume in ${Math.ceil(retryAfterMs / 1000)}s.`,
    );
    this.name = "RateLimitedError";
  }
}

/**
 * A sliding window over call timestamps.
 *
 * Sliding rather than fixed-bucket, because a fixed bucket permits a double
 * burst across a boundary — the exact shape a retry storm produces, and the one
 * case worth being precise about.
 */
export class RateLimiter {
  private calls: number[] = [];

  constructor(
    private readonly options: RateLimitOptions = DEFAULT_LIMIT,
    /** Injected for tests; production uses the monotonic browser clock. */
    private readonly now: () => number = () => performance.now(),
  ) {}

  private prune(at: number): void {
    const cutoff = at - this.options.windowMs;
    this.calls = this.calls.filter((t) => t > cutoff);
  }

  /** Calls still permitted in this window. */
  remaining(): number {
    const at = this.now();
    this.prune(at);
    return Math.max(0, this.options.max - this.calls.length);
  }

  /**
   * Throw if the window is full, without consuming anything.
   *
   * Separate from `record` for a reason that is easy to get wrong. The caller
   * checks *once*, before its retry loop, and records *per attempt* — so
   * retries count towards the ceiling (they are the runaway) while the ceiling
   * itself never becomes something the retry loop can spin on. Combining the
   * two would raise a `rate_limited` error inside the loop, which the policy
   * table quite correctly treats as retryable, and Sherpa would then sit
   * retrying its own refusal to spend money.
   *
   * Throws rather than waits. A limiter that quietly sleeps turns a runaway
   * loop into a slow runaway loop — the requests still happen, the money is
   * still spent, and the only thing that changes is how long it takes anyone to
   * notice. Refusing surfaces the problem while it is still cheap.
   */
  check(): void {
    const at = this.now();
    this.prune(at);
    if (this.calls.length >= this.options.max) {
      const oldest = this.calls[0] ?? at;
      throw new RateLimitedError(oldest + this.options.windowMs - at, this.options);
    }
  }

  /** Count a call against the window. */
  record(): void {
    const at = this.now();
    this.prune(at);
    this.calls.push(at);
  }

  /** Check and record together, for callers with no retry loop of their own. */
  take(): void {
    this.check();
    this.record();
  }

  reset(): void {
    this.calls = [];
  }
}

/**
 * The process-wide limiter for paid provider calls.
 *
 * Module state, for the same reason the breaker registry is: a limit every
 * caller can sidestep by constructing its own is not a limit. Lives only as
 * long as the offscreen document, which is correct — the window is a minute,
 * and a document that has just started has made no calls.
 */
export const providerLimiter = new RateLimiter();
