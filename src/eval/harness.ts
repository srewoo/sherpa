/**
 * Eval harness (PRD §7). Runs a golden set through an injected retriever and an
 * adversarial set through an injected answerer, producing the metrics that gate
 * release (M1 Recall@5 ≥ 0.85, M3 false-answer ≤ 0.03). The retriever/answerer
 * are injected so this drives either the real pipeline or fixtures.
 */

import {
  falseAnswerRate,
  meanHitAtK,
  meanRecallAtK,
  type RetrievalCase,
} from "./metrics.js";

export interface GoldenCase {
  readonly query: string;
  readonly relevant: readonly number[];
}

export interface RetrievalReport {
  readonly n: number;
  readonly recallAt: Readonly<Record<number, number>>;
  readonly hitAt: Readonly<Record<number, number>>;
}

export async function runRetrievalEval(
  golden: readonly GoldenCase[],
  retrieveIds: (query: string) => Promise<number[]>,
  ks: readonly number[] = [1, 5, 10],
): Promise<RetrievalReport> {
  const cases: RetrievalCase[] = [];
  for (const g of golden) {
    cases.push({ retrieved: await retrieveIds(g.query), relevant: new Set(g.relevant) });
  }
  const recallAt: Record<number, number> = {};
  const hitAt: Record<number, number> = {};
  for (const k of ks) {
    recallAt[k] = meanRecallAtK(cases, k);
    hitAt[k] = meanHitAtK(cases, k);
  }
  return { n: cases.length, recallAt, hitAt };
}

export interface AdversarialReport {
  readonly n: number;
  readonly falseAnswerRate: number;
}

export async function runAdversarialEval(
  queries: readonly string[],
  didAnswer: (query: string) => Promise<boolean>,
): Promise<AdversarialReport> {
  const answered: boolean[] = [];
  for (const q of queries) answered.push(await didAnswer(q));
  return { n: queries.length, falseAnswerRate: falseAnswerRate(answered) };
}

/** Apply the release gate to a report (M1, M3). */
export function passesGate(retrieval: RetrievalReport, adversarial: AdversarialReport): boolean {
  return (retrieval.recallAt[5] ?? 0) >= 0.85 && adversarial.falseAnswerRate <= 0.03;
}
