import { describe, it, expect } from "vitest";
import type { RetrievedArticle, RetrievedChunk } from "@/domain/retrieval.js";
import { packContext, NANO_MAX_ARTICLES, NANO_PACK } from "./context.js";

function chunk(vectorId: number, url: string, body: string): RetrievedChunk {
  return {
    indexId: "i",
    vectorId,
    text: body,
    body,
    url,
    anchor: undefined,
    headingPath: "A",
    position: 0,
    title: "A",
    contentHash: "h",
    score: 0.9,
    similarity: 0.6,
    denseRank: 0,
    sparseRank: undefined,
    viaNeighbour: false,
  };
}

function article(id: number, body = "some body text"): RetrievedArticle {
  const url = `https://d/${id}`;
  return {
    url,
    title: `Article ${id}`,
    headingPath: "A",
    rankScore: 1 - id * 0.01,
    similarity: 0.6,
    anchor: undefined,
    chunks: [chunk(id, url, body)],
    body,
  };
}

describe("packContext", () => {
  it("caps the article count for Nano's window (5.8.5)", () => {
    const many = Array.from({ length: 20 }, (_, i) => article(i));
    expect(packContext(many, NANO_PACK)).toHaveLength(NANO_MAX_ARTICLES);
  });

  it("stops at the token budget", () => {
    const heavy = Array.from({ length: 6 }, (_, i) => article(i, "word ".repeat(600)));
    const packed = packContext(heavy, { maxArticles: 6, tokenBudget: 400 });
    expect(packed.length).toBeLessThan(6);
    expect(packed.length).toBeGreaterThan(0); // always send something
  });

  it("keeps the best article even when it alone busts the budget", () => {
    // Sending nothing would guarantee a refusal for a question we can answer.
    const huge = [article(0, "word ".repeat(5000))];
    expect(packContext(huge, { maxArticles: 6, tokenBudget: 10 })).toHaveLength(1);
  });

  it("preserves rank order", () => {
    const articles = [3, 1, 2].map((id) => article(id));
    expect(packContext(articles, NANO_PACK).map((a) => a.url)).toEqual([
      "https://d/3",
      "https://d/1",
      "https://d/2",
    ]);
  });

  it("never splits an article, so a cited passage is always complete", () => {
    const packed = packContext([article(0, "step one. step two. step three.")], NANO_PACK);
    expect(packed[0]?.body).toBe("step one. step two. step three.");
  });
});
