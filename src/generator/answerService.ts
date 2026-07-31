/**
 * The query → answer orchestration behind the side panel (PRD 5.8). Retrieves,
 * applies the refusal floor (5.8.8) — below it we skip generation entirely and
 * return the nearest pages — otherwise emits the sources then streams the
 * chosen generator. Transport-agnostic: retrieve + generator are injected, so
 * it's unit-testable and reused verbatim in the offscreen doc.
 */

import type { AnswerGenerator, AnswerTier } from "@/domain/generator.js";
import type { RetrievedChunk } from "@/domain/retrieval.js";
import type { RetrieveResult } from "@/retrieval/retrieve.js";

export type AnswerEvent =
  | { readonly kind: "sources"; readonly tier: AnswerTier; readonly sources: readonly RetrievedChunk[]; readonly topScore: number }
  | { readonly kind: "delta"; readonly delta: string }
  | { readonly kind: "refusal"; readonly nearest: readonly RetrievedChunk[]; readonly topScore: number }
  | { readonly kind: "done" };

export interface AnswerServiceDeps {
  readonly retrieve: (query: string) => Promise<RetrieveResult>;
  readonly generator: AnswerGenerator;
  /** Below this best-cosine score, refuse instead of guessing. */
  readonly floor: number;
}

export async function* answerQuery(
  deps: AnswerServiceDeps,
  query: string,
): AsyncIterable<AnswerEvent> {
  const res = await deps.retrieve(query);
  const direct = res.chunks.filter((c) => !c.viaNeighbour);

  if (direct.length === 0 || res.topScore < deps.floor) {
    yield { kind: "refusal", nearest: direct.slice(0, 3), topScore: res.topScore };
    yield { kind: "done" };
    return;
  }

  yield { kind: "sources", tier: deps.generator.tier, sources: direct, topScore: res.topScore };
  for await (const chunk of deps.generator.answer({ query, context: res.chunks })) {
    yield { kind: "delta", delta: chunk.delta };
  }
  yield { kind: "done" };
}
