import { describe, it, expect } from "vitest";
import { reciprocalRankFusion } from "./rrf.js";

describe("reciprocalRankFusion", () => {
  it("ranks an item agreed on by both lists above singletons", () => {
    const dense = { ids: ["a", "b", "c"] };
    const sparse = { ids: ["b", "d", "a"] };
    const fused = reciprocalRankFusion([dense, sparse]);
    expect(fused[0]?.id).toBe("b"); // appears near top of both
  });

  it("is order-independent across the input lists", () => {
    const l1 = { ids: [1, 2, 3] };
    const l2 = { ids: [3, 2, 1] };
    const a = reciprocalRankFusion([l1, l2]);
    const b = reciprocalRankFusion([l2, l1]);
    expect(a.map((r) => r.id).sort()).toEqual(b.map((r) => r.id).sort());
  });

  it("honours per-list weight", () => {
    const dense = { ids: ["x", "y"], weight: 0.1 };
    const sparse = { ids: ["y", "x"], weight: 10 };
    const fused = reciprocalRankFusion([dense, sparse]);
    expect(fused[0]?.id).toBe("y"); // sparse dominates via weight
  });

  it("includes every id exactly once", () => {
    const fused = reciprocalRankFusion([{ ids: ["a", "b"] }, { ids: ["b", "c"] }]);
    expect(new Set(fused.map((r) => r.id))).toEqual(new Set(["a", "b", "c"]));
  });
});
