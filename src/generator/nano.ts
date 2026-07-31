/**
 * Tier 1 — Chrome Prompt API / Gemini Nano (PRD 5.8.2–5.8.5). On-device, free,
 * the default. Availability is re-checked every session because Nano is evicted
 * when free disk drops (5.8.4); the selector degrades to Tier 0 when it reports
 * unavailable. Context is already budgeted to a handful of chunks by retrieval.
 */

import type { AnswerChunk, AnswerGenerator, AnswerRequest, TierAvailability } from "@/domain/generator.js";
import { buildGroundedPrompt } from "./prompt.js";
import { packContext, NANO_PACK } from "./context.js";

export class NanoGenerator implements AnswerGenerator {
  readonly tier = "nano" as const;

  async availability(): Promise<TierAvailability> {
    if (typeof LanguageModel === "undefined") {
      return { tier: this.tier, state: "unavailable", detail: "Prompt API not present" };
    }
    return { tier: this.tier, state: await LanguageModel.availability() };
  }

  async *answer(req: AnswerRequest): AsyncIterable<AnswerChunk> {
    if (typeof LanguageModel === "undefined") {
      throw new Error("Nano unavailable");
    }
    // Nano's window is small: keep the best few chunks within a token budget
    // rather than sending everything retrieval expanded (PRD 5.8.5).
    const context = packContext(req.context, NANO_PACK);
    const session = await LanguageModel.create();
    try {
      const stream = session.promptStreaming(buildGroundedPrompt(req.query, context));
      for await (const piece of stream) yield { delta: piece };
    } finally {
      session.destroy();
    }
  }
}
