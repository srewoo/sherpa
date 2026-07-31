/**
 * Retrieval result shapes (PRD 5.7). A retrieved chunk is a stored chunk plus
 * the scoring provenance we show in source cards and use for the refusal floor.
 */

import type { StoredChunk } from "@/domain/records.js";

export interface RetrievedChunk extends StoredChunk {
  /** Fused RRF score; also compared against the refusal floor (PRD 5.8.8). */
  readonly score: number;
  /** 0-based rank in the dense list, if it appeared there. */
  readonly denseRank: number | undefined;
  /** 0-based rank in the BM25 list, if it appeared there. */
  readonly sparseRank: number | undefined;
  /** True when pulled in by neighbour expansion, not a direct hit (5.7.5). */
  readonly viaNeighbour: boolean;
}
