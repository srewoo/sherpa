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

export function isFailed(stat: QueryStat, floor: number): boolean {
  return !stat.answered || stat.topScore < floor || stat.feedback === "down";
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
