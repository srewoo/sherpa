/**
 * Field-weighted BM25 (PRD 5.5.4, 5.7.1).
 *
 * A help article's title is very often the answer to the question — "AI
 * Roleplay – AI Scenario Creator" answers "how do I create a roleplay" almost
 * by itself. Scoring one flat blob of title + heading path + body dilutes that:
 * the title's handful of words is drowned by several hundred words of prose,
 * and BM25's length normalisation then penalises the very documents whose
 * titles matched.
 *
 * So each field is indexed separately and scored separately, then combined with
 * weights — the same shape as the `multi_match` with `title^2, section^1.5,
 * content` that the server-side KB uses.
 */

import { Bm25Index, type Bm25Snapshot } from "./bm25.js";

export const FIELD_WEIGHTS = {
  title: 2,
  section: 1.5,
  content: 1,
} as const;

export type FieldName = keyof typeof FIELD_WEIGHTS;

const FIELDS: readonly FieldName[] = ["title", "section", "content"];

export interface FieldedDoc {
  readonly id: number;
  readonly title: string;
  /** The breadcrumb + heading path this chunk sits under. */
  readonly section: string;
  readonly content: string;
}

export interface FieldedSnapshot {
  readonly fields: Partial<Record<FieldName, Bm25Snapshot>>;
}

/**
 * Three BM25 indexes behind one interface. Scores are summed with the field
 * weights; fusion normalises the result, so the absolute scale doesn't matter,
 * only the relative ordering the weights produce.
 */
export class FieldedBm25Index {
  private readonly indexes: Map<FieldName, Bm25Index>;

  private constructor(indexes: Map<FieldName, Bm25Index>) {
    this.indexes = indexes;
  }

  static build(docs: readonly FieldedDoc[]): FieldedBm25Index {
    const indexes = new Map<FieldName, Bm25Index>();
    for (const field of FIELDS) {
      indexes.set(
        field,
        new Bm25Index(docs.map((d) => ({ id: d.id, text: d[field] }))),
      );
    }
    return new FieldedBm25Index(indexes);
  }

  static fromSnapshot(snapshot: FieldedSnapshot): FieldedBm25Index {
    const indexes = new Map<FieldName, Bm25Index>();
    for (const field of FIELDS) {
      const stored = snapshot.fields[field];
      if (stored) indexes.set(field, Bm25Index.fromSnapshot(stored));
    }
    return new FieldedBm25Index(indexes);
  }

  toSnapshot(): FieldedSnapshot {
    const fields: Partial<Record<FieldName, Bm25Snapshot>> = {};
    for (const [field, index] of this.indexes) fields[field] = index.toSnapshot();
    return { fields };
  }

  /**
   * Top-k documents by the weighted sum of their per-field BM25 scores.
   *
   * Each field is searched deeper than `k` before combining, so a document that
   * ranks modestly in two fields can still beat one that ranks highly in a
   * single field — the point of scoring fields separately.
   */
  search(query: string, k: number): { id: number; score: number }[] {
    const combined = new Map<number, number>();
    const perFieldDepth = Math.max(k * 3, 30);

    for (const [field, index] of this.indexes) {
      const weight = FIELD_WEIGHTS[field];
      for (const { id, score } of index.search(query, perFieldDepth)) {
        combined.set(id, (combined.get(id) ?? 0) + score * weight);
      }
    }

    return [...combined.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}
