/**
 * The eval that measures the product rather than its plumbing (PRD §7.1).
 *
 * `pipeline.test.ts` runs the real retrieval code with a *hashed bag-of-words*
 * embedder over twelve invented chunks. That is a good regression test for
 * fusion, dedupe and the refusal floor, and it is worthless for the question
 * anyone actually cares about — does Sherpa answer real questions about a real
 * help centre. Nothing in it can tell you whether a change to chunking, context
 * packing or assembly helped or hurt.
 *
 * This harness closes that gap. Same code paths, but a labelled question set, a
 * real crawled corpus and the true embedding model. It is a script, not a CI
 * gate: loading 33 MB of ONNX weights and embedding a few thousand chunks takes
 * minutes, which is right for a decision and wrong for every commit.
 *
 * The reporting is deliberately split three ways, because "the answer was bad"
 * has three distinct causes and they need different fixes:
 *
 *   recall            — did retrieval find the right article at all?
 *   context coverage  — did the assembled context contain the required facts?
 *   answer coverage   — did the generated answer keep them?
 *
 * High recall, high context coverage, low answer coverage is a generation
 * problem. High recall, low context coverage is a chunking or assembly problem.
 * A single score would have hidden both of the bugs found this week.
 */

import type { RetrievedArticle } from "@/domain/retrieval.js";
import { coverageOf, meanCoverage, mostMissed, type Coverage } from "./coverage.js";
import { answerable, unanswerable, type EvalQuestion } from "./questionSet.js";

/** Compare URLs the way a labeller means them: scheme and trailing slash are noise. */
export function sameArticle(a: string, b: string): boolean {
  return normalizeUrl(a) === normalizeUrl(b);
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.hostname}${path}${u.search}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

export interface AnswerAttempt {
  readonly text: string;
  /** True when the pipeline declined — floor or model, both count as unanswered. */
  readonly refused: boolean;
}

export interface RealEvalDeps {
  readonly retrieve: (query: string) => Promise<{
    readonly articles: readonly RetrievedArticle[];
    readonly topScore: number;
  }>;
  /**
   * Generate the answer. Optional: omitting it measures retrieval alone, which
   * runs in seconds and is the right loop while tuning chunking or fusion.
   */
  readonly answer?: (
    query: string,
    articles: readonly RetrievedArticle[],
  ) => Promise<AnswerAttempt>;
  readonly floor: number;
}

export interface EvalCaseResult {
  readonly question: string;
  readonly expectedUrls: readonly string[];
  /** Article URLs in rank order. */
  readonly retrievedUrls: readonly string[];
  readonly topScore: number;
  /** Rank of the first correct article, 1-based; undefined when never found. */
  readonly firstHitRank: number | undefined;
  readonly answered: boolean;
  /** What the assembled context contained — retrieval's ceiling. */
  readonly contextCoverage: Coverage;
  /** What survived into the answer. Equals context coverage when not generating. */
  readonly answerCoverage: Coverage;
  readonly answerText: string;
}

export async function runCase(deps: RealEvalDeps, q: EvalQuestion): Promise<EvalCaseResult> {
  const { articles, topScore } = await deps.retrieve(q.question);
  const retrievedUrls = articles.map((a) => a.url);

  const firstHit = retrievedUrls.findIndex((url) =>
    q.answerUrls.some((expected) => sameArticle(url, expected)),
  );

  const context = articles.map((a) => a.body).join("\n\n");
  const contextCoverage = coverageOf(context, q.mustInclude);

  // The floor is applied here rather than inside the answerer so that a
  // retrieval-only run reports the same answered/refused decision the product
  // would make.
  const clearsFloor = articles.length > 0 && topScore >= deps.floor;

  let answered = clearsFloor;
  let answerText = context;
  let answerCoverage = contextCoverage;

  if (clearsFloor && deps.answer) {
    const attempt = await deps.answer(q.question, articles);
    answered = !attempt.refused;
    answerText = attempt.text;
    answerCoverage = coverageOf(attempt.text, q.mustInclude);
  }

  return {
    question: q.question,
    expectedUrls: q.answerUrls,
    retrievedUrls,
    topScore,
    firstHitRank: firstHit >= 0 ? firstHit + 1 : undefined,
    answered,
    contextCoverage,
    answerCoverage,
    answerText,
  };
}

export interface EvalReport {
  readonly answerableCount: number;
  readonly unanswerableCount: number;
  /** Fraction of answerable questions whose article appears in the top k. */
  readonly hitAt: Readonly<Record<number, number>>;
  /** Mean reciprocal rank of the first correct article. */
  readonly mrr: number;
  /** Fraction of unanswerable questions answered anyway (M3). */
  readonly falseAnswerRate: number;
  /** Fraction of answerable questions refused despite the article being found. */
  readonly missedAnswerRate: number;
  readonly contextCoverage: number;
  readonly answerCoverage: number;
  readonly mostMissedPhrases: readonly { phrase: string; misses: number }[];
}

export function summarize(
  questions: readonly EvalQuestion[],
  results: readonly EvalCaseResult[],
  ks: readonly number[] = [1, 3, 5],
): EvalReport {
  const byQuestion = new Map(results.map((r) => [r.question, r]));
  const positives = answerable(questions)
    .map((q) => byQuestion.get(q.question))
    .filter((r): r is EvalCaseResult => r !== undefined);
  const negatives = unanswerable(questions)
    .map((q) => byQuestion.get(q.question))
    .filter((r): r is EvalCaseResult => r !== undefined);

  const hitAt: Record<number, number> = {};
  for (const k of ks) {
    hitAt[k] =
      positives.length === 0
        ? 0
        : positives.filter((r) => r.firstHitRank !== undefined && r.firstHitRank <= k).length /
          positives.length;
  }

  const mrr =
    positives.length === 0
      ? 0
      : positives.reduce((s, r) => s + (r.firstHitRank ? 1 / r.firstHitRank : 0), 0) /
        positives.length;

  /**
   * The mirror of the false-answer rate, and the one this project has never
   * measured: questions the docs *do* answer, whose article we *did* retrieve,
   * that Sherpa refused anyway. Tuning the floor down improves this and worsens
   * false answers; you cannot choose sensibly while only one is visible.
   */
  const foundButRefused = positives.filter((r) => r.firstHitRank !== undefined && !r.answered);

  return {
    answerableCount: positives.length,
    unanswerableCount: negatives.length,
    hitAt,
    mrr,
    falseAnswerRate:
      negatives.length === 0 ? 0 : negatives.filter((r) => r.answered).length / negatives.length,
    missedAnswerRate: positives.length === 0 ? 0 : foundButRefused.length / positives.length,
    contextCoverage: meanCoverage(positives.map((r) => r.contextCoverage)),
    answerCoverage: meanCoverage(positives.map((r) => r.answerCoverage)),
    mostMissedPhrases: mostMissed(positives.map((r) => r.answerCoverage)),
  };
}

/** Human-readable report for the CLI. */
export function formatReport(report: EvalReport): string {
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  const lines = [
    `answerable: ${report.answerableCount}   unanswerable: ${report.unanswerableCount}`,
    "",
    "RETRIEVAL",
    ...Object.entries(report.hitAt).map(([k, v]) => `  hit@${k}          ${pct(v)}`),
    `  MRR             ${report.mrr.toFixed(3)}`,
    "",
    "COMPLETENESS",
    `  context         ${pct(report.contextCoverage)}   (what retrieval handed the model)`,
    `  answer          ${pct(report.answerCoverage)}   (what survived into the reply)`,
    "",
    "DECISIONS",
    `  false answers   ${pct(report.falseAnswerRate)}   (answered when it shouldn't)`,
    `  missed answers  ${pct(report.missedAnswerRate)}   (refused when it could have)`,
  ];

  if (report.mostMissedPhrases.length > 0) {
    lines.push("", "MOST-MISSED PHRASES");
    for (const { phrase, misses } of report.mostMissedPhrases) {
      lines.push(`  ${String(misses).padStart(3)}×  ${phrase}`);
    }
  }
  return lines.join("\n");
}
