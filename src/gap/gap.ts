/**
 * Content-gap analysis (PRD 5.11). Turns logged queries into "N users asked
 * about X, no adequate content exists". Failures are queries that fell below
 * the refusal floor, weren't answered, or got a 👎. They're clustered by
 * semantic similarity (token Jaccard as a dependency-free proxy) and ranked by
 * volume. Pure + tested; the report feeds the docs backlog via CSV/Markdown.
 */

import { tokenize } from "@/retrieval/bm25.js";

export interface QueryStat {
  readonly query: string;
  readonly topScore: number;
  readonly answered: boolean;
  readonly feedback?: "up" | "down";
}

/**
 * Did this query reveal a hole in the documentation?
 *
 * The distinction that was missing: a turn can fail *and* the content can be
 * there. When retrieval scored a page at 86% and the answering model still
 * declined, the docs covered the question — something in the answer pipeline
 * did not. Counting that as a content gap made the report recommend writing
 * pages that already existed, which is the most expensive wrong answer this
 * feature can give.
 *
 * `confidentFloor` is what separates the two. Above it, a refusal is evidence
 * about Sherpa; below it, evidence about the docs. Optional so callers written
 * before this existed keep their previous behaviour rather than silently
 * changing what their report means — and a 👎 always counts, because a human
 * saying "this was wrong" outranks any score.
 */
export function isFailed(stat: QueryStat, floor: number, confidentFloor?: number): boolean {
  if (stat.feedback === "down") return true;
  if (stat.topScore < floor) return true;
  if (!stat.answered) {
    /**
     * A high-confidence decline is a pipeline signal, not a missing page.
     *
     * Derived from the score rather than a new stored field on purpose: the
     * query log is deliberately cheap, and every entry ever written already
     * carries `topScore`. A new `outcome` value would mean a migration over a
     * log whose whole point is that it costs nothing to append to — and would
     * leave every historical entry unclassifiable anyway.
     */
    if (confidentFloor !== undefined && stat.topScore >= confidentFloor) return false;
    return true;
  }
  return false;
}

/** Jaccard similarity of two query token sets, in [0,1]. */
export function jaccard(a: string, b: string): number {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

export interface Cluster {
  readonly representative: string;
  readonly queries: string[];
  score: number; // running sum of topScores
}

/**
 * Greedy single-link clustering: a query joins the cluster it most resembles,
 * compared against *every* member rather than only the representative.
 *
 * Comparing to the representative alone splits obvious topics — "how to reset
 * password" and "reset the password now" share only 0.33 with each other but
 * both sit comfortably above the threshold against "reset password steps", so
 * they belong together. Single-link is what makes the chain hold.
 */
export function clusterFailures(failed: readonly QueryStat[], threshold = 0.34): Cluster[] {
  const clusters: Cluster[] = [];

  for (const f of failed) {
    let best: Cluster | undefined;
    let bestScore = threshold;

    for (const c of clusters) {
      const similarity = Math.max(...c.queries.map((q) => jaccard(q, f.query)));
      if (similarity >= bestScore) {
        best = c;
        bestScore = similarity;
      }
    }

    if (best) {
      best.queries.push(f.query);
      best.score += f.topScore;
    } else {
      clusters.push({ representative: f.query, queries: [f.query], score: f.topScore });
    }
  }
  return clusters;
}

export interface GapRow {
  readonly topic: string;
  readonly count: number;
  readonly avgScore: number;
  readonly examples: readonly string[];
}

export function buildGapReport(clusters: readonly Cluster[]): GapRow[] {
  return clusters
    .map((c) => ({
      topic: c.representative,
      count: c.queries.length,
      avgScore: c.score / c.queries.length,
      examples: c.queries.slice(0, 3),
    }))
    .sort((a, b) => b.count - a.count);
}

export function toCSV(rows: readonly GapRow[]): string {
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const head = "topic,count,avg_score,examples";
  const body = rows.map((r) => [esc(r.topic), r.count, r.avgScore.toFixed(3), esc(r.examples.join(" | "))].join(","));
  return [head, ...body].join("\n");
}

export function toMarkdown(rows: readonly GapRow[]): string {
  const head = "| Topic | Asks | Avg score |\n|---|---|---|";
  const body = rows.map((r) => `| ${r.topic} | ${r.count} | ${r.avgScore.toFixed(2)} |`);
  return [head, ...body].join("\n");
}
