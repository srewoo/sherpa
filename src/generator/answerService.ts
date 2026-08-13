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
import { packContext } from "./context.js";
import {
  verdictFor,
  verdictWithoutDense,
  type Certainty,
  type ConfidenceFloors,
  type ScoreVerdict,
} from "@/retrieval/confidence.js";
import {
  chooseRefinements,
  type RefineOption,
  type RefineOptions,
} from "@/retrieval/refine.js";
import type { Facet } from "@/retrieval/facet.js";

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
   * Retrieval found several genuinely different things as well as an answer.
   *
   * Emitted *after* the answer, never instead of it. An earlier version asked
   * before answering and could leave a user with no answer at all — see
   * retrieval/refine.ts. Offering costs nothing; demanding cost everything.
   */
  | {
      readonly kind: "refine";
      readonly options: readonly RefineOption[];
      /** The axis the options differ along, when a model could name one. */
      readonly facet?: Facet;
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
  /** Scatter rule for offering alternatives alongside the answer. */
  readonly refine?: RefineOptions;
  /**
   * This turn is a refinement pick: the user named an exact page.
   *
   * It suspends the refusal floor, and only the floor. The floor exists to stop
   * Sherpa answering from pages nobody asked for — but here somebody did ask,
   * explicitly, by clicking a page Sherpa itself offered. Refusing it would
   * rebuild the dead end this whole change removes, in a worse form: the
   * interface would be declining its own suggestion. The answer is hedged
   * instead, which is what the "uncertain" band is for.
   */
  readonly focused?: boolean;
  /** Override the facet wait. Tests only; production uses the constant. */
  readonly facetTimeoutMs?: number;
  /**
   * Names the axis the alternatives differ along. Started as soon as retrieval
   * lands and awaited only after generation, so it overlaps the entire stream
   * and costs the user no waiting. Omitted when no model can run it.
   */
  readonly deriveFacet?: (
    query: string,
    articles: readonly RetrievedArticle[],
  ) => Promise<Facet | undefined>;
}

/**
 * How long the facet may hold up `done` after the answer has finished.
 *
 * Generous enough for a remote provider that is merely slow, short enough that
 * a stalled one is invisible: the answer is already on screen, and all that is
 * lost is a nicer question above chips that are shown either way.
 */
export const FACET_TIMEOUT_MS = 3000;

/** Resolve to `undefined` rather than wait forever. Never rejects. */
async function withTimeout<T>(
  promise: Promise<T | undefined> | undefined,
  ms: number,
): Promise<T | undefined> {
  if (!promise) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    // The losing promise keeps running; only the wait is bounded.
    if (timer) clearTimeout(timer);
  }
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
  const scored = res.denseAvailable
    ? verdictFor(res.topScore, articles.length > 0, deps.floors)
    : verdictWithoutDense(articles.length > 0);

  /**
   * A pick overrides the floor, never the emptiness check: with no articles
   * there is still nothing to answer from, and saying so is correct.
   */
  const verdict: ScoreVerdict =
    deps.focused && scored.kind === "refuse" && articles.length > 0
      ? { kind: "answer", certainty: "uncertain" }
      : scored;

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
   * Pack once, here, and use the result for both the citation list and the
   * grounding.
   *
   * Each generator used to pack privately, so the `sources` event carried every
   * assembled article while the model had been sent only the first few. A card
   * numbered [5] could therefore refer to a page the answer was never grounded
   * in — the exact failure the citation-bounding in `markdown.ts` exists to
   * prevent, arriving from the other direction. One list now means one thing.
   *
   * Refinement chips still consider the full set: a chip is navigation, not
   * provenance, and a page worth offering need not have grounded this answer.
   */
  const context = packContext(articles, deps.generator.pack);

  /**
   * Computed now, emitted last. Deciding early and yielding late is what makes
   * this advisory: by the time the user sees a chip they are already reading an
   * answer, so declining to click costs them nothing.
   */
  const refinements = chooseRefinements(articles, deps.refine);

  /**
   * Started before generation, awaited after it — the model call that names the
   * axis runs alongside the entire answer stream rather than in front of it.
   * `deriveFacet` already swallows its own failures; the catch covers a caller
   * that doesn't, because a facet is a nicety and must never break an answer.
   */
  const facetPromise =
    refinements.length > 0 && deps.deriveFacet
      ? deps.deriveFacet(query, articles).catch(() => undefined)
      : undefined;

  yield {
    kind: "sources",
    tier: deps.generator.tier,
    sources: context,
    topScore: res.topScore,
    certainty: verdict.certainty,
  };

  let answer = "";
  for await (const chunk of deps.generator.answer({ query, context })) {
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
      nearest: context.slice(0, 3),
      topScore: res.topScore,
      reason: "model-declined",
    };
    // No refinements here. "I couldn't answer from these" followed by "did you
    // mean one of these?" reads as a contradiction, and the nearest-pages list
    // already gives the user somewhere to go.
    yield { kind: "done" };
    return;
  }

  if (refinements.length > 0) {
    /**
     * Bounded, because `done` is load-bearing downstream: the panel clears the
     * streaming state, persists the turn and detaches its message listener on
     * it. An unbounded await meant a slow BYOK provider held a finished answer
     * in "writing…" — and a hung fetch (no `AbortSignal` in `byok.ts`) stranded
     * the turn permanently and leaked the listener. The facet is worth a short
     * wait and nothing more; timing out yields the title chips.
     */
    const facet = await withTimeout(facetPromise, deps.facetTimeoutMs ?? FACET_TIMEOUT_MS);
    yield { kind: "refine", options: refinements, ...(facet ? { facet } : {}) };
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
