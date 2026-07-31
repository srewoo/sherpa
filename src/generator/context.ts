/**
 * Context packing for the model tiers (PRD 5.8.5).
 *
 * Gemini Nano has a small context window, so we can't hand it everything
 * retrieval found — topN hits plus their neighbour expansion can be a dozen
 * chunks. We keep the best few by fused score, always keeping a hit's
 * neighbours adjacent to it so a procedure stays contiguous, and stop at a
 * token budget.
 */

import type { RetrievedChunk } from "@/domain/retrieval.js";
import { estimateTokens } from "@/lib/chunk.js";

/** Nano's practical ceiling once the instructions and question are allowed for. */
export const NANO_TOKEN_BUDGET = 1800;
/** PRD 5.8.5: 4–6 chunks max. */
export const NANO_MAX_CHUNKS = 6;

export interface PackOptions {
  readonly maxChunks: number;
  readonly tokenBudget: number;
}

export const NANO_PACK: PackOptions = {
  maxChunks: NANO_MAX_CHUNKS,
  tokenBudget: NANO_TOKEN_BUDGET,
};

/** BYOK providers have room for the full retrieval set. */
export const BYOK_PACK: PackOptions = { maxChunks: 20, tokenBudget: 12_000 };

/**
 * Select the chunks to send, preserving retrieval order. A direct hit is
 * admitted with the neighbours that follow it, so we never emit a neighbour
 * whose anchor hit was dropped — that would show context with no citation.
 */
export function packContext(
  chunks: readonly RetrievedChunk[],
  options: PackOptions = NANO_PACK,
): RetrievedChunk[] {
  const out: RetrievedChunk[] = [];
  let tokens = 0;

  for (const chunk of chunks) {
    if (out.length >= options.maxChunks) break;
    // Only keep a neighbour when its hit made the cut.
    if (chunk.viaNeighbour && !out.some((c) => c.url === chunk.url && !c.viaNeighbour)) continue;

    const cost = estimateTokens(chunk.body);
    if (tokens > 0 && tokens + cost > options.tokenBudget) {
      // Direct hits are worth continuing for; a neighbour that doesn't fit is
      // simply dropped, since it's supporting context rather than the answer.
      if (chunk.viaNeighbour) continue;
      break;
    }
    out.push(chunk);
    tokens += cost;
  }
  return out;
}
