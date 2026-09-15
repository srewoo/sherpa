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
      /**
       * Nothing was searched and no model ran — a greeting, answered locally.
       *
       * Suppresses the tier line and the source list, because both are
       * provenance claims and there is no provenance to report. Showing
       * "Extractive · ranked passages, no model" beneath "Hello" would assert a
       * search that never happened.
       */
      readonly conversational?: boolean;
    }
  | {
      readonly kind: "refusal";
      readonly nearest: readonly SourceView[];
      readonly reason: RefusalReason;
      readonly detail?: string;
      /**
       * Retrieval was strong and the model declined anyway.
       *
       * Changes the copy from a guess into a statement, and it is the guess
       * that made the old screen indefensible: "the wording may not match how
       * your docs put it" sat directly above three sources reading 86%, 79% and
       * 76%. At those numbers the wording matched.
       */
      readonly confident?: boolean;
      /**
       * Per-page picks offered *with* the refusal.
       *
       * A pick sets `focused`, which suspends the refusal floor and answers
       * from that one document — the one mechanism that reliably gets past a
       * decline, and it used to be withheld from precisely the turn that needed
       * it. Same shape as `RefineView` on an answer, deliberately: it is the
       * same control doing the same thing.
       */
      readonly refine?: RefineView;
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
