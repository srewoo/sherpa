/**
 * The answer-generator interface (PRD 5.8).
 *
 * Retrieval is agnostic to which tier is active. Everything downstream depends
 * only on `AnswerGenerator`, so the LLM tier can change — Extractive (Tier 0),
 * Chrome Prompt API / Gemini Nano (Tier 1), BYO key (Tier 2) — without the
 * index or the retrieval path knowing.
 */

import type { RetrievedArticle } from "@/domain/retrieval.js";

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
  /** Assembled articles, best first (PRD 5.7). Each is one citable source. */
  readonly context: readonly RetrievedArticle[];
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
  /**
   * Run a short, non-grounded prompt and return the whole reply.
   *
   * This exists for the query-understanding steps — HyDE and query rewriting —
   * which need a model but not *this* model's answering behaviour. They used to
   * call Chrome's Nano directly, which meant that with a BYOK key configured
   * and Nano unavailable (the common case) both features silently did nothing:
   * two settings the user had switched on, costing nothing and doing nothing.
   *
   * Optional, because not every tier has a model behind it. Extractive omits it
   * and the features correctly stay off rather than pretending.
   */
  complete?(prompt: string): Promise<string>;
}
