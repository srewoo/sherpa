/**
 * Answer-tier selection (PRD 5.8). BYOK when the user configured a key,
 * otherwise Chrome built-in Nano when it's available this session, otherwise the
 * always-available Extractive tier. Availability is re-checked each call so Nano
 * eviction degrades gracefully with no dead end (5.8.4, 8.1).
 */

import type { AnswerGenerator, ByokProvider } from "@/domain/generator.js";
import { NanoGenerator } from "./nano.js";
import { ByokGenerator } from "./byok.js";
import { ExtractiveGenerator } from "./extractive.js";

export interface AnswerSettings {
  readonly mode: "auto" | "byok";
  readonly provider?: ByokProvider;
  readonly model?: string;
  readonly apiKey?: string;
}

/**
 * Why a BYOK selection can't be honoured, or null when it can.
 *
 * Selection used to fail closed and say nothing: choose OpenAI, leave the key
 * field empty, and answers came from Nano while Settings still showed OpenAI
 * selected. The user is left with a UI that contradicts the product's own
 * behaviour and no way to tell which is lying. Every fallback now has a reason
 * attached, and the panel shows it.
 */
export function byokIssue(settings: AnswerSettings): string | null {
  if (settings.mode !== "byok") return null;
  if (!settings.provider) return "No provider chosen.";
  if (!settings.model) return "No model chosen.";
  if (!settings.apiKey?.trim()) return `No API key saved for ${settings.provider}.`;
  return null;
}

export interface GeneratorChoice {
  readonly generator: AnswerGenerator;
  /** Set when the tier in use is not the tier the user asked for. */
  readonly notice?: string;
}

export async function selectGenerator(settings: AnswerSettings): Promise<GeneratorChoice> {
  const issue = byokIssue(settings);

  if (settings.mode === "byok" && !issue) {
    return {
      generator: new ByokGenerator({
        provider: settings.provider!,
        model: settings.model!,
        apiKey: settings.apiKey!.trim(),
      }),
    };
  }

  const fallback = issue ? `${issue} Using the on-device model instead.` : undefined;

  const nano = new NanoGenerator();
  if ((await nano.availability()).state === "available") {
    return fallback ? { generator: nano, notice: fallback } : { generator: nano };
  }

  const extractive = new ExtractiveGenerator();
  const notice = issue
    ? `${issue} The on-device model is unavailable too, so this is a passage extract.`
    : undefined;
  return notice ? { generator: extractive, notice } : { generator: extractive };
}

/** Back-compat wrapper for callers that only need the generator. */
export async function pickGenerator(settings: AnswerSettings): Promise<AnswerGenerator> {
  return (await selectGenerator(settings)).generator;
}
