/**
 * Offscreen query handler. Retrieval needs the embedder + IndexedDB (both live
 * here), and Nano/BYOK generation runs here too, so the whole query→answer path
 * executes in the offscreen doc and streams UI events back to the side panel.
 */

import type { SherpaDatabase } from "@/storage/db.js";
import type { RetrievedArticle } from "@/domain/retrieval.js";
import type { PanelEvent } from "@/shared/answer.js";
import { articleToSource } from "@/shared/answer.js";
import { getEmbedder } from "@/embed/embedder.js";
import { retrieve } from "@/retrieval/retrieve.js";
import { answerQuery } from "@/generator/answerService.js";
import { selectGenerator } from "@/generator/select.js";
import { understand } from "@/retrieval/understand.js";
import { resolveFollowUp } from "@/retrieval/followUp.js";
import { deriveFacet } from "@/retrieval/facet.js";
import { loadPriors, invalidatePriors } from "@/retrieval/prior.js";
import { resultCache, cacheKey } from "@/retrieval/cache.js";
import { createReranker, type Reranker } from "@/retrieval/rerank.js";
import { loadSettings, type Settings } from "@/settings/settings.js";
import { queryLogStore } from "@/gap/queryLog.js";
import { indexRepo } from "@/storage/indexRepo.js";
import { floorsForIndex, rerankForIndex } from "@/retrieval/calibrate.js";

/**
 * The cross-encoder, cached across queries. `null` once a load has failed, so a
 * missing model costs one attempt rather than one per question.
 */
let rerankerCache: Promise<Reranker> | null | undefined;

async function getReranker(): Promise<Reranker | undefined> {
  if (rerankerCache === null) return undefined;
  rerankerCache ??= createReranker();
  try {
    return await rerankerCache;
  } catch {
    rerankerCache = null;
    return undefined;
  }
}

export async function runQuery(
  db: SherpaDatabase,
  indexId: string,
  query: string,
  emit: (event: PanelEvent) => void,
  currentUrl?: string,
  recentQuestions: readonly string[] = [],
  /** Set when the question came from a refinement chip naming an exact page. */
  focusUrl?: string,
  /** The question that pick answered, for the learned prior (prior.ts). */
  pickedFor?: string,
  /**
   * Settings as the panel read them.
   *
   * Preferred over reading them here. This document is the only context that
   * read settings for itself, and when its read disagreed with the panel's the
   * failure was invisible: defaults look identical to a user who chose the
   * defaults, so BYOK silently became "answered on-device" with no error and no
   * notice. Falls back to a local read for callers that send nothing.
   */
  provided?: Settings,
): Promise<void> {
  const settings = provided ?? (await loadSettings());
  const embedder = await getEmbedder();
  const { generator, notice } = await selectGenerator(settings.answer);

  /**
   * The model that runs query understanding: whichever tier is answering.
   *
   * Both features used to call `nanoComplete` directly, so with a BYOK key
   * configured and Chrome's Nano unavailable — the usual case — HyDE and query
   * rewriting silently did nothing at all. Two switches the user had turned on,
   * with no effect and no way to tell. Routing them through the selected
   * generator makes them work for BYOK; the Extractive tier has no model and
   * omits `complete`, so they correctly stay off there rather than pretending.
   */
  const complete = generator.complete?.bind(generator);

  const [meta, priors] = await Promise.all([
    indexRepo.get(db, indexId),
    // Cheap and cached; a failed read yields no priors rather than no search.
    loadPriors(db, indexId),
  ]);

  /**
   * Loaded once per offscreen document, and only if this index asked for it.
   * A missing model is the normal case — the weights are an opt-in fetch — so
   * failure here is "reranking is off", not an error.
   */
  const rerank = rerankForIndex(meta?.rerank, settings.rerank)
    ? await getReranker()
    : undefined;

  /**
   * Query understanding: follow-up resolution, rewriting and HyDE, resolved in
   * one place and at most one model call (see understand.ts).
   *
   * A chip pick skips it entirely. The user named a page; there is nothing left
   * to disambiguate, and letting a model rewrite a title it is about to be
   * scoped to anyway is pure risk on the critical path.
   */
  /**
   * What the model is actually asked.
   *
   * On a pick, `query` is the chip's *label* — with a facet chip that is a bare
   * axis value like "Zoom". Generating against it would prompt the model to
   * answer the single word "Zoom", and the transcript would show that as the
   * question. The user's real question is the one the chip was offered under,
   * so it is what gets answered; the label stays on screen as the visible turn,
   * which is how the conversation reads naturally.
   */
  const asked = pickedFor ?? query;

  /** One search, cached. Split out so it can be started speculatively. */
  const runRetrieve = async (search: string, denseText?: string) => {
    const key = cacheKey({
      indexId,
      search,
      ...(denseText ? { denseText } : {}),
      ...(currentUrl ? { currentUrl } : {}),
      ...(focusUrl ? { focusUrl } : {}),
      reranked: rerank !== undefined,
    });
    const cached = resultCache.get(key);
    if (cached) return cached;

    const result = await retrieve(
      {
        db,
        indexId,
        embedder,
        ...(currentUrl ? { currentUrl } : {}),
        ...(denseText ? { denseText } : {}),
        ...(rerank ? { rerank } : {}),
        ...(focusUrl ? { focusUrl } : {}),
        // Skipped on a pick: the result is already scoped to one page, and a
        // learned nudge cannot reorder a list of one.
        ...(!focusUrl && priors.length > 0 ? { priors } : {}),
      },
      search,
    );
    resultCache.set(key, result);
    return result;
  };

  /**
   * Speculative retrieval.
   *
   * Query understanding needs a model, and with BYOK that is a network round
   * trip sitting in front of every search — retrieval itself is ~25 ms, so the
   * model call dominates time-to-first-token while the index sits idle. But
   * most rewrites change nothing: `rejectionReason` discards anything risky and
   * a well-formed question is returned unchanged, so the plan usually *is* the
   * resolved text.
   *
   * So search on the resolved text immediately, in parallel. If the plan lands
   * on the same string with no HyDE passage, that result is already correct and
   * the model call cost nothing. Otherwise it is discarded and the real search
   * runs — no worse than before, because that search could not have started any
   * earlier anyway.
   *
   * Only when a model call will actually happen; otherwise `understand` returns
   * without awaiting anything and there is nothing to overlap.
   */
  const resolved = resolveFollowUp(query, recentQuestions);
  const willCallModel = !focusUrl && complete !== undefined && (settings.rewriteQueries || settings.hyde);
  const speculative = willCallModel ? runRetrieve(resolved) : undefined;
  // A rejected speculation must not surface as an unhandled rejection; the
  // awaited path re-runs and reports the real error.
  speculative?.catch(() => {});

  const plan = focusUrl
    ? { search: asked, source: "raw" as const }
    : await understand(query, recentQuestions, {
        ...(complete ? { complete } : {}),
        rewriteQueries: settings.rewriteQueries,
        hyde: settings.hyde,
      });

  const retrieval =
    speculative && plan.search === resolved && !plan.denseText
      ? speculative
      : runRetrieve(plan.search, plan.denseText);

  const deps = {
    // Retrieval searches the planned text; the user's own words are what the
    // model answers and what the UI shows.
    retrieve: (_q: string) => retrieval,
    generator,
    // Suspends the refusal floor for a page the user explicitly chose — see
    // AnswerServiceDeps.focused.
    ...(focusUrl ? { focused: true } : {}),
    /**
     * Names the axis the alternatives differ along. Only when a model exists —
     * the Extractive tier falls back to plain title chips, which is weaker but
     * never blocks and never invents.
     */
    ...(complete
      ? {
          deriveFacet: (q: string, articles: readonly RetrievedArticle[]) =>
            deriveFacet(q, articles, complete),
        }
      : {}),
    /**
     * The index's own measured bands, not the global constant.
     *
     * A cosine threshold depends on the model and the corpus together — the
     * shipped 0.45 sat below every score three real help centres produced for
     * unanswerable questions, so nothing could ever be refused. An index
     * calibrated at crawl time knows better than a constant does; Settings
     * still wins when the user has tuned it by hand, and an index built before
     * calibration existed falls back to Settings unchanged.
     */
    floors: floorsForIndex(meta?.floors, settings.floors, settings.floorsOverride),
  };

  let answered = false;
  let topScore = 0;
  let refined = false;
  for await (const event of answerQuery(deps, asked)) {
    if (event.kind === "sources") {
      answered = true;
      topScore = event.topScore;
      emit({
        kind: "sources",
        tier: event.tier,
        sources: event.sources.map(articleToSource),
        certainty: event.certainty,
        // Say so when the tier in use isn't the one Settings shows selected.
        ...(notice ? { notice } : {}),
      });
    } else if (event.kind === "refine") {
      refined = true;
      emit({ kind: "refine", options: event.options, ...(event.facet ? { facet: event.facet } : {}) });
    } else if (event.kind === "refusal") {
      // A model-declined refusal arrives *after* its sources, which already set
      // `answered`. Left alone, the gap report would count a turn the user saw
      // decline as a successful answer — and this is the case it most needs to
      // see, since strong retrieval the model still couldn't use is the sharpest
      // available signal that a page is missing or unclear.
      answered = false;
      topScore = event.topScore;
      emit({
        kind: "refusal",
        nearest: event.nearest.map(articleToSource),
        reason: event.reason,
        // Forwarded, not dropped. Without this the panel showed the generic
        // "could not produce an answer" and threw away the provider's own
        // message — the only part that says what to change.
        ...(event.detail ? { detail: event.detail } : {}),
      });
    } else {
      emit(event); // delta | done
    }
  }
  /**
   * Log the query locally for the content-gap report (PRD 5.11.1).
   *
   * `outcome` exists because `answered` alone was misreporting the product. A
   * turn that asked the user to disambiguate logged `answered: false`, so
   * `gap.ts:isGap` filed it as *missing content* — the gap report was
   * recommending pages that already existed, for questions the docs covered.
   * Answering first fixes the miscount; recording the outcome makes it legible.
   *
   * `pickedUrl` is the more valuable half: a chip click is the user labelling
   * which document answered their question, which is a relevance judgement no
   * amount of tuning can synthesise. See retrieval/prior.ts.
   */
  await queryLogStore.log(db, {
    indexId,
    query,
    topScore,
    answered,
    outcome: answered ? (refined ? "refined" : "answered") : "refused",
    ...(focusUrl ? { pickedUrl: focusUrl } : {}),
    ...(pickedFor ? { pickedFor } : {}),
    at: Date.now(),
  });

  // A new label changes the priors, and dropping them is cheap — they are held
  // apart from the session cache precisely so this can happen on every pick
  // without rebuilding the vector matrix.
  if (focusUrl) {
    invalidatePriors(indexId);
    // Cached results were ranked without this label, so they are now stale.
    resultCache.clear(indexId);
  }
}
