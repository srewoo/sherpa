/**
 * BM25 lexical ranking (PRD 5.5.4, 5.7.1). Dense retrieval misses exact terms —
 * error codes, flag names, API fields — which are most help-site queries. BM25
 * is the sparse half of hybrid retrieval. Built in memory from chunk texts and
 * cached per session (persisting the inverted index is a later optimisation).
 */

const K1 = 1.5;
const B = 0.75;

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

export interface Bm25Doc {
  readonly id: number;
  readonly text: string;
}

interface Posting {
  readonly id: number;
  readonly tf: number;
}

/** On-disk form of a built index (PRD 5.5.4). */
export interface Bm25Snapshot {
  /** term → [docId, tf, docId, tf, …], flat to keep the JSON small. */
  readonly postings: Record<string, number[]>;
  readonly docLen: [number, number][];
}

export class Bm25Index {
  private readonly postings = new Map<string, Posting[]>();
  private readonly docLen = new Map<number, number>();
  private readonly n: number;
  private readonly avgdl: number;

  constructor(docs: readonly Bm25Doc[], snapshot?: Bm25Snapshot) {
    if (snapshot) {
      for (const [term, flat] of Object.entries(snapshot.postings)) {
        const list: Posting[] = [];
        for (let i = 0; i + 1 < flat.length; i += 2) {
          list.push({ id: flat[i]!, tf: flat[i + 1]! });
        }
        this.postings.set(term, list);
      }
      for (const [id, len] of snapshot.docLen) this.docLen.set(id, len);
      this.n = this.docLen.size;
      const restored = [...this.docLen.values()].reduce((a, b) => a + b, 0);
      this.avgdl = this.n > 0 ? restored / this.n : 0;
      return;
    }

    for (const doc of docs) {
      const tokens = tokenize(doc.text);
      this.docLen.set(doc.id, tokens.length);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const [term, count] of tf) {
        const list = this.postings.get(term) ?? [];
        list.push({ id: doc.id, tf: count });
        this.postings.set(term, list);
      }
    }
    this.n = this.docLen.size;
    const total = [...this.docLen.values()].reduce((a, b) => a + b, 0);
    this.avgdl = this.n > 0 ? total / this.n : 0;
  }

  /** Serialisable form, so the index is built once at crawl time rather than
   * rebuilt from every chunk on every query (PRD 5.5.4, 5.7.6). */
  toSnapshot(): Bm25Snapshot {
    const postings: Record<string, number[]> = {};
    for (const [term, list] of this.postings) {
      const flat: number[] = [];
      for (const p of list) flat.push(p.id, p.tf);
      postings[term] = flat;
    }
    return { postings, docLen: [...this.docLen.entries()] };
  }

  static fromSnapshot(snapshot: Bm25Snapshot): Bm25Index {
    return new Bm25Index([], snapshot);
  }

  private idf(term: string): number {
    const df = this.postings.get(term)?.length ?? 0;
    if (df === 0) return 0;
    // BM25 idf with +1 to stay non-negative.
    return Math.log(1 + (this.n - df + 0.5) / (df + 0.5));
  }

  /** Top-k document ids by BM25 score for a query. */
  search(query: string, k: number): { id: number; score: number }[] {
    const scores = new Map<number, number>();
    for (const term of new Set(tokenize(query))) {
      const idf = this.idf(term);
      if (idf === 0) continue;
      for (const { id, tf } of this.postings.get(term) ?? []) {
        const dl = this.docLen.get(id) ?? 0;
        const denom = tf + K1 * (1 - B + (B * dl) / (this.avgdl || 1));
        scores.set(id, (scores.get(id) ?? 0) + idf * ((tf * (K1 + 1)) / denom));
      }
    }
    return [...scores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}
