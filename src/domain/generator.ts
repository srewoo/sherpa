/**
 * The answer-generator interface (PRD 5.8).
 *
 * Retrieval is agnostic to which tier is active. Everything downstream depends
 * only on `AnswerGenerator`, so the LLM tier can change — Extractive (Tier 0),
 * Chrome Prompt API / Gemini Nano (Tier 1), BYO key (Tier 2) — without the
 * index or the retrieval path knowing.
 */

import type { RetrievedChunk } from "@/domain/retrieval.js";

export type AnswerTier = "extractive" | "nano" | "byok";

/** BYO provider identifiers surfaced in the settings UI. */
export type ByokProvider = "openai" | "anthropic" | "gemini";

export interface TierAvailability {
  readonly tier: AnswerTier;
  /** Mirrors LanguageModel.availability(): includes download states (5.8.3). */
  readonly state: "available" | "downloadable" | "downloading" | "unavailable";
  readonly detail?: string;
}

export interface AnswerRequest {
  readonly query: string;
  /** Fused, neighbour-expanded context, best first (PRD 5.7). */
  readonly context: readonly RetrievedChunk[];
  /** Prior turns in this session, for follow-up handling (PRD 5.9.3). */
  readonly history?: readonly { role: "user" | "assistant"; text: string }[];
}

export interface AnswerChunk {
  /** A streamed fragment of the answer (PRD 5.8.9). */
  readonly delta: string;
}

/**
 * Every tier implements this. `answer` streams tokens; the citation mapping is
 * resolved by the caller from the same `context` it passed in, so generators
 * never invent sources.
 */
export interface AnswerGenerator {
  readonly tier: AnswerTier;
  availability(): Promise<TierAvailability>;
  answer(req: AnswerRequest): AsyncIterable<AnswerChunk>;
}
