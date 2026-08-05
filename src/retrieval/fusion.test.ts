import { describe, it, expect } from "vitest";
import { minMaxNormalise, weightedFusion, applyBoost, DENSE_WEIGHT, SPARSE_WEIGHT } from "./fusion.js";

describe("minMaxNormalise", () => {
  it("maps the range onto 0–1", () => {
    const out = minMaxNormalise([
      { id: 1, score: 0.2 },
      { id: 2, score: 0.7 },
      { id: 3, score: 0.45 },
    ]);
    expect(out.get(2)).toBe(1);
    expect(out.get(1)).toBe(0);
    expect(out.get(3)).toBeCloseTo(0.5, 5);
  });

  it("gives every member full credit when scores are identical", () => {
    // A retriever with no preference should contribute its weight evenly,
    // not zero it out — (score - min) / 0 would otherwise be NaN.
    const out = minMaxNormalise([
      { id: 1, score: 0.5 },
      { id: 2, score: 0.5 },
    ]);
    expect(out.get(1)).toBe(1);
    expect(out.get(2)).toBe(1);
  });

  it("handles an empty list", () => {
    expect(minMaxNormalise([]).size).toBe(0);
  });
});

describe("weightedFusion", () => {
  const dense = [
    { id: 1, score: 0.9 },
    { id: 2, score: 0.5 },
  ];
  const sparse = [
    { id: 2, score: 10 },
    { id: 3, score: 4 },
  ];

  it("rewards agreement between retrievers", () => {
    const fused = weightedFusion([
      { results: dense, weight: DENSE_WEIGHT },
      { results: sparse, weight: SPARSE_WEIGHT },
    ]);
    const byId = new Map(fused.map((f) => [f.id, f.confidence]));

    // id 2 is found by both; id 3 only by the weaker retriever.
    expect(byId.get(2)!).toBeGreaterThan(byId.get(3)!);
  });

  it("treats a document missing from a retriever as zero there, not absent", () => {
    // Dividing by only the retrievers that found a document would let a
    // BM25-only hit tie with one both retrievers agreed on.
    const fused = weightedFusion([
      { results: [{ id: 1, score: 1 }], weight: 0.75 },
      { results: [{ id: 2, score: 1 }], weight: 0.25 },
    ]);
    const byId = new Map(fused.map((f) => [f.id, f.confidence]));
    expect(byId.get(1)).toBeCloseTo(0.75, 5);
    expect(byId.get(2)).toBeCloseTo(0.25, 5);
  });

  it("returns a descending list bounded by 0–1", () => {
    const fused = weightedFusion([
      { results: dense, weight: DENSE_WEIGHT },
      { results: sparse, weight: SPARSE_WEIGHT },
    ]);
    for (const f of fused) {
      expect(f.confidence).toBeGreaterThanOrEqual(0);
      expect(f.confidence).toBeLessThanOrEqual(1);
    }
    const scores = fused.map((f) => f.confidence);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("weights dense above sparse", () => {
    // Same normalised position in each list; dense should win on weight alone.
    const fused = weightedFusion([
      { results: [{ id: 1, score: 1 }, { id: 9, score: 0 }], weight: DENSE_WEIGHT },
      { results: [{ id: 2, score: 1 }, { id: 8, score: 0 }], weight: SPARSE_WEIGHT },
    ]);
    expect(fused[0]?.id).toBe(1);
  });

  it("copes with an empty retriever", () => {
    const fused = weightedFusion([
      { results: dense, weight: DENSE_WEIGHT },
      { results: [], weight: SPARSE_WEIGHT },
    ]);
    expect(fused[0]?.id).toBe(1);
  });

  it("returns nothing when all weights are zero", () => {
    expect(weightedFusion([{ results: dense, weight: 0 }])).toEqual([]);
  });
});

describe("applyBoost", () => {
  it("scales but never leaves 0–1", () => {
    expect(applyBoost(0.5, 1.15)).toBeCloseTo(0.575, 5);
    expect(applyBoost(0.95, 1.5)).toBe(1);
    expect(applyBoost(0.5, -1)).toBe(0);
  });
});
