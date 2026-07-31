/**
 * Vector math for embeddings and retrieval (PRD 5.5.1, 5.7.2). Embeddings are
 * stored L2-normalised, so cosine similarity reduces to a dot product — the
 * hot path of the brute-force scan.
 */

export const EMBED_DIM = 384;

/** Dot product of one row of `a` (from `aOffset`) with vector `b`. */
export function dot(a: Float32Array, b: Float32Array, aOffset = 0, dim = b.length): number {
  let sum = 0;
  for (let i = 0; i < dim; i++) sum += a[aOffset + i]! * b[i]!;
  return sum;
}

export function l2norm(v: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  return Math.sqrt(sum);
}

/** Normalise `v` to unit length in place (no-op for a zero vector). */
export function normalizeInPlace(v: Float32Array): void {
  const n = l2norm(v);
  if (n === 0) return;
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / n;
}
