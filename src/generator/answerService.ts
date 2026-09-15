/**
 * The query → answer orchestration behind the side panel (PRD 5.8). Retrieves,
 * applies the refusal floor (5.8.8) — below it we skip generation entirely and
 * return the nearest pages — otherwise emits the sources then streams the
 * chosen generator. Transport-agnostic: retrieve + generator are injected, so
 * it's unit-testable and reused verbatim in the offscreen doc.
 */

import type { AnswerGenerator, AnswerTier } from "@/domain/generator.js";
import type { RefusalReason } from "@/domain/records.js";
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
 * Re-exported from `domain/records.ts`, where it is declared.
 *
 * It moved there because `IndexMeta` — a stored record, and therefore squarely
 * domain vocabulary — needs it, and a domain type reaching up into the
 * generator layer to borrow one inverted the whole dependency graph: it put
 * `domain` above `generator`, which is above `retrieval`, which is above
 * `domain`, and produced twenty-six import cycles from one line. Kept exported
 * here so every existing import site still reads naturally.
 */
export type { RefusalReason };

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
  /**
   * Discard the text streamed so far; what follows comes from another tier.
   *
   * The chosen model declined, and a tier that cannot decline is being tried in
   * its place. This has to be an event rather than a silent swap because the
   * declined sentence has *already* been streamed to the panel — the deltas go
   * out as they arrive, and `isRefusal` can only be evaluated once the reply is
   * complete. Without a reset the user would read "I don't have that in this
   * index." with a passage extract appended underneath it.
   */
  | {
      readonly kind: "restart";
      readonly tier: AnswerTier;
      /** Why the tier changed, shown as the same notice a fallback uses. */
      readonly notice: string;
    }
  | {
      readonly kind: "refusal";
      readonly nearest: readonly RetrievedArticle[];
      readonly topScore: number;
      readonly reason: RefusalReason;
      /** The provider's own message, when there is one worth showing. */
      readonly detail?: string;
      /**
       * Retrieval was not merely adequate, it was strong — the top match sat at
       * or above the `confident` band and the model still declined.
       *
       * Carried because it changes what is *true*. The panel's copy for a
       * decline used to guess out loud ("the wording may not match how your
       * docs put it") and at 86% cosine that guess is almost certainly wrong:
       * the wording matched, and something in the pipeline — the chunk that got
       * packed, or a grounding prompt too strict to commit — is the likelier
       * culprit. It also stops the gap report filing this as *missing content*
       * and recommending a page that already exists.
       */
      readonly confident?: boolean;
      /**
       * Somewhere to go, offered *with* the refusal rather than withheld from it.
       *
       * These were deliberately suppressed here, on the reasoning that "I
       * couldn't answer from these" followed by "did you mean one of these?"
       * reads as a contradiction. It does — but suppressing them left the turn
       * a dead end whose only remaining instruction was "rephrase", while the
       * one mechanism that would have worked sat unused: picking a page sets
       * `focused`, which suspends the floor by design and answers from that
       * document alone. Sherpa was declining and hiding its own escape hatch.
       */
      readonly refine?: { readonly options: readonly RefineOption[]; readonly facet?: Facet };
    }
  | { readonly kind: "done" };

export interface AnswerServiceDeps {
  readonly retrieve: (query: string) => Promise<RetrieveResult>;
  readonly generator: AnswerGenerator;
  /** Cosine bands: below `refuse` decline, above `confident` answer plainly. */
  readonly floors: ConfidenceFloors;
  /**
   * A tier that cannot decline, tried when the chosen model does.
   *
   * The Extractive tier returns the best-matching passages verbatim; it has no
   * judgement to exercise and therefore no way to refuse. When retrieval was
   * strong and a model still would not commit, a labelled passage extract from
   * an 86%-matching page is strictly more use than a banner and three links —
   * and the pages were going to be shown either way.
   *
   * Optional, and skipped when it *is* the answering tier: there is nothing to
   * escalate to when extraction already ran, and re-running it would only
   * stream the same text twice.
   */
  readonly fallback?: AnswerGenerator;
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

/**
 * Shown when a decline is answered by extraction instead of a refusal.
 *
 * Says what happened rather than dressing it up. The passage is quoted from the
 * pages, not composed, and claiming otherwise would be the same overreach as
 * the copy this whole path replaces.
 */
export const ESCALATION_NOTICE =
  "The answering model wouldn't commit to an answer from these pages, so this is a passage extract from them instead.";

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

  /**
   * A generator that throws must say so.
   *
   * Previously this propagated out of `answerQuery`, past the offscreen
   * handler's catch, and became a bare `done` — the panel cleared its pending
   * state and left an empty answer with no error, no refusal and nothing to
   * act on. An unreachable provider is a perfectly ordinary thing to happen and
   * the only unacceptable way to report it is silently.
   */
  let answer = "";
  try {
    for await (const chunk of deps.generator.answer({ query, context })) {
      answer += chunk.delta;
      yield { kind: "delta", delta: chunk.delta };
    }
  } catch (error) {
    yield {
      kind: "refusal",
      nearest: context.slice(0, 3),
      topScore: res.topScore,
      reason: "generator-error",
      detail: error instanceof Error ? error.message : String(error),
    };
    yield { kind: "done" };
    return;
  }

  /**
   * The model declined. Climb down the ladder before believing it.
   *
   * The grounding prompt asks for REFUSAL_TEXT when the context doesn't answer
   * the question, and models oblige — but retrieval had already cleared the
   * floor, so the panel showed "I found related pages but couldn't answer from
   * them" above three sources reading 86%, 79% and 76%. The user can see both
   * numbers. Only one of them can be true, and at 86% it is not the refusal.
   *
   * So a decline is now the *start* of the handling rather than the end of it:
   * try a tier that cannot decline, and only refuse if that produces nothing
   * either — and when refusing, offer the per-page pick that suspends the floor
   * instead of withholding it.
   */
  if (isRefusal(answer)) {
    const confident = res.denseAvailable && res.topScore >= deps.floors.confident;
    const facet =
      refinements.length > 0
        ? await withTimeout(facetPromise, deps.facetTimeoutMs ?? FACET_TIMEOUT_MS)
        : undefined;
    const refine =
      refinements.length > 0
        ? { options: refinements, ...(facet ? { facet } : {}) }
        : undefined;

    if (deps.fallback && deps.fallback.tier !== deps.generator.tier) {
      /**
       * Replace the declined sentence, don't append to it.
       *
       * The refusal text has already reached the panel as deltas — they stream
       * as they arrive and `isRefusal` can only judge a finished reply — so the
       * reset has to be explicit or the extract lands underneath "I don't have
       * that in this index."
       */
      yield { kind: "restart", tier: deps.fallback.tier, notice: ESCALATION_NOTICE };
      let extracted = "";
      try {
        for await (const chunk of deps.fallback.answer({ query, context })) {
          extracted += chunk.delta;
          yield { kind: "delta", delta: chunk.delta };
        }
      } catch {
        // A fallback that fails changes nothing: we were about to refuse
        // anyway, and the refusal below is a better report than its error.
        extracted = "";
      }
      if (extracted.trim() !== "" && !isRefusal(extracted)) {
        if (refine) yield { kind: "refine", ...refine };
        yield { kind: "done" };
        return;
      }
    }

    yield {
      kind: "refusal",
      nearest: context.slice(0, 3),
      topScore: res.topScore,
      reason: "model-declined",
      ...(confident ? { confident } : {}),
      ...(refine ? { refine } : {}),
    };
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
