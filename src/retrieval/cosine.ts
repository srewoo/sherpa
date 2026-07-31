/**
 * Brute-force cosine top-k (PRD 5.7.2). No ANN index — unnecessary below ~500k
 * chunks and pure complexity at our scale. Vectors are stored L2-normalised, so
 * cosine is a dot product; we scan the packed matrix once per query.
 */

import { dot } from "@/embed/vecmath.js";

export interface Scored {
  readonly id: number;
  readonly score: number;
}

/**
 * Top-k rows of `matrix` (count × dim, row-major) by cosine with `query`.
 * `query` must already be normalised.
 */
export function cosineTopK(
  query: Float32Array,
  matrix: Float32Array,
  dim: number,
  count: number,
  k: number,
): Scored[] {
  const scored: Scored[] = new Array(count);
  for (let i = 0; i < count; i++) {
    scored[i] = { id: i, score: dot(matrix, query, i * dim, dim) };
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
