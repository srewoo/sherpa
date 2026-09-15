/**
 * A named failure mode for every way an answering provider can let us down,
 * and one table saying what to do about each.
 *
 * Before this, the BYOK path threw `new Error("provider error 429")` and every
 * caller downstream had a string. A string cannot be retried, cannot trip a
 * breaker, and cannot decide whether to show a banner or stay quiet — so all
 * three decisions were made the same way for every failure: give up, and put
 * the raw text on screen. A rejected key and a momentary rate limit are not the
 * same event and must not produce the same behaviour: one is fixed in Settings
 * and will never succeed on retry, the other fixes itself in two seconds.
 *
 * The kind is the classification; the policy is the consequence. Keeping them
 * apart means a new provider quirk adds a row, not a branch in four files.
 */

import type { ByokProvider } from "@/domain/generator.js";

/**
 * What went wrong, in terms the rest of the app can act on.
 *
 * Deliberately about *cause*, not about HTTP. A 429 that means "you are going
 * too fast" and a 429 that means "your card expired" arrive at the same status
 * code and need opposite handling — retrying the second forever is how a
 * product burns a user's afternoon insisting it is nearly there.
 */
export type ProviderErrorKind =
  /** The key was rejected. Retrying cannot help; Settings can. */
  | "auth_invalid"
  /** Too many requests, too fast. Self-healing — the one kind worth auto-retrying. */
  | "rate_limited"
  /** Credit exhausted or billing inactive. Arrives as 429 and must not be retried. */
  | "quota_exhausted"
  /** No such model for this key. Almost always a stale model id in Settings. */
  | "model_not_found"
  /** The request was malformed or over the context limit. Our bug or too much context. */
  | "bad_request"
  /** The provider's safety layer refused. Retrying the same prompt is pointless. */
  | "content_filtered"
  /** 5xx. The provider is having a bad day; ours can be shorter than theirs. */
  | "provider_down"
  /** Our own deadline fired. Distinct from `cancelled`: nobody asked for this. */
  | "timeout"
  /** The user pressed stop. Not an error, and must never be presented as one. */
  | "cancelled"
  /**
   * The request never reached the provider. Usually a missing host permission
   * rather than a dead link — see `ByokGenerator.send` and `permissions/host.ts`.
   */
  | "network"
  /** HTTP 200, stream closed, not one usable token. Silence is the worst report. */
  | "empty_stream"
  /** Tokens arrived, then the stream died mid-answer. The user has half a sentence. */
  | "stream_truncated"
  /** We refused to call out at all, because this provider is currently failing. */
  | "circuit_open"
  /** Genuinely unrecognised. Retryable once, on the chance it was a blip. */
  | "unknown";

/** How a failure should be surfaced. */
export type ErrorPresentation =
  /** A visible banner with the detail — the user must act. */
  | "banner"
  /** Shown inline in the turn as a refusal. Ordinary conversation flow. */
  | "inline"
  /** Nothing on screen. Only for things the user themselves caused. */
  | "silent";

export interface ErrorPolicy {
  /** Worth another attempt at all. */
  readonly retryable: boolean;
  /**
   * No further attempt will ever succeed without the user changing something.
   * Terminal kinds skip the retry loop entirely rather than sleeping first.
   */
  readonly terminal: boolean;
  /** Retry without telling anyone. Reserved for failures that truly pass. */
  readonly autoRetry: boolean;
  readonly presentation: ErrorPresentation;
  /**
   * Counts towards opening this provider's circuit breaker.
   *
   * Excludes everything the provider is not responsible for. Counting a user's
   * own cancel, or their bad model name, towards "the provider is down" would
   * trip the breaker on a perfectly healthy endpoint and then blame it.
   */
  readonly trips: boolean;
}

function policy(
  retryable: boolean,
  opts: {
    readonly terminal?: boolean;
    readonly autoRetry?: boolean;
    readonly presentation?: ErrorPresentation;
    readonly trips?: boolean;
  } = {},
): ErrorPolicy {
  return {
    retryable,
    terminal: opts.terminal ?? false,
    autoRetry: opts.autoRetry ?? false,
    presentation: opts.presentation ?? "banner",
    trips: opts.trips ?? false,
  };
}

/**
 * The whole decision table, in one readable place.
 *
 * Every value here is a claim about the world that can be checked against a
 * provider's documentation, which is the point of a table over scattered `if`s.
 */
const POLICIES: Readonly<Record<ProviderErrorKind, ErrorPolicy>> = {
  auth_invalid: policy(false, { terminal: true }),
  rate_limited: policy(true, { autoRetry: true, trips: false }),
  // A 429 the money caused, not the pace. Auto-retrying this is how a tool
  // spends ten minutes rediscovering that a card declined.
  quota_exhausted: policy(false, { terminal: true }),
  model_not_found: policy(false, { terminal: true }),
  bad_request: policy(false, { terminal: true }),
  content_filtered: policy(false, { terminal: true, presentation: "inline" }),
  provider_down: policy(true, { autoRetry: true, trips: true }),
  timeout: policy(true, { autoRetry: true, trips: true }),
  cancelled: policy(false, { terminal: true, presentation: "silent" }),
  network: policy(true, { trips: true }),
  empty_stream: policy(true, { trips: true }),
  // Retryable, but never silently: re-running a half-streamed answer replaces
  // text the user has already started reading, so they get to choose.
  stream_truncated: policy(true, { presentation: "inline" }),
  circuit_open: policy(false, { presentation: "banner" }),
  unknown: policy(true, { trips: true }),
};

export function policyFor(kind: ProviderErrorKind): ErrorPolicy {
  return POLICIES[kind];
}

/**
 * A classified provider failure, carrying everything a caller needs to decide.
 *
 * Extends `Error` so it can still be thrown through code that only knows about
 * exceptions, and so an unhandled one still prints something useful.
 */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  /** HTTP status, or 0 when the failure happened before a response existed. */
  readonly status: number;
  readonly provider?: ByokProvider;
  readonly model?: string;
  /** The provider's own words, which are usually the only actionable part. */
  readonly detail: string;

  constructor(args: {
    readonly kind: ProviderErrorKind;
    readonly message: string;
    readonly status?: number;
    readonly provider?: ByokProvider;
    readonly model?: string;
    readonly detail?: string;
  }) {
    super(args.message);
    this.name = "ProviderError";
    this.kind = args.kind;
    this.status = args.status ?? 0;
    if (args.provider) this.provider = args.provider;
    if (args.model) this.model = args.model;
    this.detail = args.detail ?? args.message;
  }

  get policy(): ErrorPolicy {
    return policyFor(this.kind);
  }
}

export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
}

/**
 * Phrases providers use to distinguish "slow down" from "you have no credit".
 *
 * Matching on text is unlovely and it is also the only signal available: all
 * three providers return 429 for both, and the difference decides whether we
 * retry for thirty seconds or stop immediately and say why.
 */
const QUOTA_MARKERS = [
  "insufficient_quota",
  "insufficient quota",
  "exceeded your current quota",
  "billing",
  "credit balance is too low",
  "quota exceeded",
  "resource_exhausted",
  "plan and billing",
] as const;

const MODEL_MARKERS = [
  "does not exist",
  "model_not_found",
  "unknown model",
  "is not found",
  "not_found_error",
  "invalid model",
] as const;

const FILTER_MARKERS = [
  "content_filter",
  "content policy",
  "safety",
  "blocked",
  "prohibited_content",
] as const;

const RATE_MARKERS = [
  "rate limit",
  "rate_limit",
  "too many requests",
  "overloaded",
  "slow down",
  "try again later",
] as const;

const DOWN_MARKERS = [
  "internal server error",
  "internal error",
  "service unavailable",
  "bad gateway",
  "upstream",
] as const;

const CONTEXT_MARKERS = [
  "context_length_exceeded",
  "maximum context length",
  "too many tokens",
  "prompt is too long",
  "request too large",
] as const;

function mentions(haystack: string, needles: readonly string[]): boolean {
  const lower = haystack.toLowerCase();
  return needles.some((n) => lower.includes(n));
}

/**
 * Classify a failure that arrives as text with no status attached.
 *
 * All three providers can return HTTP 200, open an SSE stream, and then send an
 * error object instead of content — a mid-stream rate limit, a safety stop, a
 * backend falling over. There is no status code to read, so the markers are the
 * only signal, and feeding 200 into the status-driven classifier below lands
 * every one of them on `unknown`: retryable, breaker-tripping, and with no
 * remedy shown, when the provider had just said exactly what was wrong.
 *
 * Order is deliberate. Quota is checked before rate limiting because "you have
 * exceeded your quota" contains both, and getting that pair the wrong way round
 * is what makes a tool retry a declined card for thirty seconds.
 */
export function kindForMessage(text: string): ProviderErrorKind {
  if (mentions(text, QUOTA_MARKERS)) return "quota_exhausted";
  if (mentions(text, MODEL_MARKERS)) return "model_not_found";
  if (mentions(text, FILTER_MARKERS)) return "content_filtered";
  if (mentions(text, CONTEXT_MARKERS)) return "bad_request";
  if (mentions(text, RATE_MARKERS)) return "rate_limited";
  if (mentions(text, DOWN_MARKERS)) return "provider_down";
  return "unknown";
}

/**
 * Classify a failed HTTP response.
 *
 * `body` is the response text already read by the caller — read once, because
 * a `Response` body can only be consumed one time and losing the provider's
 * message to a double read is exactly the silent failure this file exists to
 * prevent.
 */
export function kindForResponse(status: number, body: string): ProviderErrorKind {
  if (status === 401 || status === 403) {
    // A 403 is occasionally a region or policy block rather than a bad key.
    // Both are fixed by the user, neither by a retry, so one kind is enough.
    return "auth_invalid";
  }
  if (status === 429) return mentions(body, QUOTA_MARKERS) ? "quota_exhausted" : "rate_limited";
  if (status === 404) return "model_not_found";
  if (status === 400 || status === 422) {
    if (mentions(body, MODEL_MARKERS)) return "model_not_found";
    if (mentions(body, FILTER_MARKERS)) return "content_filtered";
    // Over-long context is our packing bug, not the user's — but it is still
    // not retryable as-is, so it shares the terminal `bad_request` policy.
    if (mentions(body, CONTEXT_MARKERS)) return "bad_request";
    return "bad_request";
  }
  if (status === 402) return "quota_exhausted";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 500) return "provider_down";
  // Anything left — including a 2xx passed in by the in-band frame path
  // before `kindForMessage` existed — is classified on its text alone.
  return kindForMessage(body);
}

/**
 * Classify something thrown rather than returned.
 *
 * `AbortError` is the load-bearing case and it is ambiguous by design: the
 * platform raises the same error whether our deadline fired or the user pressed
 * stop. Only the caller knows which, so it passes `cancelled` in — guessing
 * would mean either presenting the user's own cancel as a provider fault, or
 * hiding a real timeout as though they had asked for it.
 */
export function kindForThrown(error: unknown, opts: { readonly cancelled?: boolean } = {}): ProviderErrorKind {
  if (isProviderError(error)) return error.kind;
  if (error instanceof DOMException && error.name === "AbortError") {
    return opts.cancelled ? "cancelled" : "timeout";
  }
  if (error instanceof Error) {
    if (error.name === "AbortError") return opts.cancelled ? "cancelled" : "timeout";
    if (error.name === "TimeoutError") return "timeout";
    // `fetch` rejects with a bare TypeError for everything network-shaped,
    // including a missing host permission. See ByokGenerator.send.
    if (error instanceof TypeError) return "network";
    if (/failed to fetch|networkerror|load failed/i.test(error.message)) return "network";
  }
  return "unknown";
}

/**
 * One sentence telling the user what to change.
 *
 * Sits beside the provider's own message rather than replacing it: the provider
 * says what happened, this says where to go. Neither alone was enough — "model
 * `gpt-5.4-mini` does not exist" is precise and gives no hint that the fix is
 * two clicks away in Settings.
 */
export function remedyFor(kind: ProviderErrorKind): string | undefined {
  switch (kind) {
    case "auth_invalid":
      return "Check the API key in Settings — the provider rejected it.";
    case "quota_exhausted":
      return "This key has no credit left. Top it up with the provider, or switch to the on-device model in Settings.";
    case "model_not_found":
      return "Pick a different model in Settings — this key can't reach that one.";
    case "rate_limited":
      return "The provider is throttling. Sherpa retried; try again in a moment if it kept failing.";
    case "network":
      return 'Open Settings and use "Grant access" beside your provider — Sherpa may not have permission to call it.';
    case "provider_down":
      return "The provider is returning errors. On-device answering still works in Settings.";
    case "timeout":
      return "The provider didn't respond in time. Try again, or switch tiers in Settings.";
    case "circuit_open":
      return "Sherpa has paused calls to this provider after repeated failures. It will try again shortly.";
    case "bad_request":
      return "The request was rejected as malformed. Reducing the number of sources in Settings can help if the context was too long.";
    case "empty_stream":
      return "The provider accepted the request and returned nothing. The model name may be wrong.";
    case "content_filtered":
    case "stream_truncated":
    case "cancelled":
    case "unknown":
      return undefined;
  }
}
