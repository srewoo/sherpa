import { describe, it, expect } from "vitest";
import type { RetrievedChunk } from "@/domain/retrieval.js";
import type { RetrieveResult } from "@/retrieval/retrieve.js";
import { answerQuery, type AnswerEvent } from "./answerService.js";
import { ExtractiveGenerator } from "./extractive.js";

function hit(id: number, viaNeighbour = false): RetrievedChunk {
  return {
    indexId: "i", vectorId: id, text: `body ${id} rotate api key`, body: `body ${id} rotate api key`,
    url: "https://d/x", anchor: undefined, headingPath: "Docs", position: id, title: "Docs",
    contentHash: `h${id}`, score: 0.8, denseRank: id, sparseRank: id, viaNeighbour,
  };
}

async function drain(gen: AsyncIterable<AnswerEvent>): Promise<AnswerEvent[]> {
  const out: AnswerEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const gen = new ExtractiveGenerator();

describe("answerQuery", () => {
  it("emits sources, streams deltas, then done when above the floor", async () => {
    const retrieve = async (): Promise<RetrieveResult> => ({ chunks: [hit(0), hit(1, true)], topScore: 0.8 });
    const events = await drain(answerQuery({ retrieve, generator: gen, floor: 0.45 }, "rotate api key"));
    expect(events[0]?.kind).toBe("sources");
    expect(events.some((e) => e.kind === "delta")).toBe(true);
    expect(events.at(-1)?.kind).toBe("done");
    const sources = events[0] as Extract<AnswerEvent, { kind: "sources" }>;
    expect(sources.tier).toBe("extractive");
    expect(sources.sources).toHaveLength(1); // neighbour excluded from source cards
  });

  it("refuses below the floor without generating", async () => {
    const retrieve = async (): Promise<RetrieveResult> => ({ chunks: [hit(0)], topScore: 0.2 });
    const events = await drain(answerQuery({ retrieve, generator: gen, floor: 0.45 }, "unknown"));
    expect(events[0]?.kind).toBe("refusal");
    expect(events.some((e) => e.kind === "delta")).toBe(false);
  });
});
