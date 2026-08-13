import { describe, it, expect } from "vitest";
import { recallAtK, hitAtK, falseAnswerRate, groundedness } from "./metrics.js";
import { runRetrievalEval, runAdversarialEval, runRefinementEval, passesGate } from "./harness.js";

describe("metrics", () => {
  it("recall@k is the fraction of relevant chunks retrieved in top-k", () => {
    expect(recallAtK([3, 1, 9, 2], new Set([1, 2]), 5)).toBe(1);
    expect(recallAtK([3, 1, 9, 2], new Set([1, 2]), 2)).toBe(0.5);
    expect(recallAtK([5, 6], new Set([1]), 5)).toBe(0);
  });

  it("hit@k is binary presence in top-k", () => {
    expect(hitAtK([9, 1], new Set([1]), 2)).toBe(1);
    expect(hitAtK([9, 8], new Set([1]), 2)).toBe(0);
  });

  it("false-answer rate is the share answered among unanswerables", () => {
    expect(falseAnswerRate([false, false, true, false])).toBe(0.25);
  });

  it("groundedness averages cited/total, ignoring empty", () => {
    expect(groundedness([{ cited: 2, total: 2 }, { cited: 1, total: 2 }])).toBe(0.75);
  });
});

describe("harness", () => {
  const golden = [
    { query: "rotate key", relevant: [10] },
    { query: "bulk import", relevant: [20, 21] },
  ];
  const retrieveIds = async (q: string) =>
    q === "rotate key" ? [10, 3, 4] : [20, 5, 21];

  it("aggregates recall/hit across a golden set", async () => {
    const report = await runRetrievalEval(golden, retrieveIds, [1, 5]);
    expect(report.n).toBe(2);
    expect(report.hitAt[1]).toBe(1); // both have a relevant id at rank 1
    expect(report.recallAt[5]).toBe(1); // all relevant found within 5
  });

  it("passesGate enforces M1 recall@5 and M3 false-answer", async () => {
    const retrieval = await runRetrievalEval(golden, retrieveIds, [5]);
    const good = await runAdversarialEval(["nonsense"], async () => false);
    const bad = await runAdversarialEval(["nonsense"], async () => true);
    expect(passesGate(retrieval, good)).toBe(true);
    expect(passesGate(retrieval, bad)).toBe(false);
  });

  /**
   * Proving M4 has teeth.
   *
   * A gate that cannot fail is decoration, and this one is being added precisely
   * because the existing gates could not fail on the bug that shipped. These two
   * cases stand in for the old behaviour and the new one: a turn that hands the
   * question back, and a turn that reaches an outcome.
   */
  describe("M4 blocked turns", () => {
    const blocked = async () => ({ outcome: "blocked" as const, refinements: 3 });
    const answered = async () => ({ outcome: "answer" as const, refinements: 3 });
    const refused = async () => ({ outcome: "refusal" as const, refinements: 0 });

    it("fails the gate when a question is handed back with no outcome", async () => {
      const retrieval = await runRetrievalEval(golden, retrieveIds, [5]);
      const adversarial = await runAdversarialEval(["nonsense"], async () => false);
      const report = await runRefinementEval(golden, blocked);
      expect(report.blockedRate).toBe(1);
      expect(passesGate(retrieval, adversarial, report)).toBe(false);
    });

    it("counts a refusal as a real outcome, not a block", async () => {
      const report = await runRefinementEval(golden, refused);
      expect(report.blockedRate).toBe(0);
    });

    /** Offering alternatives beneath an answer is measured, never penalised. */
    it("separates refinement from blocking", async () => {
      const report = await runRefinementEval(golden, answered);
      expect(report.blockedRate).toBe(0);
      expect(report.refineRate).toBe(1);
    });
  });
});
