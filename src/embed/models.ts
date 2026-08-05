/**
 * The embedding models Sherpa ships (PRD 5.5.1).
 *
 * Both are bundled, so switching is offline and instant. Both are 384-dimension
 * so the sharded storage layout (5.5.2) is identical either way — but vectors
 * from different models are *not* comparable, so an index records which one
 * built it and must be rebuilt to change.
 *
 * Adding a model here means adding its weights under public/models/ (see
 * scripts/fetch-model.mjs) and keeping `dim` equal to EMBED_DIM.
 */

export type PoolingStrategy = "cls" | "mean";

export interface EmbeddingModelSpec {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly dim: number;
  readonly pooling: PoolingStrategy;
  /**
   * Prefix applied to *queries only*. Asymmetric models are trained with an
   * instruction on the query side; prefixing passages too undoes the effect.
   */
  readonly queryPrefix: string;
  /** Approximate on-disk size of the quantised weights. */
  readonly sizeMB: number;
}

export const EMBEDDING_MODELS: readonly EmbeddingModelSpec[] = [
  {
    id: "Xenova/bge-small-en-v1.5",
    label: "BGE Small EN v1.5",
    description: "Default. Strongest retrieval quality of the two; a little slower to index.",
    dim: 384,
    pooling: "cls",
    queryPrefix: "Represent this sentence for searching relevant passages: ",
    sizeMB: 33,
  },
  {
    id: "Xenova/all-MiniLM-L6-v2",
    label: "MiniLM L6 v2",
    description: "Faster and smaller. Weaker on paraphrased questions — good for very large sites.",
    dim: 384,
    pooling: "mean",
    queryPrefix: "",
    sizeMB: 23,
  },
];

export const DEFAULT_EMBEDDING_MODEL_ID = EMBEDDING_MODELS[0]!.id;

export function findModel(id: string | undefined): EmbeddingModelSpec {
  return EMBEDDING_MODELS.find((m) => m.id === id) ?? EMBEDDING_MODELS[0]!;
}
