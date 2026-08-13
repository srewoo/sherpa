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

/**
 * M4 — does every question reach somewhere?
 *
 * This metric exists because its absence let a dead end ship. Sherpa used to
 * gate answers behind "Which of these did you mean?", and on a large help
 * centre that fired on ordinary, well-formed questions — including on the
 * option the user had just picked, so the same three chips returned forever.
 * M1 and M3 were green throughout, and could not have been otherwise: recall
 * measures ranking, and false-answer rate measures answers that shouldn't have
 * been given. Neither can see a turn that produced *no outcome at all*.
 *
 * So the unit here is the terminal state of a turn, not a score:
 *
 *   answer   — sources and a generated reply
 *   refusal  — declined, with the nearest pages shown
 *   blocked  — neither: a question handed back to the user
 *
 * A refusal is a *legitimate* outcome. It tells the user where they stand and
 * shows them the closest pages. `blocked` is the failure, and it must be zero:
 * an interface that neither answers nor declines has simply stopped.
 *
 * Deliberately independent of score magnitudes. The eval's embedder is a
 * hashing stand-in whose cosines are nothing like bge's, so any gate written in
 * terms of the refusal floor would be measuring the fixture. This one measures
 * control flow, which is the same in the fixture and in production.
 */
export type TurnOutcome = "answer" | "refusal" | "blocked";

export interface RefinementReport {
  readonly n: number;
  /** Share of questions that produced neither an answer nor a refusal. */
  readonly blockedRate: number;
  /** Share answered that also offered alternatives underneath. */
  readonly refineRate: number;
}

export async function runRefinementEval(
  queries: readonly GoldenCase[],
  outcomeOf: (query: string) => Promise<{ outcome: TurnOutcome; refinements: number }>,
): Promise<RefinementReport> {
  let blocked = 0;
  let refined = 0;
  for (const g of queries) {
    const { outcome, refinements } = await outcomeOf(g.query);
    if (outcome === "blocked") blocked += 1;
    else if (outcome === "answer" && refinements > 0) refined += 1;
  }
  const n = queries.length;
  return {
    n,
    blockedRate: n === 0 ? 0 : blocked / n,
    refineRate: n === 0 ? 0 : refined / n,
  };
}

/** Apply the release gate to a report (M1, M3, M4). */
export function passesGate(
  retrieval: RetrievalReport,
  adversarial: AdversarialReport,
  refinement?: RefinementReport,
): boolean {
  const core =
    (retrieval.recallAt[5] ?? 0) >= 0.85 && adversarial.falseAnswerRate <= 0.03;
  // Optional so existing callers keep working; when supplied it is not
  // negotiable. A question that reaches neither an answer nor a refusal is the
  // failure this gate was added for, and one is one too many.
  return core && (refinement === undefined || refinement.blockedRate === 0);
}
