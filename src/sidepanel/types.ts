/** View models for the side-panel chat (PRD 5.9). UI-only shapes. */

import type { AnswerTier } from "@/domain/generator.js";

export interface SourceView {
  readonly index: number;
  readonly title: string;
  readonly breadcrumb: string;
  readonly snippet: string;
  readonly relevance: number; // 0–100
  readonly url: string;
  readonly displayUrl: string;
}

export type AnswerState =
  | { readonly kind: "answer"; readonly tier: AnswerTier; readonly html: string; readonly sources: readonly SourceView[] }
  | { readonly kind: "refusal"; readonly nearest: readonly SourceView[] };

export interface Turn {
  readonly id: string;
  readonly question: string;
  readonly answer: AnswerState;
}

const TIER_LABEL: Record<AnswerTier, string> = {
  extractive: "Extractive · ranked passages, no model",
  nano: "Answered with Chrome built-in model (Gemini Nano) · on-device",
  byok: "Answered with your configured provider",
};

export function tierLabel(tier: AnswerTier): string {
  return TIER_LABEL[tier];
}
