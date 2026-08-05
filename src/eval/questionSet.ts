/**
 * The labelled question set the real eval runs on (PRD §7.1).
 *
 * JSONL rather than a TypeScript fixture, deliberately: the people who know
 * which answers are right are support engineers reading tickets, not whoever
 * can open a `.ts` file. One question per line, appendable, diffable, and
 * reviewable in a merge request without touching code.
 *
 * A question labels its answer by **URL**, not by chunk id. Chunk ids are
 * reassigned by every re-crawl, so an id-labelled set silently rots the first
 * time the site is refreshed; a URL survives.
 */

import { z } from "zod";

export const evalQuestionSchema = z.object({
  question: z.string().min(1),
  /**
   * URLs of the articles that genuinely answer this question.
   *
   * An **empty list is meaningful**: it marks a question the index cannot
   * answer, and answering it counts against the false-answer rate. Adversarial
   * cases are not a separate file — a help centre's real gaps are discovered
   * alongside its coverage, and splitting them invites keeping only one set
   * up to date.
   */
  answerUrls: z.array(z.string().url()).default([]),
  /**
   * Phrases a *complete* answer has to contain — the step that gets dropped,
   * the caveat that matters. This is what makes "incomplete" measurable rather
   * than a matter of opinion: an answer that finds the right page and stops
   * halfway scores full recall and poor coverage, and the two numbers point at
   * different fixes.
   */
  mustInclude: z.array(z.string().min(1)).default([]),
  /** Free text for whoever labels it — where it came from, why it's tricky. */
  notes: z.string().optional(),
});

export type EvalQuestion = z.infer<typeof evalQuestionSchema>;

export interface ParseResult {
  readonly questions: readonly EvalQuestion[];
  /** Per-line problems, reported rather than thrown — see below. */
  readonly errors: readonly string[];
}

/**
 * Parse a JSONL question set.
 *
 * Bad lines are collected, not thrown on. A hand-maintained file of a hundred
 * questions will have a typo in it, and failing the whole run over line 47
 * teaches people to stop adding questions — which costs far more than the one
 * line does.
 */
export function parseQuestionSet(text: string): ParseResult {
  const questions: EvalQuestion[] = [];
  const errors: string[] = [];

  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("//")) return;

    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      errors.push(`line ${i + 1}: not valid JSON`);
      return;
    }

    const parsed = evalQuestionSchema.safeParse(json);
    if (!parsed.success) {
      const why = parsed.error.issues.map((p) => `${p.path.join(".") || "?"}: ${p.message}`);
      errors.push(`line ${i + 1}: ${why.join("; ")}`);
      return;
    }
    questions.push(parsed.data);
  });

  return { questions, errors };
}

/** Questions with a known answer — what recall is measured over. */
export function answerable(questions: readonly EvalQuestion[]): EvalQuestion[] {
  return questions.filter((q) => q.answerUrls.length > 0);
}

/** Questions the index should refuse — what the false-answer rate is measured over. */
export function unanswerable(questions: readonly EvalQuestion[]): EvalQuestion[] {
  return questions.filter((q) => q.answerUrls.length === 0);
}
