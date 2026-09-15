import { describe, it, expect, vi, afterEach } from "vitest";
import { ByokGenerator } from "./byok.js";
import { ProviderError } from "@/lib/errorKind.js";
import { breakers, CB_FAILURE_THRESHOLD } from "@/lib/breaker.js";
import { RateLimiter, providerLimiter } from "@/lib/rateLimit.js";
import type { RetrievedArticle } from "@/domain/retrieval.js";

/**
 * Both are process-wide by design — a breaker or a spend ceiling every caller
 * can sidestep is neither — so both have to be reset between tests, or the
 * suite's own volume trips the limiter and later tests fail on the ceiling
 * rather than on what they are testing.
 */
afterEach(() => {
  breakers.reset();
  providerLimiter.reset();
});

const CFG = { provider: "openai" as const, model: "gpt-4o-mini", apiKey: "sk-test" };

const ARTICLES: readonly RetrievedArticle[] = [
  {
    url: "https://docs.example.com/a",
    title: "Assets page",
    headingPath: "Help",
    body: "Assets live in the hub.",
    chunks: [],
    score: 1,
    similarity: 0.86,
  } as unknown as RetrievedArticle,
];

/** An SSE body from a list of frames, so tests read like the wire. */
function sse(...frames: readonly string[]): Response {
  const body = frames.map((f) => `data: ${f}\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chunk(text: string): string {
  return JSON.stringify({ choices: [{ delta: { content: text } }] });
}

async function collect(gen: AsyncIterable<{ delta: string }>): Promise<string> {
  let out = "";
  for await (const c of gen) out += c.delta;
  return out;
}

/** No sleeping, and no jitter, so retry tests are deterministic and instant. */
const fastRetry = { sleep: () => Promise.resolve(), random: () => 0.5 };

describe("ByokGenerator.answer", () => {
  it("streams the deltas it is given", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(sse(chunk("Assets "), chunk("live in the hub."), "[DONE]")));
    const gen = new ByokGenerator(CFG, { fetchImpl: fetchImpl as unknown as typeof fetch, retry: fastRetry });
    expect(await collect(gen.answer({ query: "where?", context: ARTICLES }))).toBe(
      "Assets live in the hub.",
    );
  });

  it("classifies a rejected key and does not retry it", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: "Incorrect API key provided" } }), { status: 401 }),
      ),
    );
    const gen = new ByokGenerator(CFG, { fetchImpl: fetchImpl as unknown as typeof fetch, retry: fastRetry });
    const err = await collect(gen.answer({ query: "q", context: ARTICLES })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("auth_invalid");
    // The provider's own words survive, and the remedy is attached.
    expect((err as ProviderError).message).toContain("Incorrect API key provided");
    expect((err as ProviderError).message).toMatch(/API key in Settings/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 and answers on the second attempt", async () => {
    let n = 0;
    const fetchImpl = vi.fn(() => {
      n += 1;
      return Promise.resolve(
        n === 1
          ? new Response(JSON.stringify({ error: { message: "Rate limit reached" } }), { status: 429 })
          : sse(chunk("ok"), "[DONE]"),
      );
    });
    const gen = new ByokGenerator(CFG, { fetchImpl: fetchImpl as unknown as typeof fetch, retry: fastRetry });
    expect(await collect(gen.answer({ query: "q", context: ARTICLES }))).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("stops immediately on an exhausted quota even though it is also a 429", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: "insufficient_quota", message: "You exceeded your current quota" } }), {
          status: 429,
        }),
      ),
    );
    const gen = new ByokGenerator(CFG, { fetchImpl: fetchImpl as unknown as typeof fetch, retry: fastRetry });
    const err = await collect(gen.answer({ query: "q", context: ARTICLES })).catch((e: unknown) => e);
    expect((err as ProviderError).kind).toBe("quota_exhausted");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports a 200 that streamed nothing rather than an empty answer", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(sse("[DONE]")));
    const gen = new ByokGenerator(CFG, { fetchImpl: fetchImpl as unknown as typeof fetch, retry: { ...fastRetry, attempts: 1 } });
    const err = await collect(gen.answer({ query: "q", context: ARTICLES })).catch((e: unknown) => e);
    expect((err as ProviderError).kind).toBe("empty_stream");
  });

  it("surfaces an in-band error frame on an otherwise successful stream", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(sse(JSON.stringify({ error: { message: "Rate limit reached mid-stream" } }))),
    );
    const gen = new ByokGenerator(CFG, { fetchImpl: fetchImpl as unknown as typeof fetch, retry: { ...fastRetry, attempts: 1 } });
    const err = await collect(gen.answer({ query: "q", context: ARTICLES })).catch((e: unknown) => e);
    expect((err as ProviderError).kind).toBe("rate_limited");
    expect((err as ProviderError).detail).toContain("mid-stream");
  });

  it("treats a missing host permission as network, with the grant-access remedy", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
    const gen = new ByokGenerator(CFG, { fetchImpl: fetchImpl as unknown as typeof fetch, retry: { ...fastRetry, attempts: 1 } });
    const err = await collect(gen.answer({ query: "q", context: ARTICLES })).catch((e: unknown) => e);
    expect((err as ProviderError).kind).toBe("network");
    expect((err as ProviderError).message).toMatch(/Grant access/i);
  });

  it("reports a hang as a timeout instead of streaming forever", async () => {
    // A fetch that never settles is exactly the failure that used to strand a
    // turn in "writing…" with no way out.
    const fetchImpl = vi.fn(
      (req: Request) =>
        new Promise<Response>((_resolve, reject) => {
          req.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const gen = new ByokGenerator(CFG, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      headersTimeoutMs: 10,
      retry: { ...fastRetry, attempts: 1 },
    });
    const err = await collect(gen.answer({ query: "q", context: ARTICLES })).catch((e: unknown) => e);
    expect((err as ProviderError).kind).toBe("timeout");
  });

  it("reports the user's own stop as cancelled, silently", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (req: Request) =>
        new Promise<Response>((_resolve, reject) => {
          req.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const gen = new ByokGenerator(CFG, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      signal: controller.signal,
      retry: { ...fastRetry, attempts: 1 },
    });
    const promise = collect(gen.answer({ query: "q", context: ARTICLES })).catch((e: unknown) => e);
    controller.abort();
    const err = await promise;
    expect((err as ProviderError).kind).toBe("cancelled");
    expect((err as ProviderError).policy.presentation).toBe("silent");
  });

  it("keeps the text already streamed and calls a mid-stream stall a truncation", async () => {
    const fetchImpl = vi.fn(() => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${chunk("Half an ans")}\n`));
          // …and then never another byte, and never a close.
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    });
    const gen = new ByokGenerator(CFG, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      idleTimeoutMs: 10,
      retry: { ...fastRetry, attempts: 1 },
    });
    let seen = "";
    const err = await (async () => {
      try {
        for await (const c of gen.answer({ query: "q", context: ARTICLES })) seen += c.delta;
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(seen).toBe("Half an ans");
    expect((err as ProviderError).kind).toBe("stream_truncated");
    // Never auto-retried: it would rewrite text the user is already reading.
    expect((err as ProviderError).policy.autoRetry).toBe(false);
  });
});

describe("the provider breaker", () => {
  it("stops calling out after repeated outages, then fails fast", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("upstream down", { status: 503 })));
    const gen = new ByokGenerator(CFG, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retry: { ...fastRetry, attempts: 1 },
    });
    for (let i = 0; i < CB_FAILURE_THRESHOLD; i += 1) {
      await collect(gen.answer({ query: "q", context: ARTICLES })).catch(() => {});
    }
    const calls = fetchImpl.mock.calls.length;
    const err = await collect(gen.answer({ query: "q", context: ARTICLES })).catch((e: unknown) => e);
    expect((err as ProviderError).kind).toBe("circuit_open");
    // The whole point: the next question costs no network at all.
    expect(fetchImpl.mock.calls.length).toBe(calls);
  });

  it("keeps query understanding working when the answer path is broken", async () => {
    // A context-length rejection on answering says nothing about a one-line
    // rewrite, so the two must not share a breaker.
    const fetchImpl = vi.fn((req: Request) => {
      const body = String((req as unknown as { bodyUsed?: boolean }) && "");
      void body;
      return Promise.resolve(new Response("upstream down", { status: 503 }));
    });
    const gen = new ByokGenerator(CFG, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retry: { ...fastRetry, attempts: 1 },
    });
    for (let i = 0; i < CB_FAILURE_THRESHOLD; i += 1) {
      await collect(gen.answer({ query: "q", context: ARTICLES })).catch(() => {});
    }
    const before = fetchImpl.mock.calls.length;
    await gen.complete("rewrite this").catch(() => {});
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(before);
  });
});

describe("usage accounting", () => {
  it("prefers the provider's reported usage over an estimate", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        sse(chunk("ok"), JSON.stringify({ usage: { prompt_tokens: 901, completion_tokens: 17 } }), "[DONE]"),
      ),
    );
    const onUsage = vi.fn();
    const gen = new ByokGenerator(CFG, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retry: fastRetry,
      onUsage,
    });
    await collect(gen.answer({ query: "q", context: ARTICLES }));
    expect(onUsage).toHaveBeenCalledWith({ promptTokens: 901, completionTokens: 17, estimated: false });
  });

  it("asks OpenAI for a usage frame, which it does not send otherwise", async () => {
    // Typed parameter so the recorded call can be read back.
    const fetchImpl = vi.fn((_req: Request) => Promise.resolve(sse(chunk("ok"), "[DONE]")));
    const gen = new ByokGenerator(CFG, { fetchImpl: fetchImpl as unknown as typeof fetch, retry: fastRetry });
    await collect(gen.answer({ query: "q", context: ARTICLES }));
    const sent = fetchImpl.mock.calls[0]?.[0];
    const body = JSON.parse(await sent!.text()) as Record<string, unknown>;
    expect(body["stream_options"]).toEqual({ include_usage: true });
  });

  it("falls back to an estimate, flagged as one, when nothing is reported", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(sse(chunk("some answer text"), "[DONE]")));
    const onUsage = vi.fn();
    const gen = new ByokGenerator(CFG, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retry: fastRetry,
      onUsage,
    });
    await collect(gen.answer({ query: "q", context: ARTICLES }));
    expect(onUsage.mock.calls[0]?.[0]).toMatchObject({ estimated: true });
    expect(onUsage.mock.calls[0]?.[0].completionTokens).toBeGreaterThan(0);
  });

  it("reports nothing when the call failed — a failure has no cost to attribute", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("nope", { status: 401 })));
    const onUsage = vi.fn();
    const gen = new ByokGenerator(CFG, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retry: fastRetry,
      onUsage,
    });
    await collect(gen.answer({ query: "q", context: ARTICLES })).catch(() => {});
    expect(onUsage).not.toHaveBeenCalled();
  });
});

describe("the spend ceiling", () => {
  it("stops calling out once the window is full, and says why", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(sse(chunk("ok"), "[DONE]")));
    const limiter = new RateLimiter({ max: 2, windowMs: 60_000 }, () => 0);
    const gen = new ByokGenerator(CFG, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retry: fastRetry,
      limiter,
    });
    await collect(gen.answer({ query: "q", context: ARTICLES }));
    await collect(gen.answer({ query: "q", context: ARTICLES }));
    const err = await collect(gen.answer({ query: "q", context: ARTICLES })).catch((e: unknown) => e);
    expect((err as ProviderError).kind).toBe("rate_limited");
    expect((err as ProviderError).message).toMatch(/your bill/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("counts a retry storm against the ceiling without retrying the ceiling itself", async () => {
    // The bug this guards: `rate_limited` is auto-retryable by policy, so a
    // limiter checked inside the retry loop would have Sherpa retrying its own
    // refusal to spend money.
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("down", { status: 503 })));
    const limiter = new RateLimiter({ max: 3, windowMs: 60_000 }, () => 0);
    const gen = new ByokGenerator(CFG, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retry: { ...fastRetry, attempts: 3 },
      limiter,
    });
    await collect(gen.answer({ query: "q", context: ARTICLES })).catch(() => {});
    // Three attempts consumed the whole window.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(limiter.remaining()).toBe(0);
  });
});

describe("what leaves the device", () => {
  /** Read back the prompt that actually went over the wire. */
  async function sentPrompt(calls: readonly (readonly [Request])[]): Promise<string> {
    const body = JSON.parse(await calls[0]![0].text()) as { messages?: { content?: string }[] };
    return body.messages?.map((m) => m.content ?? "").join("\n") ?? "";
  }

  it("redacts an email typed into the question before sending it", async () => {
    const fetchImpl = vi.fn((_req: Request) => Promise.resolve(sse(chunk("ok"), "[DONE]")));
    const gen = new ByokGenerator(CFG, { fetchImpl: fetchImpl as unknown as typeof fetch, retry: fastRetry });
    await collect(gen.answer({ query: "why can't sarah.chen@acme.com log in", context: ARTICLES }));
    const prompt = await sentPrompt(fetchImpl.mock.calls);
    expect(prompt).not.toContain("sarah.chen@acme.com");
    expect(prompt).toContain("[email]");
  });

  it("leaves the indexed pages untouched — that content is the answer", async () => {
    // An email in documentation is usually load-bearing: "contact
    // support@acme.com" *is* the answer. Masking it to protect data the user
    // published themselves would corrupt the grounding for nothing.
    const withEmail = [{ ...ARTICLES[0], body: "Write to support@acme.com for help." }] as typeof ARTICLES;
    const fetchImpl = vi.fn((_req: Request) => Promise.resolve(sse(chunk("ok"), "[DONE]")));
    const gen = new ByokGenerator(CFG, { fetchImpl: fetchImpl as unknown as typeof fetch, retry: fastRetry });
    await collect(gen.answer({ query: "who do I contact", context: withEmail }));
    expect(await sentPrompt(fetchImpl.mock.calls)).toContain("support@acme.com");
  });

  it("redacts a pasted API key rather than forwarding it to a different provider", async () => {
    const fetchImpl = vi.fn((_req: Request) => Promise.resolve(sse(chunk("ok"), "[DONE]")));
    const gen = new ByokGenerator(CFG, { fetchImpl: fetchImpl as unknown as typeof fetch, retry: fastRetry });
    await collect(gen.answer({ query: "is sk-abcdefghij0123456789 still valid", context: ARTICLES }));
    expect(await sentPrompt(fetchImpl.mock.calls)).not.toContain("sk-abcdefghij0123456789");
  });
});
