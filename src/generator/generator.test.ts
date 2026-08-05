import { describe, it, expect, afterEach } from "vitest";
import { ByokGenerator } from "./byok.js";
import type { RetrievedArticle, RetrievedChunk } from "@/domain/retrieval.js";
import type { AnswerGenerator, AnswerRequest } from "@/domain/generator.js";
import { buildGroundedPrompt, formatContext, REFUSAL_TEXT } from "./prompt.js";
import { ExtractiveGenerator } from "./extractive.js";
import { NanoGenerator } from "./nano.js";
import { byokIssue, selectGenerator } from "./select.js";

function hit(vectorId: number, body: string, headingPath = "Admin > SSO"): RetrievedArticle {
  const chunk: RetrievedChunk = {
    indexId: "i", vectorId, text: body, body, url: `https://d/${vectorId}`, anchor: undefined,
    headingPath, position: vectorId, title: headingPath.split(" > ").pop() ?? "Doc",
    contentHash: `h${vectorId}`, score: 1 - vectorId * 0.1, similarity: 1 - vectorId * 0.1,
    denseRank: vectorId, sparseRank: vectorId, viaNeighbour: false,
  };
  return {
    url: chunk.url, title: chunk.title, headingPath, rankScore: 1 - vectorId * 0.1,
    similarity: 1 - vectorId * 0.1, anchor: undefined, chunks: [chunk], body,
  };
}

async function collect(gen: AsyncIterable<{ delta: string }>): Promise<string> {
  let out = "";
  for await (const c of gen) out += c.delta;
  return out;
}

describe("buildGroundedPrompt", () => {
  const chunks = [hit(0, "Set the audience URL in Admin."), hit(1, "Then enable SAML.")];
  it("embeds numbered context, the question, and the refusal instruction", () => {
    const p = buildGroundedPrompt("how do I set up SSO?", chunks);
    // Context is numbered per article, and labelled by article title with its
    // heading path — the same enumeration the source cards use.
    expect(p).toContain("[1] SSO — Admin > SSO");
    expect(p).toContain("Set the audience URL");
    expect(p).toContain("QUESTION: how do I set up SSO?");
    expect(p).toContain(REFUSAL_TEXT);
  });

  it("formatContext numbers every chunk", () => {
    expect(formatContext(chunks)).toMatch(/\[1\][\s\S]*\[2\]/);
  });
});

describe("ExtractiveGenerator", () => {
  const gen: AnswerGenerator = new ExtractiveGenerator();

  it("reports available on every machine", async () => {
    expect(await gen.availability()).toEqual({ tier: "extractive", state: "available" });
  });

  it("surfaces the best-matching sentence with a citation marker", async () => {
    const req: AnswerRequest = {
      query: "rotate api key",
      context: [
        hit(0, "You can rotate an api key from Admin. Unrelated sentence about billing."),
      ],
    };
    const text = await collect(gen.answer(req));
    expect(text).toContain("rotate an api key");
    expect(text).toContain("[1]");
    expect(text).not.toContain("billing"); // low-overlap sentence dropped
  });

  it("refuses when there is no direct context", async () => {
    const text = await collect(gen.answer({ query: "x", context: [] }));
    expect(text).toContain("don't have that in this index");
  });
});

describe("Nano session language (Chrome Prompt API)", () => {
  /**
   * Chrome logs "An output language should be specified… properly attest to
   * output safety" when a session is created without one, and documents lower
   * output quality in that case. Easy to drop in a refactor, so it's asserted.
   */
  function stubLanguageModel() {
    const calls: { availability: unknown[]; create: unknown[] } = { availability: [], create: [] };
    (globalThis as Record<string, unknown>)["LanguageModel"] = {
      availability: async (options?: unknown) => {
        calls.availability.push(options);
        return "available" as const;
      },
      create: async (options?: unknown) => {
        calls.create.push(options);
        return {
          // eslint-disable-next-line require-yield
          async *promptStreaming() {
            yield "ok";
          },
          async prompt() {
            return "ok";
          },
          destroy() {},
        };
      },
    };
    return calls;
  }

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)["LanguageModel"];
  });

  it("declares English for input and output when creating a session", async () => {
    const calls = stubLanguageModel();
    const nano = new NanoGenerator();

    for await (const _ of nano.answer({ query: "q", context: [] })) {
      // drain
    }

    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]).toMatchObject({
      expectedInputs: [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }],
    });
  });

  it("asks about availability with the same options the session will use", async () => {
    const calls = stubLanguageModel();
    await new NanoGenerator().availability();
    expect(calls.availability[0]).toMatchObject({
      expectedOutputs: [{ type: "text", languages: ["en"] }],
    });
  });

  it("reports unavailable when the API is absent", async () => {
    delete (globalThis as Record<string, unknown>)["LanguageModel"];
    expect((await new NanoGenerator().availability()).state).toBe("unavailable");
  });
});

/**
 * The bug: selecting OpenAI without a saved key fell back to Nano and said
 * nothing, so Settings showed one thing and the panel showed another with no
 * way to tell which was true.
 */
describe("byokIssue", () => {
  const full = { mode: "byok" as const, provider: "openai" as const, model: "gpt-4o", apiKey: "sk-x" };

  it("is silent when BYOK is fully configured", () => {
    expect(byokIssue(full)).toBeNull();
  });

  it("is silent in auto mode, where BYOK isn't wanted", () => {
    expect(byokIssue({ mode: "auto" })).toBeNull();
  });

  it("names a missing key, and the provider it was missing for", () => {
    const issue = byokIssue({ ...full, apiKey: "" });
    expect(issue).toContain("API key");
    expect(issue).toContain("openai");
  });

  it("treats a whitespace-only key as missing", () => {
    expect(byokIssue({ ...full, apiKey: "   " })).toContain("API key");
  });

  it("names a missing model", () => {
    const { model: _omitted, ...withoutModel } = full;
    expect(byokIssue(withoutModel)).toContain("model");
  });
});

describe("selectGenerator", () => {
  it("uses BYOK when it is configured, with nothing to report", async () => {
    const choice = await selectGenerator({
      mode: "byok",
      provider: "openai",
      model: "gpt-4o",
      apiKey: "sk-x",
    });
    expect(choice.generator.tier).toBe("byok");
    expect(choice.notice).toBeUndefined();
  });

  it("explains itself when it falls back from an unusable BYOK selection", async () => {
    const choice = await selectGenerator({ mode: "byok", provider: "openai", model: "gpt-4o" });
    expect(choice.generator.tier).not.toBe("byok");
    expect(choice.notice).toContain("API key");
  });

  it("stays quiet in auto mode — no fallback happened", async () => {
    expect((await selectGenerator({ mode: "auto" })).notice).toBeUndefined();
  });

  it("trims a pasted key rather than failing on trailing whitespace", async () => {
    const choice = await selectGenerator({
      mode: "byok",
      provider: "openai",
      model: "gpt-4o",
      apiKey: "  sk-x  ",
    });
    expect(choice.generator.tier).toBe("byok");
  });
});

/**
 * Query understanding (HyDE, query rewriting) needs a model but not the
 * grounded answering behaviour, so it goes through `complete`. The bug this
 * guards: both features called Chrome's Nano directly, so with a BYOK key
 * configured and Nano unavailable — the usual case — they silently did nothing.
 */
describe("generator.complete (query understanding)", () => {
  it("is absent on the Extractive tier, which has no model", () => {
    // Not a gap: the features must stay off here rather than pretend to run.
    // Typed as the interface, which is how the caller sees it.
    const tier: AnswerGenerator = new ExtractiveGenerator();
    expect(tier.complete).toBeUndefined();
  });

  it("is present on BYOK, so query understanding works with a key", () => {
    const g = new ByokGenerator({ provider: "openai", model: "gpt-4o", apiKey: "sk-test" });
    expect(typeof g.complete).toBe("function");
  });

  it("returns the joined stream rather than a stream", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"two way "}}]}',
      'data: {"choices":[{"delta":{"content":"role play"}}]}',
      "data: [DONE]",
    ].join("\n\n");
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(new Blob([chunks]).stream(), { status: 200 })) as typeof fetch;
    try {
      const g = new ByokGenerator({ provider: "openai", model: "gpt-4o", apiKey: "sk-test" });
      expect(await g.complete!("rewrite this")).toBe("two way role play");
    } finally {
      globalThis.fetch = original;
    }
  });
});
