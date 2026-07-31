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

export async function pickGenerator(settings: AnswerSettings): Promise<AnswerGenerator> {
  if (settings.mode === "byok" && settings.apiKey && settings.provider && settings.model) {
    return new ByokGenerator({
      provider: settings.provider,
      model: settings.model,
      apiKey: settings.apiKey,
    });
  }
  const nano = new NanoGenerator();
  if ((await nano.availability()).state === "available") return nano;
  return new ExtractiveGenerator();
}
