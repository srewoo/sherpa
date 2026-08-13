/**
 * Tier 1 — Chrome Prompt API / Gemini Nano (PRD 5.8.2–5.8.5). On-device, free,
 * the default. Availability is re-checked every session because Nano is evicted
 * when free disk drops (5.8.4); the selector degrades to Tier 0 when it reports
 * unavailable. Context is already budgeted to a handful of chunks by retrieval.
 */

import type { AnswerChunk, AnswerGenerator, AnswerRequest, TierAvailability } from "@/domain/generator.js";
import type { LanguageModelOptions } from "./prompt-api.js";
import { buildGroundedPrompt } from "./prompt.js";
import { NANO_PACK } from "./context.js";

/**
 * Sherpa is English-first (PRD §0, assumption 6) and the embedding model is
 * English-only, so both sides of the session are declared as English.
 *
 * Chrome requires this: an unspecified output language logs "An output language
 * should be specified… properly attest to output safety", and the model is
 * documented to produce lower-quality output without it. Multilingual is the
 * known P2 lift — when it lands, this becomes the index's detected language
 * rather than a constant.
 */
const LANGUAGE = "en";

const SESSION_OPTIONS: LanguageModelOptions = {
  expectedInputs: [{ type: "text", languages: [LANGUAGE] }],
  expectedOutputs: [{ type: "text", languages: [LANGUAGE] }],
};

/**
 * One-shot completion, for uses that aren't answering a question — currently
 * HyDE's hypothetical passage (see retrieval/hyde.ts). Kept separate from the
 * AnswerGenerator interface, which is about grounded answers with citations and
 * would be the wrong shape for this.
 */
export async function nanoComplete(prompt: string): Promise<string> {
  if (typeof LanguageModel === "undefined") throw new Error("Nano unavailable");
  const session = await LanguageModel.create(SESSION_OPTIONS);
  try {
    return await session.prompt(prompt);
  } finally {
    session.destroy();
  }
}

export class NanoGenerator implements AnswerGenerator {
  readonly tier = "nano" as const;
  readonly pack = NANO_PACK;

  /** Query understanding runs on the same on-device session answers use. */
  complete(prompt: string): Promise<string> {
    return nanoComplete(prompt);
  }

  async availability(): Promise<TierAvailability> {
    if (typeof LanguageModel === "undefined") {
      return { tier: this.tier, state: "unavailable", detail: "Prompt API not present" };
    }
    // Availability is language-dependent, so it's asked with the same options
    // the session will be created with.
    return { tier: this.tier, state: await LanguageModel.availability(SESSION_OPTIONS) };
  }

  async *answer(req: AnswerRequest): AsyncIterable<AnswerChunk> {
    if (typeof LanguageModel === "undefined") {
      throw new Error("Nano unavailable");
    }
    // Already packed to NANO_PACK by the answer service, so the cards the user
    // sees and the context grounding this reply are the same list (PRD 5.8.5).
    const context = req.context;
    const session = await LanguageModel.create(SESSION_OPTIONS);
    try {
      const stream = session.promptStreaming(buildGroundedPrompt(req.query, context));
      for await (const piece of stream) yield { delta: piece };
    } finally {
      session.destroy();
    }
  }
}
