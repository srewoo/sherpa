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
import { ExtractiveGenerator } from "@/generator/extractive.js";
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
import { classifyIntent } from "@/retrieval/intent.js";
import { answerCacheStore, answerKey, settingsFingerprint } from "@/storage/answerCache.js";
import { recordSpend } from "@/generator/spendStore.js";
import type { WireSource } from "@/shared/answer.js";

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

/**
 * One question, as a named bag rather than nine positional arguments.
 *
 * It reached nine — `db, indexId, query, emit, currentUrl, recentQuestions,
 * focusUrl, pickedFor, provided` — and the message handler that builds the call
 * was already a line long enough to hide a transposition. Two of these are
 * `string | undefined` and adjacent (`focusUrl`, `pickedFor`), which is the
 * shape where a silent swap costs a day: retrieval would scope to a question
 * and learn a prior for a URL, and every individual piece would still typecheck.
 */
export interface QueryJob {
  readonly db: SherpaDatabase;
  readonly indexId: string;
  readonly query: string;
  readonly emit: (event: PanelEvent) => void;
  /** The page the user is reading, for the section boost (PRD 5.7). */
  readonly currentUrl?: string;
  /**
   * Earlier questions in this conversation, most recent first. Retrieval uses
   * them to resolve a follow-up against the turn it depends on.
   */
  readonly recentQuestions?: readonly string[];
  /** Set when the question came from a refinement chip naming an exact page. */
  readonly focusUrl?: string;
  /** The question that pick answered, for the learned prior (prior.ts). */
  readonly pickedFor?: string;
  /**
   * Settings as the panel read them.
   *
   * Preferred over reading them here. This document is the only context that
   * read settings for itself, and when its read disagreed with the panel's the
   * failure was invisible: defaults look identical to a user who chose the
   * defaults, so BYOK silently became "answered on-device" with no error and no
   * notice. Falls back to a local read for callers that send nothing.
   */
  readonly settings?: Settings;
  /**
   * The user pressed stop, or the panel went away.
   *
   * Threaded all the way down to the provider fetch, so a cancelled turn stops
   * costing the user money and tokens immediately rather than streaming into a
   * listener nobody is holding any more.
   */
  readonly signal?: AbortSignal;
}

/**
 * The parts of a finished turn worth storing, accumulated as it streams.
 *
 * A named type rather than an inline one because it is read back in three
 * places and reassigned on a mid-turn tier change; inline, the reassignment
 * could not be typed without repeating the whole shape.
 */
interface Cacheable {
  /** Reassigned when the answering tier changes mid-turn (a `restart`). */
  tier: "extractive" | "nano" | "byok";
  sources: readonly WireSource[];
  certainty: "confident" | "uncertain";
  notice?: string;
  /** Deltas append to it as they arrive. */
  text: string;
}

export async function runQuery(job: QueryJob): Promise<void> {
  const {
    db,
    indexId,
    query,
    emit,
    currentUrl,
    recentQuestions = [],
    focusUrl,
    pickedFor,
    settings: provided,
    signal,
  } = job;
  /**
   * The cheap exit, taken before anything is loaded.
   *
   * Deliberately the first statement in the function: everything below it —
   * the embedder, the index session, the priors, the reranker, a BYOK round
   * trip for query rewriting — is work that a greeting has no use for. The gate
   * is a conservative whitelist and never fires on anything punctuated as a
   * question; see `retrieval/intent.ts` for why it is not a classifier.
   *
   * Not logged to the query log either. The gap report exists to find questions
   * the documentation failed to answer, and "hi" is not one of them — counting
   * it would dilute the clusters the report is built to surface.
   */
  const intent = classifyIntent(query);
  if (intent.intent === "small-talk" && intent.reply) {
    emit({ kind: "chat", text: intent.reply });
    emit({ kind: "done" });
    return;
  }

  const settings = provided ?? (await loadSettings());
  /**
   * The signal reaches the generator, not just the loop below.
   *
   * Stopping the `for await` would abandon the *iterator* while leaving the
   * provider request open: the tokens keep arriving, the user keeps paying for
   * them, and the socket stays up until the offscreen document is torn down.
   * Cancelling has to reach the fetch to mean anything.
   */
  const { generator, notice } = await selectGenerator(settings.answer, {
    ...(signal ? { signal } : {}),
    /**
     * Every paid call is counted, including the ones the user never sees.
     *
     * Query rewriting and HyDE each add a provider call per question and are
     * switched on in Settings with no hint that they cost anything; attributing
     * them here is what closes the gap between "three answers today" and a bill
     * for nine calls. Fire-and-forget — a counter that can fail an answer would
     * be a worse bug than the one it reports on.
     */
    onUsage: (usage) => {
      void recordSpend(settings.answer.model ?? "unknown", usage);
    },
  });

  /**
   * Index metadata is read before the embedder, not after.
   *
   * It used to be loaded alongside the priors, well past the point where the
   * 33 MB of ONNX weights had already been pulled in. The answer cache needs
   * `lastIndexedAt` and the effective floors to build its key, and a cache hit
   * that has loaded the embedder first has saved a model call and nothing else
   * — on the extractive tier, where there is no model call, it would have saved
   * nothing at all. One keyed IDB read is a fair price for skipping everything.
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

  const meta = await indexRepo.get(db, indexId);
  const floors = floorsForIndex(meta?.floors, settings.floors, settings.floorsOverride);

  /**
   * The persistent answer cache: a repeat question costs nothing.
   *
   * Checked here — before the embedder, before retrieval, before any model —
   * because that is the whole point. `retrieval/cache.ts` still covers the
   * within-session case where the search is reused but the text is regenerated;
   * this covers the case the user notices, which is being charged twice.
   *
   * Keyed on `lastIndexedAt`, so a re-crawl can never serve an answer citing a
   * page that has since changed. See `storage/answerCache.ts`.
   */
  const cacheKeyParts = meta
    ? {
        indexId,
        indexedAt: meta.lastIndexedAt,
        query: asked,
        tier: generator.tier,
        model: settings.answer.model ?? "",
        ...(focusUrl ? { focusUrl } : {}),
        settingsFingerprint: settingsFingerprint({
          refuseFloor: floors.refuse,
          confidentFloor: floors.confident,
          rerank: rerankForIndex(meta.rerank, settings.rerank),
          hyde: settings.hyde,
          rewriteQueries: settings.rewriteQueries,
        }),
      }
    : undefined;
  const cacheId = cacheKeyParts ? answerKey(cacheKeyParts) : undefined;

  if (settings.cacheAnswers && cacheId) {
    const hit = await answerCacheStore.get(db, cacheId);
    if (hit) {
      emit({
        kind: "sources",
        tier: hit.tier,
        sources: hit.sources as readonly WireSource[],
        certainty: hit.certainty,
        ...(hit.notice ? { notice: hit.notice } : {}),
      });
      // One delta carrying the whole answer. Streaming a cached string token by
      // token would be theatre — pretending to think about something already
      // decided — and the panel renders a single delta identically.
      emit({ kind: "delta", delta: hit.markdown });
      emit({ kind: "done" });
      /**
       * Still logged, and logged as answered.
       *
       * The gap report counts questions the docs failed to answer. A cache hit
       * answered one, and dropping it would quietly under-count the index's
       * successes and skew every cluster the report ranks.
       */
      await queryLogStore.log(db, {
        indexId,
        query,
        topScore: hit.topScore,
        answered: true,
        outcome: "answered",
        ...(focusUrl ? { pickedUrl: focusUrl } : {}),
        ...(pickedFor ? { pickedFor } : {}),
        at: Date.now(),
      });
      return;
    }
  }

  const embedder = await getEmbedder();

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

  // Cheap and cached; a failed read yields no priors rather than no search.
  // `meta` was already read above, for the cache key.
  const priors = await loadPriors(db, indexId);

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
    floors,
    /**
     * The tier that cannot decline, held in reserve.
     *
     * Constructed unconditionally and used only if the chosen model refuses —
     * it is a pure function over the articles already in hand, with no model,
     * no network and nothing to load, so building it costs nothing on the
     * ordinary path. `answerQuery` skips it when it *is* the answering tier.
     */
    fallback: new ExtractiveGenerator(),
  };

  let answered = false;
  let topScore = 0;
  let refined = false;
  /**
   * What the cache will store, accumulated as it streams.
   *
   * Captured from the events rather than recomputed afterwards, so what gets
   * cached is exactly what the user saw — including a tier that changed
   * mid-turn and the source cards that were on screen beside it. Recomputing
   * would be a second chance to disagree with the screen.
   */
  let cacheable: Cacheable | null = null;
  for await (const event of answerQuery(deps, asked)) {
    if (event.kind === "delta" && cacheable) {
      cacheable.text += event.delta;
    } else if (event.kind === "restart") {
      // The tier changed and the text so far was discarded — the cached copy
      // has to be discarded with it, or the extract would be stored underneath
      // the refusal sentence it replaced.
      if (cacheable) {
        cacheable.tier = event.tier;
        cacheable.notice = event.notice;
        cacheable.text = "";
      }
    } else if (event.kind === "refusal") {
      // Never cached. A refusal is a judgement about this moment — a provider
      // outage, a model that wouldn't commit — and freezing it for a week would
      // keep answering "no" long after the reason had passed.
      cacheable = null;
    }
    if (event.kind === "sources") {
      answered = true;
      topScore = event.topScore;
      const wire = event.sources.map(articleToSource);
      cacheable = {
        tier: event.tier,
        sources: wire,
        certainty: event.certainty,
        ...(notice ? { notice } : {}),
        text: "",
      };
      emit({
        kind: "sources",
        tier: event.tier,
        sources: wire,
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
        // Carried through so the panel can say what actually happened and
        // offer the per-page pick, rather than guessing and dead-ending.
        ...(event.confident ? { confident: event.confident } : {}),
        ...(event.refine ? { refine: event.refine } : {}),
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
  /**
   * Cache the finished answer, if there is one worth keeping.
   *
   * After the log rather than before, and awaited nowhere the user is waiting:
   * the answer is already on screen and `done` has already been emitted, so a
   * slow or failing write costs nothing. Empty text is skipped — an answer with
   * no body is not an answer, and caching one would serve a blank turn for a
   * week.
   */
  if (settings.cacheAnswers && cacheId && cacheable && cacheable.text.trim() !== "") {
    await answerCacheStore.put(db, {
      key: cacheId,
      indexId,
      query: asked,
      tier: cacheable.tier,
      markdown: cacheable.text,
      sources: cacheable.sources,
      certainty: cacheable.certainty,
      topScore,
      ...(cacheable.notice ? { notice: cacheable.notice } : {}),
      at: Date.now(),
      hits: 0,
    });
  }

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
