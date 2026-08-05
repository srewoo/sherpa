/**
 * The query → answer orchestration behind the side panel (PRD 5.8). Retrieves,
 * applies the refusal floor (5.8.8) — below it we skip generation entirely and
 * return the nearest pages — otherwise emits the sources then streams the
 * chosen generator. Transport-agnostic: retrieve + generator are injected, so
 * it's unit-testable and reused verbatim in the offscreen doc.
 */

import type { AnswerGenerator, AnswerTier } from "@/domain/generator.js";
import type { RetrievedArticle } from "@/domain/retrieval.js";
import type { RetrieveResult } from "@/retrieval/retrieve.js";
import { REFUSAL_TEXT } from "./prompt.js";
import {
  verdictFor,
  verdictWithoutDense,
  type Certainty,
  type ConfidenceFloors,
} from "@/retrieval/confidence.js";
import {
  chooseDisambiguation,
  type DisambiguationOption,
  type DisambiguationOptions,
} from "@/retrieval/disambiguate.js";

/**
 * Why an answer was withheld.
 *
 * These are genuinely different events and must not be collapsed. "Below the
 * floor" means retrieval found nothing close enough to be worth reading.
 * "Model declined" means retrieval found strong matches — the panel is showing
 * them at 75% — and the model still judged they did not answer the question.
 * Reporting the first when the second happened puts a claim on screen that the
 * numbers directly underneath it disprove.
 */
export type RefusalReason =
  /** Retrieval found nothing close enough to be worth reading. */
  | "below-floor"
  /** Retrieval found strong matches; the model still couldn't answer from them. */
  | "model-declined"
  /** There is no index to search yet — not a judgement about anything. */
  | "no-index"
  /** Restored from a conversation saved before the reason was recorded. */
  | "unknown";

export type AnswerEvent =
  | {
      readonly kind: "sources";
      readonly tier: AnswerTier;
      readonly sources: readonly RetrievedArticle[];
      readonly topScore: number;
      /** "uncertain" when the best match was only middling — the UI says so. */
      readonly certainty: Certainty;
    }
  /**
   * Retrieval found several genuinely different things rather than one answer.
   * Asking beats guessing the top hit, and beats refusing content that is
   * plainly there — the user knows which one they meant.
   */
  | {
      readonly kind: "disambiguation";
      readonly options: readonly DisambiguationOption[];
    }
  | { readonly kind: "delta"; readonly delta: string }
  | {
      readonly kind: "refusal";
      readonly nearest: readonly RetrievedArticle[];
      readonly topScore: number;
      readonly reason: RefusalReason;
    }
  | { readonly kind: "done" };

export interface AnswerServiceDeps {
  readonly retrieve: (query: string) => Promise<RetrieveResult>;
  readonly generator: AnswerGenerator;
  /** Cosine bands: below `refuse` decline, above `confident` answer plainly. */
  readonly floors: ConfidenceFloors;
  /** Scatter rule for offering options instead of guessing. */
  readonly disambiguation?: DisambiguationOptions;
}

export async function* answerQuery(
  deps: AnswerServiceDeps,
  query: string,
): AsyncIterable<AnswerEvent> {
  const res = await deps.retrieve(query);
  const articles = res.articles;

  /**
   * With no dense half the cosine floor is meaningless — see
   * `verdictWithoutDense`. Everything else runs unchanged.
   */
  const verdict = res.denseAvailable
    ? verdictFor(res.topScore, articles.length > 0, deps.floors)
    : verdictWithoutDense(articles.length > 0);

  if (verdict.kind === "refuse") {
    yield {
      kind: "refusal",
      nearest: articles.slice(0, 3),
      topScore: res.topScore,
      reason: "below-floor",
    };
    yield { kind: "done" };
    return;
  }

  /**
   * Checked before generating, not after: the whole point is to avoid spending
   * a model call — and the user's attention — on an answer to a question we
   * are not confident we understood.
   */
  const options = chooseDisambiguation(articles, deps.disambiguation);
  if (options) {
    yield { kind: "disambiguation", options };
    yield { kind: "done" };
    return;
  }

  yield {
    kind: "sources",
    tier: deps.generator.tier,
    sources: articles,
    topScore: res.topScore,
    certainty: verdict.certainty,
  };

  let answer = "";
  for await (const chunk of deps.generator.answer({ query, context: articles })) {
    answer += chunk.delta;
    yield { kind: "delta", delta: chunk.delta };
  }

  // The grounding prompt tells the model to reply with REFUSAL_TEXT when the
  // context doesn't answer the question, and it does — but retrieval had
  // already cleared the score floor, so the UI was left showing "I don't have
  // that in this index" above six confident-looking sources. Honour the
  // model's judgement and present it as the refusal it is (PRD 5.8.8).
  if (isRefusal(answer)) {
    yield {
      kind: "refusal",
      nearest: articles.slice(0, 3),
      topScore: res.topScore,
      reason: "model-declined",
    };
  }

  yield { kind: "done" };
}

/** Did the model decline to answer? Matches the sentinel the prompt asks for. */
export function isRefusal(answer: string): boolean {
  const text = answer.trim().replace(/\s+/g, " ").toLowerCase();
  if (text === "") return false;
  const sentinel = REFUSAL_TEXT.toLowerCase().replace(/[.]$/, "");
  // A refusal is the whole reply, not a caveat inside a longer answer.
  return text.length < sentinel.length + 40 && text.includes(sentinel);
}
