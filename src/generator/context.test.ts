import { describe, it, expect } from "vitest";
import type { RetrievedChunk } from "@/domain/retrieval.js";
import { packContext, NANO_MAX_CHUNKS, NANO_PACK } from "./context.js";

function chunk(over: Partial<RetrievedChunk> & { vectorId: number }): RetrievedChunk {
  return {
    indexId: "i",
    text: "t",
    body: "some body text",
    url: "https://d/a",
    anchor: undefined,
    headingPath: "A",
    position: 0,
    title: "A",
    contentHash: "h",
    score: 1,
    denseRank: 0,
    sparseRank: undefined,
    viaNeighbour: false,
    ...over,
  };
}

describe("packContext", () => {
  it("caps the chunk count for Nano's window (5.8.5)", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      chunk({ vectorId: i, url: `https://d/${i}` }),
    );
    expect(packContext(many, NANO_PACK)).toHaveLength(NANO_MAX_CHUNKS);
  });

  it("stops at the token budget", () => {
    const heavy = Array.from({ length: 6 }, (_, i) =>
      chunk({ vectorId: i, url: `https://d/${i}`, body: "word ".repeat(600) }),
    );
    const packed = packContext(heavy, { maxChunks: 6, tokenBudget: 400 });
    expect(packed.length).toBeLessThan(6);
    expect(packed.length).toBeGreaterThan(0); // always send something
  });

  it("keeps at least one chunk even when it alone busts the budget", () => {
    const huge = [chunk({ vectorId: 0, body: "word ".repeat(5000) })];
    expect(packContext(huge, { maxChunks: 6, tokenBudget: 10 })).toHaveLength(1);
  });

  it("drops a neighbour whose direct hit didn't make the cut", () => {
    // An orphan neighbour would show context the answer can't cite.
    const orphan = chunk({ vectorId: 9, url: "https://d/z", viaNeighbour: true });
    expect(packContext([orphan], NANO_PACK)).toEqual([]);
  });

  it("keeps a neighbour that follows its own hit", () => {
    const hit = chunk({ vectorId: 1, url: "https://d/a", position: 0 });
    const nb = chunk({ vectorId: 2, url: "https://d/a", position: 1, viaNeighbour: true });
    expect(packContext([hit, nb], NANO_PACK).map((c) => c.vectorId)).toEqual([1, 2]);
  });

  it("preserves retrieval order", () => {
    const chunks = [3, 1, 2].map((id) => chunk({ vectorId: id, url: `https://d/${id}` }));
    expect(packContext(chunks, NANO_PACK).map((c) => c.vectorId)).toEqual([3, 1, 2]);
  });
});
