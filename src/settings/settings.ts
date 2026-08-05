/**
 * Persisted user settings (PRD 5.8, 5.10.5). The BYOK key lives only in
 * chrome.storage.local and is never sent anywhere but the chosen provider.
 */

import type { AnswerSettings } from "@/generator/select.js";
import { DEFAULT_EMBEDDING_MODEL_ID } from "@/embed/models.js";
import { DEFAULT_AUTO_REFRESH_DAYS } from "@/crawl/autoRefresh.js";
import { DEFAULT_FLOORS, type ConfidenceFloors } from "@/retrieval/confidence.js";

export interface Settings {
  readonly answer: AnswerSettings;
  /** Which bundled embedding model to index and query with (PRD 5.5.1). */
  readonly embeddingModel: string;
  /**
   * Cosine bands: refuse below `refuse`, hedge between, answer plainly above
   * `confident`. Replaces the single floor — see retrieval/confidence.ts for
   * why one number could not carry this decision.
   */
  readonly floors: ConfidenceFloors;
  /**
   * Use the `floors` above even for an index that measured its own.
   *
   * Off by default, because a calibrated index almost always knows better: the
   * right threshold depends on the corpus, and a single global number was
   * measured to be catastrophically wrong on real sites. This exists so hand
   * tuning is still possible and still obeyed — silently ignoring a slider the
   * user just moved would be worse than either default.
   */
  readonly floorsOverride: boolean;
  readonly activeIndexId: string | undefined;
  /**
   * Days between automatic incremental refreshes, applied to every index.
   * `null` disables auto-refresh; the Refresh button still works (PRD 5.6.5).
   */
  readonly autoRefreshDays: number | null;
  /**
   * Embed a model-written hypothetical answer instead of the raw question
   * (HyDE). Off by default: it costs an extra model call per query, and its
   * benefit is unmeasured on real content until the eval has a labelled set to
   * run. Shipping an unmeasured latency cost as a default would be a guess.
   */
  readonly hyde: boolean;
  /**
   * Rescore the top results with the bundled cross-encoder. Off by default, and
   * a no-op unless `npm run fetch:reranker` vendored the weights — it adds
   * ~23 MB to the package and a forward pass per candidate.
   */
  readonly rerank: boolean;
  /**
   * Let the on-device model rewrite the query before searching. Off by default:
   * it adds a model call per question, and every rewrite is checked and
   * discarded on failure, so the upside is real but unmeasured until the eval
   * has a labelled set.
   */
  readonly rewriteQueries: boolean;
}

/**
 * Refusal floor (PRD 5.8.8) as a cosine similarity.
 *
 * ⚠️ **This value is known to be mis-calibrated and is kept only until the real
 * eval settles it.** It was swept against `src/eval/fixtures` — a hashed
 * bag-of-words embedder — and a cosine distribution is a property of the
 * *model*, not of the retrieval code. The fixture's distribution has nothing to
 * do with the model users actually run.
 *
 * Measured against the real bge-small weights (`npm run eval`):
 *
 *   cosine(query, a passage that answers it)      ≈ 0.89
 *   cosine(query, an unrelated passage)           ≈ 0.35
 *   cosine(query, a *plausible* question the
 *          docs happen not to cover)              ≈ 0.55–0.70
 *
 * That third row is the problem. bge scores everything in the product's own
 * subject area highly, so at 0.40 the floor accepts every plausible question
 * including the ones the index cannot answer — on the fixture question set its
 * false-answer rate is 100%, and the sweep puts the knee near 0.65. In practice
 * the model's own refusal has been carrying that load alone, which is why users
 * see "I found related pages but couldn't answer from them" rather than a clean
 * below-floor refusal.
 *
 * The default is deliberately *not* changed here yet: the measurement above
 * comes from twelve chunks and ten adversarial questions, which settles the
 * direction but not the number. Export a real corpus, run `npm run eval`, and
 * take the floor its sweep recommends.
 */
export const DEFAULT_REFUSAL_FLOOR = 0.4;

const DEFAULTS: Settings = {
  answer: { mode: "auto" },
  embeddingModel: DEFAULT_EMBEDDING_MODEL_ID,
  floors: DEFAULT_FLOORS,
  floorsOverride: false,
  activeIndexId: undefined,
  autoRefreshDays: DEFAULT_AUTO_REFRESH_DAYS,
  hyde: false,
  rerank: false,
  rewriteQueries: false,
};

function readFloors(stored: Record<string, unknown>): ConfidenceFloors {
  const saved = stored["floors"] as Partial<ConfidenceFloors> | undefined;
  if (saved && typeof saved.refuse === "number" && typeof saved.confident === "number") {
    return { refuse: saved.refuse, confident: saved.confident };
  }
  const legacy = stored["floor"];
  if (typeof legacy === "number") {
    return { refuse: legacy, confident: Math.max(legacy, DEFAULT_FLOORS.confident) };
  }
  return DEFAULT_FLOORS;
}

const hasStorage = (): boolean => typeof chrome !== "undefined" && Boolean(chrome.storage?.local);

export async function loadSettings(): Promise<Settings> {
  if (!hasStorage()) return DEFAULTS;
  const s = await chrome.storage.local.get([
    "answer",
    "floor",
    "activeIndexId",
    "embeddingModel",
    "autoRefreshDays",
    "hyde",
    "rerank",
    "floors",
    "floorsOverride",
    "rewriteQueries",
  ]);
  return {
    answer: (s["answer"] as AnswerSettings) ?? DEFAULTS.answer,
    // Migrates the old single `floor`: it becomes the refuse band, and the
    // confident band sits above it, so an existing install keeps its behaviour
    // for refusals and gains the hedge.
    floors: readFloors(s),
    /**
     * A pre-calibration install has no stored value, and must not be treated as
     * having opted out — that would pin every index to the old global constant
     * and undo the fix.
     */
    floorsOverride: s["floorsOverride"] === true,
    activeIndexId: (s["activeIndexId"] as string | undefined) ?? undefined,
    embeddingModel: (s["embeddingModel"] as string | undefined) ?? DEFAULTS.embeddingModel,
    // `null` means the user switched auto-refresh off, which is not the same as
    // never having chosen — so only a *missing* key falls back to the default.
    autoRefreshDays:
      s["autoRefreshDays"] === undefined
        ? DEFAULTS.autoRefreshDays
        : (s["autoRefreshDays"] as number | null),
    hyde: s["hyde"] === true,
    rerank: s["rerank"] === true,
    rewriteQueries: s["rewriteQueries"] === true,
  };
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  if (!hasStorage()) return;
  await chrome.storage.local.set(patch);
}
