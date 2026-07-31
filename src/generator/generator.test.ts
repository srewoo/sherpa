import { describe, it, expect } from "vitest";
import type { RetrievedChunk } from "@/domain/retrieval.js";
import type { AnswerGenerator, AnswerRequest } from "@/domain/generator.js";
import { buildGroundedPrompt, formatContext, REFUSAL_TEXT } from "./prompt.js";
import { ExtractiveGenerator } from "./extractive.js";

function hit(vectorId: number, body: string, headingPath = "Admin > SSO"): RetrievedChunk {
  return {
    indexId: "i", vectorId, text: body, body, url: "https://d/x", anchor: undefined,
    headingPath, position: vectorId, title: "SSO", contentHash: `h${vectorId}`,
    score: 1 - vectorId * 0.1, denseRank: vectorId, sparseRank: vectorId, viaNeighbour: false,
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
    expect(p).toContain("[1] Admin > SSO");
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
