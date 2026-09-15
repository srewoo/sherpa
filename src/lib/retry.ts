/**
 * Retry with jittered backoff for the answering path.
 *
 * `crawl/backoff.ts` has done this for fetching pages since the first
 * milestone; the answer path — the one the user is actually watching — had
 * nothing. A single 429 from OpenAI ended the turn, and the user saw a refusal
 * claiming their documentation didn't cover the question.
 *
 * The rule that matters is the one Echo's `retry_with_backoff` gets right:
 * retry only what classification says is retryable. A retry loop that does not
 * consult the error is worse than no retry loop, because it turns a rejected
 * API key into four rejected API keys and a four-second wait before telling
 * the user the one thing they needed to hear immediately.
 */

import { kindForThrown, policyFor, type ProviderErrorKind } from "./errorKind.js";

/**
 * Attempts and the gap before each retry.
 *
 * Three attempts across ~1.5 s of sleeping. Short on purpose: somebody is
 * watching a blank panel, and a retry schedule generous enough to outlast a
 * real outage is indistinguishable from a hang.
 */
export const DEFAULT_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_MS: readonly number[] = [250, 1000, 2500];

/** Multiplicative jitter bounds, as in Echo's `jittered_delay`. */
export const JITTER_LOWER = 0.5;
export const JITTER_UPPER = 1.5;

/**
 * Spread retries out so concurrent callers don't resynchronise.
 *
 * Less critical here than on a server — one browser makes one call — but a
 * refinement chip can fire a second turn while the first is mid-retry, and two
 * clients hammering a throttled provider in lockstep is exactly what a 429 is
 * asking them to stop doing.
 */
export function jitteredDelay(
  baseMs: number,
  random: () => number = Math.random,
): number {
  return baseMs * (JITTER_LOWER + random() * (JITTER_UPPER - JITTER_LOWER));
}

export interface RetryOptions {
  readonly attempts?: number;
  readonly backoffMs?: readonly number[];
  /** Names the operation in log lines. */
  readonly label?: string;
  /**
   * Decide retryability from the thrown value. Defaults to the policy table,
   * which is what every production caller wants; injectable for tests and for
   * callers whose failures aren't provider failures.
   */
  readonly isRetryable?: (error: unknown) => boolean;
  /** Injected so tests don't spend real seconds asleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  /**
   * Called before each sleep. The answer path uses it to tell the panel that
   * something is being retried rather than leaving a silent pause — a pause is
   * the one thing a user reliably reads as "broken".
   */
  readonly onRetry?: (info: {
    readonly attempt: number;
    readonly delayMs: number;
    readonly kind: ProviderErrorKind;
    readonly error: unknown;
  }) => void;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Policy-table retryability: retryable, and not terminal. */
export function defaultIsRetryable(error: unknown): boolean {
  const policy = policyFor(kindForThrown(error));
  return policy.retryable && !policy.terminal;
}

/**
 * Call `fn` up to `attempts` times, sleeping between retryable failures.
 *
 * Rethrows the last error rather than wrapping it: the caller's classification
 * and the user-facing message both depend on the original, and a wrapper would
 * turn `auth_invalid` back into `unknown` at the exact moment it mattered.
 */
export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  if (attempts < 1) throw new RangeError(`attempts must be >= 1, got ${attempts}`);
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const retryable = options.isRetryable ?? defaultIsRetryable;
  const sleep = options.sleep ?? realSleep;

  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      last = error;
      if (!retryable(error)) throw error;
      if (attempt >= attempts) break;
      const base = backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 0;
      const delayMs = jitteredDelay(base, options.random);
      options.onRetry?.({
        attempt,
        delayMs,
        kind: kindForThrown(error),
        error,
      });
      await sleep(delayMs);
    }
  }
  throw last;
}
