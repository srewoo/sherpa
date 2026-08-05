import { describe, it, expect } from "vitest";
import type { RetrievedArticle, RetrievedChunk } from "@/domain/retrieval.js";
import type { RetrieveResult } from "@/retrieval/retrieve.js";
import { answerQuery, isRefusal, type AnswerEvent } from "./answerService.js";
import { REFUSAL_TEXT } from "./prompt.js";
import { ExtractiveGenerator } from "./extractive.js";

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
