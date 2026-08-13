/** View models for the side-panel chat (PRD 5.9). UI-only shapes. */

import type { AnswerTier } from "@/domain/generator.js";
import type { RefusalReason } from "@/generator/answerService.js";
import type { Certainty } from "@/retrieval/confidence.js";
import type { RefineOption } from "@/retrieval/refine.js";
import type { Facet } from "@/retrieval/facet.js";

/**
 * Alternatives offered beneath a finished answer.
 *
 * Deliberately a field on an answer rather than an answer kind of its own. That
 * shape is the fix: refinement can only ever accompany an answer, so there is
 * no state in which the panel shows chips and nothing else — which is exactly
 * the state users used to get stuck in.
 */
export interface RefineView {
  readonly options: readonly RefineOption[];
  /** Set when a model could name what the options differ by. */
  readonly facet?: Facet;
}

export interface SourceView {
  /** 1-based citation number, matching the `[n]` markers in the answer. */
  readonly index: number;
  readonly title: string;
  readonly breadcrumb: string;
  readonly snippet: string;
  readonly relevance: number; // 0–100
  readonly url: string;
  readonly displayUrl: string;
}

export type AnswerState =
  | {
      readonly kind: "answer";
      readonly tier: AnswerTier;
      /** Rendered HTML for display. */
      readonly html: string;
      /** The raw markdown, kept for copy-with-citations (PRD 5.9.6). */
      readonly markdown: string;
      readonly sources: readonly SourceView[];
      /** True while tokens are still streaming. */
      readonly pending?: boolean;
      /** Set when the answering tier isn't the one selected in Settings. */
      readonly notice?: string;
      /** "uncertain" when the match was middling; the panel shows a caveat. */
      readonly certainty?: Certainty;
      /** Other readings of the question, shown under the answer. */
      readonly refine?: RefineView;
    }
  | {
      readonly kind: "refusal";
      readonly nearest: readonly SourceView[];
      readonly reason: RefusalReason;
      readonly detail?: string;
    };

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
