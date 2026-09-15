/**
 * Tier 2 — Bring your own key (PRD 5.8.6). The user's key is read from
 * chrome.storage.local and sent only to their chosen provider. This is the one
 * path where queries + retrieved chunks leave the device, gated behind the
 * explicit BYOK warning in the UI.
 *
 * This is also the only path in Sherpa that depends on a machine nobody here
 * controls, so it is the only one that needs the resilience layer: a deadline,
 * a classified failure, a bounded retry and a breaker. See `lib/errorKind.ts`
 * for why a thrown string was not enough.
 */

import type { AnswerChunk, AnswerGenerator, AnswerRequest, ByokProvider, TierAvailability } from "@/domain/generator.js";
import { buildGroundedPrompt } from "./prompt.js";
import { BYOK_PACK } from "./context.js";
import {
  ProviderError,
  kindForMessage,
  kindForResponse,
  kindForThrown,
  policyFor,
  remedyFor,
  type ProviderErrorKind,
} from "@/lib/errorKind.js";
import { retryWithBackoff, type RetryOptions } from "@/lib/retry.js";
import {
  ZERO_USAGE,
  estimateTokens,
  mergeReported,
  usageFromFrame,
  type TokenUsage,
} from "./usage.js";
import { breakers, providerBreakerName, CircuitOpenError } from "@/lib/breaker.js";
import { providerLimiter, RateLimitedError, type RateLimiter } from "@/lib/rateLimit.js";
import { maskPii, EGRESS_KINDS } from "@/lib/pii.js";

export interface ByokConfig {
  readonly provider: ByokProvider;
  readonly model: string;
  readonly apiKey: string;
}

const SYSTEM = "You are a documentation assistant. Answer strictly from the provided context and cite sources as [n].";

/**
 * Output ceiling for a BYOK answer.
 *
 * Was 1,024 — enough for a paragraph, and not enough for the multi-step
 * procedures that are most of a help centre. A truncated answer looks complete,
 * which is the failure mode this whole tier exists to avoid; the tokens are the
 * user's own and they chose to spend them.
 */
const MAX_ANSWER_TOKENS = 4096;

/**
 * How long to wait for the provider to say anything at all.
 *
 * There was no deadline here, and the consequence was the worst failure mode in
 * the product: a provider that accepts a connection and never responds left the
 * panel in "writing…" forever, with the message listener still attached and
 * `done` never emitted. Nothing errored, nothing timed out, and the turn could
 * not be retried or abandoned — the user's only route out was closing the panel.
 *
 * Two separate deadlines, because they answer different questions. The headers
 * deadline asks "is this provider alive?" and can be short. The idle deadline
 * asks "is this stream still producing?" and must be generous enough for a
 * model thinking between tokens, while still catching a socket that has quietly
 * died mid-answer — which is `stream_truncated`, not a hang.
 */
export const HEADERS_TIMEOUT_MS = 30_000;
export const IDLE_TIMEOUT_MS = 45_000;

export interface ByokOptions {
  /** The user pressed stop. Aborts with `cancelled`, never reported as a fault. */
  readonly signal?: AbortSignal;
  readonly headersTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  /** Retry knobs, threaded through for tests and for the query-understanding path. */
  readonly retry?: RetryOptions;
  /** Injected in tests; production uses the global. */
  readonly fetchImpl?: typeof fetch;
  /**
   * The spend guard. Defaults to the process-wide limiter.
   *
   * Injectable for tests only — a per-instance limiter in production would be
   * no limit at all, since a new generator is constructed for every question.
   */
  readonly limiter?: RateLimiter;
  /**
   * Called once per completed call with what it cost.
   *
   * BYOK spends the user's own money and used to report nothing. Fired on
   * success only: a failed call has no answer to attribute a cost to, and
   * providers do not bill for one either.
   */
  readonly onUsage?: (usage: TokenUsage) => void;
}

/**
 * Read SSE frames, giving up if the stream stalls.
 *
 * `reader.read()` has no timeout of its own, so a half-open socket parks here
 * indefinitely. Racing each read against a timer is what turns that into a
 * reportable `stream_truncated` instead of a permanent spinner.
 */
async function* sseData(
  res: Response,
  idleTimeoutMs: number,
  onStall: () => never,
): AsyncIterable<string> {
  if (!res.body) throw new ProviderError({ kind: "empty_stream", message: "no response body", status: res.status });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = Symbol("stalled");
      const next = await Promise.race([
        reader.read(),
        new Promise<typeof stalled>((resolve) => {
          timer = setTimeout(() => resolve(stalled), idleTimeoutMs);
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
      if (next === stalled) onStall();
      const { done, value } = next;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
  } finally {
    // Releasing the lock lets the abort actually tear the socket down; without
    // it a cancelled turn keeps the connection (and the provider's clock)
    // running after nobody is listening.
    reader.cancel().catch(() => {});
  }
}

function request(cfg: ByokConfig, prompt: string, signal: AbortSignal): Request {
  if (cfg.provider === "openai") {
    return new Request("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        stream: true,
        // Opt in, or the stream ends with no usage frame at all and every
        // OpenAI answer falls back to a character-count estimate.
        stream_options: { include_usage: true },
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
      }),
    });
  }
  if (cfg.provider === "anthropic") {
    return new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: MAX_ANSWER_TOKENS,
        stream: true,
        system: SYSTEM,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:streamGenerateContent?alt=sse&key=${cfg.apiKey}`;
  return new Request(url, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    }),
  });
}

function extractDelta(provider: ByokProvider, data: string): string {
  if (data === "[DONE]") return "";
  try {
    const json = JSON.parse(data) as Record<string, unknown>;
    if (provider === "openai") {
      const choices = json["choices"] as { delta?: { content?: string } }[] | undefined;
      return choices?.[0]?.delta?.content ?? "";
    }
    if (provider === "anthropic") {
      const delta = json["delta"] as { text?: string } | undefined;
      return delta?.text ?? "";
    }
    const candidates = json["candidates"] as { content?: { parts?: { text?: string }[] } }[] | undefined;
    return candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  } catch {
    return "";
  }
}

/**
 * An in-band error frame on an otherwise successful stream.
 *
 * All three providers can return 200, start an SSE stream, and then send an
 * error object instead of content — a mid-stream rate limit or safety stop.
 * Without this the loop yields nothing usable and the turn ends as
 * `empty_stream`, which points the user at their model name when the provider
 * had in fact told us exactly what was wrong.
 */
function frameError(data: string): { readonly message: string } | undefined {
  try {
    const json = JSON.parse(data) as { error?: { message?: string } | string };
    if (!json.error) return undefined;
    const message = typeof json.error === "string" ? json.error : (json.error.message ?? "provider error");
    return { message };
  } catch {
    return undefined;
  }
}

export class ByokGenerator implements AnswerGenerator {
  readonly tier = "byok" as const;
  readonly pack = BYOK_PACK;
  constructor(
    private readonly cfg: ByokConfig,
    private readonly opts: ByokOptions = {},
  ) {}

  availability(): Promise<TierAvailability> {
    return Promise.resolve({
      tier: this.tier,
      state: this.cfg.apiKey ? "available" : "unavailable",
      detail: `${this.cfg.provider} · ${this.cfg.model}`,
    });
  }

  private get where(): string {
    return `${this.cfg.provider} (${this.cfg.model})`;
  }

  /**
   * Attach provider, model, status and the remedy line to a classified failure.
   *
   * The status stays in the message when there is one. It is the part a user can
   * paste into a search or a support thread and get an answer to, and the first
   * version of this method dropped it in favour of the provider's prose — which
   * reads better and is strictly less useful when the prose is an HTML error
   * page with no number in it at all.
   */
  private error(kind: ProviderErrorKind, detail: string, status = 0): ProviderError {
    const remedy = remedyFor(kind);
    const lead = status > 0 ? `${this.where} returned ${status}` : this.where;
    return new ProviderError({
      kind,
      status,
      provider: this.cfg.provider,
      model: this.cfg.model,
      detail,
      message: [`${lead}: ${detail}`, remedy].filter(Boolean).join(" "),
    });
  }

  /**
   * Turn a failed response into a classified error with the provider's words.
   *
   * `res.ok` went unchecked once, and the shape of the failure hid it perfectly:
   * a 400 or 401 returns a JSON error body, `sseData` finds no SSE frames in it,
   * the loop yields nothing, and the turn ended with an empty answer and no
   * error anywhere. A wrong model name or an expired key looked exactly like
   * "the answer didn't render".
   *
   * The provider's own message is the useful part — "model `gpt-5.4-mini` does
   * not exist" tells the user precisely what to change — and it is also what
   * separates a throttle from an exhausted quota, both of which arrive as 429.
   * So the body is read once, used for the message *and* for classification.
   */
  private async failure(res: Response): Promise<ProviderError> {
    let body = "";
    try {
      body = await res.text();
    } catch {
      body = "";
    }
    let detail = "";
    try {
      const json = JSON.parse(body) as { error?: { message?: string } | string };
      detail = typeof json.error === "string" ? json.error : (json.error?.message ?? body.slice(0, 200));
    } catch {
      detail = body.slice(0, 200);
    }
    const kind = kindForResponse(res.status, body);
    return this.error(kind, detail || `returned ${res.status} ${res.statusText}`, res.status);
  }

  /**
   * One attempt: send, check, and hand back the response.
   *
   * The headers deadline lives here rather than around the whole stream. A
   * long answer legitimately takes a minute to finish; a provider that has not
   * sent headers in thirty seconds is not thinking, it is gone.
   */
  private async send(prompt: string, signal: AbortSignal): Promise<Response> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const headersTimeout = this.opts.headersTimeoutMs ?? HEADERS_TIMEOUT_MS;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), headersTimeout);
    const linked = anySignal([signal, deadline.signal]);
    let res: Response;
    try {
      res = await doFetch(request(this.cfg, prompt, linked.signal));
    } catch (error) {
      /**
       * A cross-origin fetch from an extension page is only exempt from CORS if
       * the extension holds a host permission for that origin, and Sherpa
       * requests host permissions per *crawl site* — never for the provider's
       * API. Without the grant the request dies before it reaches OpenAI, and
       * all the platform gives us is `TypeError: Failed to fetch`, which is
       * indistinguishable from being offline. `remedyFor("network")` carries the
       * fix; see `permissions/host.ts` for the same trap on crawl hosts.
       */
      const kind = kindForThrown(error, { cancelled: signal.aborted });
      const origin = new URL(request(this.cfg, "", linked.signal).url).origin;
      throw this.error(
        kind,
        kind === "network"
          ? `could not reach ${origin} (${error instanceof Error ? error.message : String(error)})`
          : kind === "timeout"
            ? `no response headers within ${headersTimeout} ms`
            : (error instanceof Error ? error.message : String(error)),
      );
    } finally {
      clearTimeout(timer);
      linked.dispose();
    }
    if (!res.ok) throw await this.failure(res);
    return res;
  }

  /**
   * Everything a provider call has to survive, in one place.
   *
   * Order matters and is not arbitrary. The breaker is outermost so an open
   * circuit costs nothing at all — checking it after the retry loop would mean
   * sleeping through a schedule before deciding not to call. Retry sits inside
   * it, so a burst of retried failures counts once per attempt towards opening
   * it, which is the signal the breaker wants.
   */
  private async guarded<T>(role: "answer" | "complete", fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const breaker = breakers.get(providerBreakerName(this.cfg.provider, role));
    try {
      breaker.check();
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        throw this.error("circuit_open", `paused after repeated failures (${Math.round(error.openForMs / 1000)}s ago)`);
      }
      throw error;
    }
    /**
     * The spend ceiling, checked per attempt.
     *
     * Inside the breaker and outside the retry loop's individual attempts, so
     * a retry storm counts against it — which is the runaway it is there to
     * stop. Reported as `rate_limited` but never auto-retried: the provider is
     * fine, it is Sherpa that has decided to stop, and retrying our own limit
     * automatically would defeat it.
     */
    const limiter = this.opts.limiter ?? providerLimiter;
    try {
      limiter.check();
    } catch (error) {
      if (error instanceof RateLimitedError) {
        throw new ProviderError({
          kind: "rate_limited",
          provider: this.cfg.provider,
          model: this.cfg.model,
          detail: error.message,
          message: error.message,
        });
      }
      throw error;
    }
    const signal = this.opts.signal ?? new AbortController().signal;
    try {
      const out = await retryWithBackoff(
        () => {
          // Re-checked per attempt: a concurrent turn may have tripped the
          // breaker while this one was asleep between retries.
          breaker.check();
          // Recorded, not checked: retries are exactly the runaway the ceiling
          // exists to catch, so they must count — but the ceiling itself is
          // checked once, above, outside the loop that would otherwise retry it.
          limiter.record();
          return fn(signal);
        },
        {
          label: `byok:${role}:${this.cfg.provider}`,
          ...this.opts.retry,
        },
      );
      breaker.recordSuccess();
      return out;
    } catch (error) {
      breaker.record(error);
      throw error;
    }
  }

  async *answer(req: AnswerRequest): AsyncIterable<AnswerChunk> {
    /**
     * The question is redacted on the way out; the retrieved context is not.
     *
     * This is the one moment Sherpa's local-first promise is genuinely
     * suspended, so a card number or a pasted API key typed into the box must
     * not be the thing that leaves. The kinds are narrow (`EGRESS_KINDS`)
     * because an identifier is often the *subject* of a support question and
     * stripping it would send the provider a question nobody asked.
     *
     * The context is deliberately untouched. Those are the user's own indexed
     * pages, which they chose to send, and an email in documentation is usually
     * load-bearing content — "contact support@acme.com" is the answer, not a
     * leak. Masking it would corrupt the grounding to protect data the user
     * published themselves.
     */
    const prompt = buildGroundedPrompt(maskPii(req.query, { kinds: EGRESS_KINDS }), req.context);
    const idleTimeout = this.opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;

    /**
     * Streaming and retrying pull in opposite directions.
     *
     * A retry can only replace an answer nobody has seen. Once a token has
     * reached the panel the text is on screen and being read, so re-running the
     * request would rewrite it mid-sentence — which is why `stream_truncated`
     * is retryable but never `autoRetry`: it is the user's call, not ours.
     *
     * So the retried unit is "connect and get the first token". After that the
     * stream is on its own, and a mid-stream failure is reported as truncation
     * with whatever text arrived left in place.
     */
    let produced = 0;
    let text = "";
    let usage: TokenUsage = ZERO_USAGE;
    const res = await this.guarded("answer", (signal) => this.send(prompt, signal));

    try {
      for await (const data of sseData(res, idleTimeout, () => {
        throw this.error(
          produced > 0 ? "stream_truncated" : "timeout",
          `stopped sending data for ${idleTimeout} ms`,
        );
      })) {
        const framed = frameError(data);
        if (framed) throw this.error(kindForMessage(framed.message), framed.message, 200);
        const reported = usageFromFrame(this.cfg.provider, data);
        if (reported) usage = mergeReported(usage, reported);
        const delta = extractDelta(this.cfg.provider, data);
        if (delta) {
          produced += 1;
          text += delta;
          yield { delta };
        }
      }
    } catch (error) {
      const kind = kindForThrown(error, { cancelled: this.opts.signal?.aborted === true });
      if (kind === "cancelled") throw this.error("cancelled", "stopped at your request");
      if (error instanceof ProviderError) throw error;
      throw this.error(
        produced > 0 ? "stream_truncated" : kind,
        error instanceof Error ? error.message : String(error),
      );
    }

    /**
     * A 200 that streamed nothing usable is still a failure, and silence is the
     * one way it must not be reported. Now classified, so the panel can offer
     * the remedy rather than printing a sentence about response formats.
     */
    if (produced === 0) {
      throw this.error("empty_stream", "accepted the request and returned no answer text");
    }

    /**
     * Report what it cost, preferring the provider's own numbers.
     *
     * The estimate is the fallback for a provider that volunteered nothing —
     * an older endpoint, a proxy that strips the usage frame — and it is
     * flagged as an estimate rather than quietly mixed in with measurements.
     */
    this.opts.onUsage?.(
      usage.promptTokens > 0 || usage.completionTokens > 0
        ? usage
        : {
            promptTokens: estimateTokens(SYSTEM) + estimateTokens(prompt),
            completionTokens: estimateTokens(text),
            estimated: true,
          },
    );
  }

  /**
   * A short prompt with no grounding, for query understanding.
   *
   * Reuses the same streaming request the answer path uses and joins the
   * pieces, rather than adding a second per-provider request shape to keep in
   * step. These prompts produce a sentence or two, so the streaming overhead is
   * irrelevant and the saving in duplicated provider quirks is not.
   *
   * Runs on its own breaker. An answer-sized request failing on context length
   * says nothing about whether a one-line rewrite would work, and letting it
   * block rewriting would silently switch off two settings the user turned on.
   */
  async complete(prompt: string): Promise<string> {
    // Same boundary as `answer`: these prompts are built around the user's own
    // question, so they carry the same exposure.
    const masked = maskPii(prompt, { kinds: EGRESS_KINDS });
    return this.guarded("complete", async (signal) => {
      const res = await this.send(masked, signal);
      const idleTimeout = this.opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
      let out = "";
      let usage: TokenUsage = ZERO_USAGE;
      for await (const data of sseData(res, idleTimeout, () => {
        throw this.error("timeout", `stopped sending data for ${idleTimeout} ms`);
      })) {
        const framed = frameError(data);
        if (framed) throw this.error(kindForMessage(framed.message), framed.message, 200);
        const reported = usageFromFrame(this.cfg.provider, data);
        if (reported) usage = mergeReported(usage, reported);
        out += extractDelta(this.cfg.provider, data);
      }
      /**
       * Counted too, and this is the half that surprises people.
       *
       * Query rewriting and HyDE each add a provider call to *every question*,
       * and they are switched on in Settings with no hint that they cost
       * anything. Attributing them makes that visible instead of leaving an
       * unexplained gap between the answers on screen and the bill.
       */
      this.opts.onUsage?.(
        usage.promptTokens > 0 || usage.completionTokens > 0
          ? usage
          : {
              promptTokens: estimateTokens(SYSTEM) + estimateTokens(masked),
              completionTokens: estimateTokens(out),
              estimated: true,
            },
      );
      return out.trim();
    });
  }
}

/**
 * Combine abort signals, with cleanup.
 *
 * `AbortSignal.any` is Chrome 124+ and this extension supports earlier, so it
 * is polyfilled rather than assumed. The `dispose` matters more than it looks:
 * without removing the listener, every query leaves a permanent reference to
 * its controller on the user's long-lived cancel signal — a leak that grows for
 * as long as the panel stays open.
 */
function anySignal(signals: readonly AbortSignal[]): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const controller = new AbortController();
  const abort = (reason: unknown) => controller.abort(reason);
  const cleanups: (() => void)[] = [];
  for (const s of signals) {
    if (s.aborted) {
      abort(s.reason);
      break;
    }
    const onAbort = () => abort(s.reason);
    s.addEventListener("abort", onAbort, { once: true });
    cleanups.push(() => s.removeEventListener("abort", onAbort));
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const c of cleanups) c();
    },
  };
}

export { policyFor };
