import { describe, it, expect } from "vitest";
import type { RetrievedArticle, RetrievedChunk } from "@/domain/retrieval.js";
import type { RetrieveResult } from "@/retrieval/retrieve.js";
import { answerQuery, isRefusal, type AnswerEvent } from "./answerService.js";
import { REFUSAL_TEXT } from "./prompt.js";
import { ExtractiveGenerator } from "./extractive.js";
import type { AnswerGenerator } from "@/domain/generator.js";

function chunk(id: number, viaNeighbour = false): RetrievedChunk {
  return {
    indexId: "i", vectorId: id, text: `body ${id} rotate api key`, body: `body ${id} rotate api key`,
    url: `https://d/${id}`, anchor: undefined, headingPath: "Docs", position: id, title: "Docs",
    contentHash: `h${id}`, score: 0.8, similarity: 0.8, denseRank: id, sparseRank: id, viaNeighbour,
  };
}

function hit(id: number): RetrievedArticle {
  const c = chunk(id);
  return {
    url: c.url, title: `Doc ${id}`, headingPath: "Docs", rankScore: 0.9, similarity: 0.8,
    anchor: undefined, chunks: [c], body: c.body,
  };
}

async function drain(gen: AsyncIterable<AnswerEvent>): Promise<AnswerEvent[]> {
  const out: AnswerEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const gen = new ExtractiveGenerator();

/** A generator that emits exactly the text given, for refusal detection. */
function stub(text: string) {
  return {
    tier: "nano" as const,
    pack: { maxArticles: 8, tokenBudget: 100000 },
    availability: async () => ({ tier: "nano" as const, state: "available" as const }),
    async *answer() {
      yield { delta: text };
    },
  };
}

describe("answerQuery", () => {
  it("emits sources, streams deltas, then done when above the floor", async () => {
    const retrieve = async (): Promise<RetrieveResult> => ({ articles: [hit(0), hit(1)], topScore: 0.8, denseAvailable: true });
    const events = await drain(answerQuery({ retrieve, generator: gen, floors: { refuse: 0.45, confident: 0.45 } }, "rotate api key"));
    expect(events[0]?.kind).toBe("sources");
    expect(events.some((e) => e.kind === "delta")).toBe(true);
    expect(events.at(-1)?.kind).toBe("done");
    const sources = events[0] as Extract<AnswerEvent, { kind: "sources" }>;
    expect(sources.tier).toBe("extractive");
    expect(sources.sources).toHaveLength(2); // neighbour excluded from source cards
  });

  it("refuses below the floor without generating", async () => {
    const retrieve = async (): Promise<RetrieveResult> => ({ articles: [hit(0)], topScore: 0.2, denseAvailable: true });
    const events = await drain(answerQuery({ retrieve, generator: gen, floors: { refuse: 0.45, confident: 0.45 } }, "unknown"));
    expect(events[0]?.kind).toBe("refusal");
    expect(events.some((e) => e.kind === "delta")).toBe(false);
  });
});

describe("model refusal (regression: 'I don't have that' above six sources)", () => {
  it("converts the model's own refusal into a refusal state", async () => {
    // Retrieval cleared the floors: { refuse: floor, confident: floor }, so sources were emitted — but Nano then
    // decided the context didn't answer the question. Showing both is a
    // contradiction; the model's judgement wins (PRD 5.8.8).
    const events = await drain(
      answerQuery(
        {
          retrieve: async () => ({ articles: [hit(1), hit(2)], topScore: 0.7, denseAvailable: true }),
          generator: stub("I don't have that in this index."),
          floors: { refuse: 0.45, confident: 0.45 },
        },
        "how do I create a 2 way role play",
      ),
    );
    expect(events.map((e) => e.kind)).toEqual(["sources", "delta", "refusal", "done"]);
  });

  it("leaves a real answer alone", async () => {
    const events = await drain(
      answerQuery(
        {
          retrieve: async () => ({ articles: [hit(1)], topScore: 0.7, denseAvailable: true }),
          generator: stub("1. Open Admin.\n2. Click New."),
          floors: { refuse: 0.45, confident: 0.45 },
        },
        "how do I start",
      ),
    );
    expect(events.some((e) => e.kind === "refusal")).toBe(false);
  });

  it("does not treat a passing mention as a refusal", async () => {
    const long =
      "You can do this from Admin. If the option is missing, I don't have that in this index for older tenants, so check the release notes and contact support for the legacy flow.";
    const events = await drain(
      answerQuery(
        {
          retrieve: async () => ({ articles: [hit(1)], topScore: 0.7, denseAvailable: true }),
          generator: stub(long),
          floors: { refuse: 0.45, confident: 0.45 },
        },
        "q",
      ),
    );
    expect(events.some((e) => e.kind === "refusal")).toBe(false);
  });
});

describe("isRefusal", () => {
  it("matches the sentinel in its usual forms", () => {
    expect(isRefusal("I don't have that in this index.")).toBe(true);
    expect(isRefusal("  I don't have that in this index  ")).toBe(true);
  });

  it("ignores empty and substantive answers", () => {
    expect(isRefusal("")).toBe(false);
    expect(isRefusal("Open Admin > SSO and upload metadata.")).toBe(false);
  });
});

/**
 * The bug this guards: both refusal paths emitted the same event, and the panel
 * hard-coded the floor explanation — so a refusal the *model* made was reported
 * as "nothing scored above the confidence floor", directly above three sources
 * reading 75%. The user can see both numbers; only one claim can be true.
 */
describe("refusal reason", () => {
  const article = (score: number): RetrievedArticle => ({
    url: "https://d/a",
    title: "A",
    headingPath: "A",
    rankScore: score,
    similarity: score,
    anchor: undefined,
    chunks: [],
    body: "some text",
  });

  const run = async (
    topScore: number,
    modelOutput: string,
    floor = 0.4,
  ): Promise<AnswerEvent[]> => {
    const events: AnswerEvent[] = [];
    for await (const e of answerQuery(
      {
        retrieve: async () => ({ articles: [article(topScore)], topScore, denseAvailable: true }),
        generator: {
          tier: "nano",
          pack: { maxArticles: 8, tokenBudget: 100000 },
          availability: async () => ({ tier: "nano", state: "available" }),
          // eslint-disable-next-line require-yield
          answer: async function* () {
            yield { delta: modelOutput };
          },
        },
        floors: { refuse: floor, confident: floor },
      },
      "q",
    )) {
      events.push(e);
    }
    return events;
  };

  const refusalOf = (events: readonly AnswerEvent[]) =>
    events.find((e) => e.kind === "refusal");

  it("blames the floor only when the floor actually rejected it", async () => {
    const refusal = refusalOf(await run(0.2, "unused"));
    expect(refusal).toBeDefined();
    expect(refusal!.kind === "refusal" && refusal!.reason).toBe("below-floor");
  });

  it("attributes a model refusal to the model, not the floor", async () => {
    const refusal = refusalOf(await run(0.75, REFUSAL_TEXT));
    expect(refusal).toBeDefined();
    expect(refusal!.kind === "refusal" && refusal!.reason).toBe("model-declined");
  });

  it("reports the score that was actually reached alongside the reason", async () => {
    const refusal = refusalOf(await run(0.75, REFUSAL_TEXT));
    // A "model-declined" refusal must not carry a score that looks like a miss.
    expect(refusal!.kind === "refusal" && refusal!.topScore).toBe(0.75);
  });

  it("does not refuse at all when the model answers", async () => {
    expect(refusalOf(await run(0.75, "Here are the steps: 1. Do it."))).toBeUndefined();
  });
});

describe("facet does not hold up the turn", () => {
  const GEN: AnswerGenerator = {
    tier: "extractive",
    pack: { maxArticles: 8, tokenBudget: 100000 },
    availability: async () => ({ tier: "extractive" as const, state: "available" as const }),
    async *answer() {
      yield { delta: "text" };
    },
  };

  function article(url: string, title: string, similarity: number): RetrievedArticle {
    return {
      url,
      title,
      headingPath: title,
      rankScore: similarity,
      similarity,
      anchor: undefined,
      chunks: [],
      body: "b",
    };
  }

  /** Tightly clustered in absolute cosine, so refinements are offered. */
  const SCATTERED = [
    article("https://h/a", "Gong dialer", 0.72),
    article("https://h/b", "Zoom Phone", 0.71),
    article("https://h/c", "Mobile capture", 0.7),
  ];

  const baseDeps = {
    retrieve: async () => ({ articles: SCATTERED, topScore: 0.72, denseAvailable: true }),
    generator: GEN,
    floors: { refuse: 0.4, confident: 0.65 },
  };

  /**
   * `done` is load-bearing: the panel clears the streaming state, persists the
   * turn and detaches its listener on it. `byok.ts` has no AbortSignal, so an
   * unbounded await on a hung provider left a finished answer stuck in
   * "writing…" forever and leaked the listener.
   */
  it("emits done even when the facet call never resolves", async () => {
    const kinds: string[] = [];
    for await (const event of answerQuery(
      { ...baseDeps, facetTimeoutMs: 20, deriveFacet: () => new Promise(() => {}) },
      "how to record a call?",
    )) {
      kinds.push(event.kind);
    }
    expect(kinds).toContain("refine");
    expect(kinds[kinds.length - 1]).toBe("done");
  });

  /** Timing out costs the nicer question, never the chips. */
  it("falls back to title chips when the facet times out", async () => {
    let refine: { options: readonly unknown[]; facet?: unknown } | undefined;
    for await (const event of answerQuery(
      { ...baseDeps, facetTimeoutMs: 20, deriveFacet: () => new Promise(() => {}) },
      "q",
    )) {
      if (event.kind === "refine") refine = event;
    }
    expect(refine?.options).toHaveLength(3);
    expect(refine?.facet).toBeUndefined();
  });

  it("uses the facet when it arrives in time", async () => {
    let refine: { facet?: { question: string } } | undefined;
    for await (const event of answerQuery(
      {
        ...baseDeps,
        deriveFacet: async () => ({
          question: "Which platform?",
          options: [{ label: "Zoom", url: "https://h/b" }],
        }),
      },
      "q",
    )) {
      if (event.kind === "refine") refine = event;
    }
    expect(refine?.facet?.question).toBe("Which platform?");
  });
});

describe("citations match what grounded the answer", () => {
  function art(i: number): RetrievedArticle {
    return {
      url: `https://h/${i}`,
      title: `Page ${i}`,
      headingPath: `Page ${i}`,
      rankScore: 1 - i / 100,
      similarity: 0.8 - i / 100,
      anchor: undefined,
      chunks: [],
      body: `body of page ${i}`,
    };
  }
  const EIGHT = Array.from({ length: 8 }, (_, i) => art(i));

  function generator(maxArticles: number): AnswerGenerator {
    return {
      tier: "nano",
      pack: { maxArticles, tokenBudget: 100_000 },
      availability: async () => ({ tier: "nano" as const, state: "available" as const }),
      async *answer() {
        yield { delta: "ok" };
      },
    };
  }

  async function sourcesFor(maxArticles: number): Promise<number> {
    const deps = {
      retrieve: async () => ({ articles: EIGHT, topScore: 0.8, denseAvailable: true }),
      generator: generator(maxArticles),
      floors: { refuse: 0.4, confident: 0.65 },
    };
    for await (const event of answerQuery(deps, "q")) {
      if (event.kind === "sources") return event.sources.length;
    }
    return -1;
  }

  /**
   * The failure: generators packed privately, so the panel rendered a card for
   * every assembled article while the model had been sent only the first few.
   * Card [5] could name a page the answer was never grounded in — a citation
   * that cannot be checked, which is exactly what `markdown.ts` bounds
   * out-of-range markers to prevent, reached from the other direction.
   */
  it("shows only the sources the model was actually given", async () => {
    expect(await sourcesFor(4)).toBe(4);
    expect(await sourcesFor(8)).toBe(8);
  });

  /** The generator receives the same list, not the unpacked one. */
  it("hands the generator exactly the cited articles", async () => {
    let received = -1;
    const gen: AnswerGenerator = {
      ...generator(3),
      async *answer(req) {
        received = req.context.length;
        yield { delta: "ok" };
      },
    };
    const deps = {
      retrieve: async () => ({ articles: EIGHT, topScore: 0.8, denseAvailable: true }),
      generator: gen,
      floors: { refuse: 0.4, confident: 0.65 },
    };
    let shown = -1;
    for await (const event of answerQuery(deps, "q")) {
      if (event.kind === "sources") shown = event.sources.length;
    }
    expect(received).toBe(3);
    expect(shown).toBe(3);
  });
});
