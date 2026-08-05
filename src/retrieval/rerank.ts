/**
 * Cross-encoder reranking.
 *
 * Retrieval so far compares two vectors that were computed *independently* —
 * the query never saw the passage and the passage never saw the query. That is
 * what makes it fast enough to scan 15,000 chunks, and it is also its ceiling:
 * a bi-encoder can only ask "are these two things similar", never "does this
 * passage answer this question".
 *
 * A cross-encoder reads both together and scores the pair directly. It cannot
 * scan an index — every candidate costs a forward pass — so it runs as a second
 * stage over the handful of chunks the first stage already found. First stage
 * for recall, second stage for precision.
 *
 * Two properties keep this safe to ship:
 *
 *  - **Optional.** The weights are fetched by `npm run fetch:reranker`, not by
 *    the build. Absent, `createReranker` fails and retrieval carries on with
 *    first-stage ranking — the extension is never broken by a missing model.
 *  - **Order-only.** Reranking permutes candidates; it never invents or drops
 *    them, and it never touches the cosine similarity that drives the refusal
 *    floor. A reranker that scores everything highly can reorder results but
 *    cannot talk Sherpa into answering something it would have refused.
 */

import { AutoTokenizer, AutoModelForSequenceClassification, env } from "@xenova/transformers";

export const RERANKER_MODEL_ID = "Xenova/ms-marco-MiniLM-L-6-v2";

export interface RerankCandidate {
  readonly id: number;
  /** The passage text scored against the query. */
  readonly text: string;
}

/** Scores a query against each passage. Higher is more relevant. */
export type Reranker = (
  query: string,
  candidates: readonly RerankCandidate[],
) => Promise<Map<number, number>>;

export interface RerankOptions {
  /**
   * How many first-stage candidates to rescore.
   *
   * Every one costs a forward pass, so this is the latency dial. Twenty is
   * roughly the point where recall of the first stage has flattened — going
   * deeper mostly rescores chunks that were never going to win.
   */
  readonly topN: number;
  /** Cap per passage: cross-encoders truncate anyway, and long inputs cost more. */
  readonly maxChars: number;
}

export const DEFAULT_RERANK: RerankOptions = { topN: 20, maxChars: 1200 };

/**
 * Reorder by reranker score, leaving anything unscored where it was.
 *
 * Pure, and the important half of this module: the reranker is a model, but
 * *how its output is applied* is logic that can be wrong in ways a model can't
 * be tested for — dropping candidates, reordering the tail, losing ties.
 */
export function applyRerank<T extends { id: number }>(
  candidates: readonly T[],
  scores: ReadonlyMap<number, number>,
  topN: number,
): T[] {
  if (scores.size === 0) return [...candidates];

  const head = candidates.slice(0, topN);
  const tail = candidates.slice(topN);

  // Stable: equal scores keep first-stage order, and a candidate the reranker
  // didn't score sorts below the ones it did rather than jumping to the front.
  const ordered = head
    .map((c, index) => ({ c, index, score: scores.get(c.id) }))
    .sort((a, b) => {
      if (a.score === undefined && b.score === undefined) return a.index - b.index;
      if (a.score === undefined) return 1;
      if (b.score === undefined) return -1;
      return b.score - a.score || a.index - b.index;
    })
    .map((entry) => entry.c);

  return [...ordered, ...tail];
}

/** Resolve a bundled asset, in the extension or in Node. */
function assetUrl(path: string): string {
  return typeof chrome !== "undefined" && chrome.runtime?.getURL
    ? chrome.runtime.getURL(path)
    : `/${path}`;
}

/**
 * Load the cross-encoder. Throws when the weights aren't vendored — callers are
 * expected to treat that as "reranking is off", not as an error.
 */
export async function createReranker(
  assets: { models: string; ort: string } = {
    models: assetUrl("models/"),
    ort: assetUrl("ort/"),
  },
  options: RerankOptions = DEFAULT_RERANK,
): Promise<Reranker> {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = assets.models;
  env.backends.onnx.wasm.wasmPaths = assets.ort;
  env.backends.onnx.wasm.numThreads = 1;
  env.useBrowserCache = false;

  /**
   * Tokenizer and model directly, not `pipeline("text-classification")`.
   *
   * This is the whole reason reranking never worked. A cross-encoder scores a
   * *pair*, and the text-classification pipeline in transformers.js v2 takes
   * only single texts: it hands whatever you pass straight to the tokenizer as
   * `text`, so a `{text, text_pair}` record arrives where a string is expected
   * and dies inside the tokenizer with "text.split is not a function". The
   * throw was then caught by `rerankRanked`, which treats any failure as
   * "reranking is off" — so every query silently fell back to first-stage order
   * and the feature looked like it was running. It never scored a single pair.
   *
   * Pairing is a property of the tokenizer, not the pipeline: `text_pair` is a
   * tokenizer option. Going one level down is what makes it expressible.
   */
  const tokenizer = await AutoTokenizer.from_pretrained(RERANKER_MODEL_ID);
  const model = await AutoModelForSequenceClassification.from_pretrained(RERANKER_MODEL_ID, {
    quantized: true,
  });

  return async (query, candidates) => {
    const scores = new Map<number, number>();
    if (candidates.length === 0) return scores;

    /**
     * One batched forward pass, not one per candidate. The old loop would have
     * paid a full model invocation per passage; batching the whole candidate
     * set is what keeps a second stage affordable on the query path.
     */
    const passages = candidates.map((c) => c.text.slice(0, options.maxChars));
    const inputs = await tokenizer(
      candidates.map(() => query),
      { text_pair: passages, padding: true, truncation: true },
    );
    const { logits } = await model(inputs);

    /**
     * This checkpoint is single-label (`id2label: {0: LABEL_0}`), so logits are
     * [n, 1] and the raw score *is* the relevance — an identity activation, per
     * `sbert_ce_default_activation_function`. No softmax: over one logit it
     * would return 1.0 for every candidate and silently flatten the ranking.
     * Only the ordering is used, so an unbounded score is fine.
     */
    const data = logits.data as Float32Array;
    const perRow = data.length / candidates.length;
    candidates.forEach((candidate, i) => {
      const score = data[i * perRow];
      if (typeof score === "number" && Number.isFinite(score)) scores.set(candidate.id, score);
    });
    return scores;
  };
}
