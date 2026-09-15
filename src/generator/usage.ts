/**
 * What a BYOK answer cost, in tokens and — where the rate is known — money.
 *
 * BYOK spends the user's own money and reported nothing back. There was no
 * running total, no per-answer figure, and no way to notice that HyDE plus
 * query rewriting plus a 4,096-token answer ceiling had tripled the bill. Echo
 * tracks this server-side in `core/usage.py` and `core/pricing.py`; the same
 * accounting belongs here, for the same reason, minus the server.
 *
 * Two rules shape the whole file.
 *
 * Providers report real usage and it is always preferred. OpenAI sends a final
 * `usage` frame when asked for one, Anthropic puts it on `message_delta`, and
 * Gemini attaches `usageMetadata` to every chunk. Estimating when the true
 * number is sitting in the response would be inventing data.
 *
 * A price nobody can cite is not shown. Model rates change, and a hard-coded
 * table silently becomes a lie that looks like a measurement — the worst kind
 * of number to put in front of someone about their own spending. Cost appears
 * only for models in `RATES`, each carrying the date its rate was checked;
 * everything else reports tokens and says plainly that the rate is unknown.
 */

import type { ByokProvider } from "@/domain/generator.js";

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  /**
   * True when these came from a character count rather than the provider.
   *
   * Surfaced in the UI, not hidden. "About 1,200 tokens" and "1,187 tokens" are
   * different claims and the user is entitled to know which one they are being
   * shown before they reconcile it against a bill.
   */
  readonly estimated: boolean;
}

export const ZERO_USAGE: TokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  estimated: false,
};

/**
 * Four characters per token.
 *
 * The usual English-prose rule of thumb, and wrong in both directions on the
 * content Sherpa actually sends: code blocks and long URLs tokenise far worse
 * than prose, non-Latin scripts worse again. It is a fallback for providers
 * that report nothing, which is why every path that uses it sets
 * `estimated: true` rather than quietly presenting it as a measurement.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    // One estimated half makes the total an estimate. Presenting a mixed sum as
    // exact would be the same overclaim as estimating in the first place.
    estimated: a.estimated || b.estimated,
  };
}

/** USD per million tokens, with the date the rate was last checked. */
export interface ModelRate {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
  /** ISO date. Rendered beside any cost, so a stale rate is visible as stale. */
  readonly verifiedOn: string;
}

/**
 * Published rates, for the models whose rates are citable.
 *
 * Deliberately incomplete, and that is the point. These are Anthropic's
 * first-party rates as published on 2026-06-24. Rates for other providers are
 * not included because they could not be verified from a source at the time of
 * writing, and a made-up number about somebody's spending is worse than no
 * number: a user who sees "$0.004" will believe it, reconcile nothing, and only
 * discover the error from their card statement.
 *
 * Adding a provider means adding rows here with a real `verifiedOn`. Until
 * then, those models report tokens and `costUsd` returns undefined, which the
 * UI renders as "rate unknown" rather than as zero.
 */
export const RATES: Readonly<Record<string, ModelRate>> = {
  "claude-fable-5-1": { inputPerMillion: 10, outputPerMillion: 50, verifiedOn: "2026-06-24" },
  "claude-fable-5": { inputPerMillion: 10, outputPerMillion: 50, verifiedOn: "2026-06-24" },
  "claude-opus-5": { inputPerMillion: 5, outputPerMillion: 25, verifiedOn: "2026-06-24" },
  "claude-opus-4-8": { inputPerMillion: 5, outputPerMillion: 25, verifiedOn: "2026-06-24" },
  "claude-opus-4-7": { inputPerMillion: 5, outputPerMillion: 25, verifiedOn: "2026-06-24" },
  "claude-opus-4-6": { inputPerMillion: 5, outputPerMillion: 25, verifiedOn: "2026-06-24" },
  "claude-sonnet-5": { inputPerMillion: 2, outputPerMillion: 10, verifiedOn: "2026-06-24" },
  "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15, verifiedOn: "2026-06-24" },
  "claude-haiku-4-5": { inputPerMillion: 1, outputPerMillion: 5, verifiedOn: "2026-06-24" },
};

export function rateFor(model: string): ModelRate | undefined {
  return RATES[model];
}

/**
 * What this usage cost, or undefined when the rate is unknown.
 *
 * `undefined` rather than 0. Zero is a claim that the answer was free, and the
 * two must never render the same way.
 */
export function costUsd(model: string, usage: TokenUsage): number | undefined {
  const rate = rateFor(model);
  if (!rate) return undefined;
  return (
    (usage.promptTokens * rate.inputPerMillion) / 1_000_000 +
    (usage.completionTokens * rate.outputPerMillion) / 1_000_000
  );
}

/** Money, at the precision the numbers actually support. */
export function formatUsd(amount: number): string {
  if (amount === 0) return "$0.00";
  // Below a cent, two decimals renders every answer as "$0.00" and the counter
  // looks broken. Four is enough to show a single cheap turn moving.
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

export function formatTokens(count: number): string {
  return count.toLocaleString();
}

/**
 * Pull real usage out of a streamed frame, if this one carries it.
 *
 * Each provider volunteers it in a different place and at a different moment,
 * so this is called on every frame and returns undefined for the vast majority
 * of them. Cheap: the frame has already been parsed by the delta extractor.
 *
 *   openai     a final `usage` object, but only when the request asked for it
 *              via `stream_options.include_usage`
 *   anthropic  `message_start` carries input tokens, `message_delta` the
 *              running output count — so the two must be merged, not replaced
 *   gemini     `usageMetadata` on chunks, cumulative rather than incremental
 */
export function usageFromFrame(provider: ByokProvider, data: string): TokenUsage | undefined {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  if (provider === "openai") {
    const u = json["usage"] as { prompt_tokens?: number; completion_tokens?: number } | null | undefined;
    if (!u) return undefined;
    return {
      promptTokens: u.prompt_tokens ?? 0,
      completionTokens: u.completion_tokens ?? 0,
      estimated: false,
    };
  }

  if (provider === "anthropic") {
    // `message_start` nests usage under `message`; `message_delta` puts it at
    // the top level and reports only output. Reading one and not the other is
    // how a prompt-token count silently stays at zero.
    const top = json["usage"] as { input_tokens?: number; output_tokens?: number } | undefined;
    const message = json["message"] as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined;
    const u = message?.usage ?? top;
    if (!u) return undefined;
    return {
      promptTokens: u.input_tokens ?? 0,
      completionTokens: u.output_tokens ?? 0,
      estimated: false,
    };
  }

  const meta = json["usageMetadata"] as
    | { promptTokenCount?: number; candidatesTokenCount?: number }
    | undefined;
  if (!meta) return undefined;
  return {
    promptTokens: meta.promptTokenCount ?? 0,
    completionTokens: meta.candidatesTokenCount ?? 0,
    estimated: false,
  };
}

/**
 * Merge a newly reported usage into the running one.
 *
 * Not addition. Every provider reports *cumulative* totals for the turn — a
 * later frame supersedes an earlier one rather than adding to it — so summing
 * them would multiply a Gemini answer's token count by the number of chunks it
 * arrived in. The max is taken per field because Anthropic splits the two
 * halves across two different frames, and a `message_delta` reporting only
 * output must not reset the input count to zero.
 */
export function mergeReported(current: TokenUsage, reported: TokenUsage): TokenUsage {
  return {
    promptTokens: Math.max(current.promptTokens, reported.promptTokens),
    completionTokens: Math.max(current.completionTokens, reported.completionTokens),
    estimated: false,
  };
}
