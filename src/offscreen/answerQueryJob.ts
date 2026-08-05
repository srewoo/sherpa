/**
 * Offscreen query handler. Retrieval needs the embedder + IndexedDB (both live
 * here), and Nano/BYOK generation runs here too, so the whole query→answer path
 * executes in the offscreen doc and streams UI events back to the side panel.
 */

import type { SherpaDatabase } from "@/storage/db.js";
import type { PanelEvent } from "@/shared/answer.js";
import { articleToSource } from "@/shared/answer.js";
import { getEmbedder } from "@/embed/embedder.js";
import { retrieve } from "@/retrieval/retrieve.js";
import { answerQuery } from "@/generator/answerService.js";
import { selectGenerator } from "@/generator/select.js";
import { hydePrompt } from "@/retrieval/hyde.js";
import { resolveFollowUp } from "@/retrieval/followUp.js";
import { rewriteQuery } from "@/retrieval/rewrite.js";
import { createReranker, type Reranker } from "@/retrieval/rerank.js";
import { loadSettings } from "@/settings/settings.js";
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
): Promise<void> {
  const settings = await loadSettings();
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

  /**
   * HyDE writes a hypothetical answer to embed in place of the question. Only
   * wired up when the user opted in *and* a model can run it — it costs a call
   * on the critical path, and `hydeQuery` already falls back to the plain
   * question if it fails.
   */
  const hypothesize =
    settings.hyde && complete ? (q: string) => complete(hydePrompt(q)) : undefined;

  const meta = await indexRepo.get(db, indexId);

  /**
   * Loaded once per offscreen document, and only if this index asked for it.
   * A missing model is the normal case — the weights are an opt-in fetch — so
   * failure here is "reranking is off", not an error.
   */
  const rerank = rerankForIndex(meta?.rerank, settings.rerank)
    ? await getReranker()
    : undefined;

  /**
   * Query understanding, cheapest first.
   *
   * 1. Resolve a follow-up against the previous turn. Pure text, no model, and
   *    it fixes the class of question users ask second.
   * 2. Optionally let the model rewrite it — checked, never trusted, and it
   *    falls back to the text from step 1 on any failure.
   */
  const resolved = resolveFollowUp(query, recentQuestions);
  const searchText =
    settings.rewriteQueries && complete
      ? await rewriteQuery(resolved, recentQuestions, complete)
      : resolved;

  const deps = {
    // Retrieval searches the resolved text; the user's own words are what the
    // model answers and what the UI shows.
    retrieve: (_q: string) =>
      retrieve(
        {
          db,
          indexId,
          embedder,
          ...(currentUrl ? { currentUrl } : {}),
          ...(hypothesize ? { hypothesize } : {}),
          ...(rerank ? { rerank } : {}),
        },
        searchText,
      ),
    generator,
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
  for await (const event of answerQuery(deps, query)) {
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
    } else if (event.kind === "disambiguation") {
      emit({ kind: "disambiguation", options: event.options });
    } else if (event.kind === "refusal") {
      topScore = event.topScore;
      emit({
        kind: "refusal",
        nearest: event.nearest.map(articleToSource),
        reason: event.reason,
      });
    } else {
      emit(event); // delta | done
    }
  }
  // Log the query locally for the content-gap report (PRD 5.11.1).
  await queryLogStore.log(db, { indexId, query, topScore, answered, at: Date.now() });
}
