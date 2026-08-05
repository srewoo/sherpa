import { describe, it, expect } from "vitest";
import { applyRerank, DEFAULT_RERANK } from "./rerank.js";

const list = (...ids: number[]): { id: number }[] => ids.map((id) => ({ id }));

describe("applyRerank", () => {
  it("reorders the head by reranker score", () => {
    const out = applyRerank(list(1, 2, 3), new Map([[1, 0.1], [2, 0.9], [3, 0.5]]), 3);
    expect(out.map((c) => c.id)).toEqual([2, 3, 1]);
  });

  /**
   * The property that makes this safe: reranking permutes, it never edits the
   * candidate set. A reranker that silently dropped a chunk would take its page
   * out of the citations with nothing to show for it.
   */
  it("never adds or drops a candidate", () => {
    const out = applyRerank(list(1, 2, 3, 4, 5), new Map([[5, 0.9]]), 3);
    expect([...out.map((c) => c.id)].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("leaves candidates past topN in first-stage order", () => {
    const out = applyRerank(list(1, 2, 3, 4, 5), new Map([[1, 0.1], [2, 0.9]]), 2);
    expect(out.map((c) => c.id)).toEqual([2, 1, 3, 4, 5]);
  });

  /** A score the reranker didn't produce must not be read as a score of zero. */
  it("sorts an unscored candidate below scored ones, not above", () => {
    const out = applyRerank(list(1, 2, 3), new Map([[2, 0.4], [3, 0.2]]), 3);
    expect(out.map((c) => c.id)).toEqual([2, 3, 1]);
  });

  it("keeps first-stage order when scores tie", () => {
    const out = applyRerank(list(1, 2, 3), new Map([[1, 0.5], [2, 0.5], [3, 0.5]]), 3);
    expect(out.map((c) => c.id)).toEqual([1, 2, 3]);
  });

  /** The reranker being unavailable must be indistinguishable from it being off. */
  it("returns the original order when nothing was scored", () => {
    const out = applyRerank(list(1, 2, 3), new Map(), 3);
    expect(out.map((c) => c.id)).toEqual([1, 2, 3]);
  });

  it("handles an empty candidate list", () => {
    expect(applyRerank([], new Map(), DEFAULT_RERANK.topN)).toEqual([]);
  });

  it("handles topN larger than the candidate list", () => {
    const out = applyRerank(list(1, 2), new Map([[2, 0.9]]), 50);
    expect(out.map((c) => c.id)).toEqual([2, 1]);
  });
});
