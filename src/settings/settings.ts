/**
 * Persisted user settings (PRD 5.8, 5.10.5). The BYOK key lives only in
 * chrome.storage.local and is never sent anywhere but the chosen provider.
 */

import type { AnswerSettings } from "@/generator/select.js";
import { DEFAULT_EMBEDDING_MODEL_ID } from "@/embed/models.js";
import { DEFAULT_AUTO_REFRESH_DAYS } from "@/crawl/autoRefresh.js";
import { DEFAULT_FLOORS, type ConfidenceFloors } from "@/retrieval/confidence.js";
import { log } from "@/lib/log.js";

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
  /**
   * Reuse a stored answer when the same question is asked again.
   *
   * On by default. The cache is keyed on the index's `lastIndexedAt` and on
   * every setting that changes an answer, so a hit can only ever be an answer
   * the current inputs would produce again — which makes "off" a preference
   * about freshness rather than a correctness switch. It exists because that
   * preference is real: someone tuning a model or a prompt wants to see the
   * model run, not a recording of the last time it did.
   */
  readonly cacheAnswers: boolean;
}

/**
 * Refusal floor (PRD 5.8.8) as a cosine similarity.
 *
 * Measured, finally. `npm run eval:sites` embeds three real crawled help
 * centres with the actual bge-small weights and reads the answerable and
 * unanswerable score distributions apart:
 *
 *   site                  answerable median   negatives p95   oracle floor
 *   help.egain.com                    0.864           0.687          0.70
 *   help.gong.io                      0.764           0.716          0.75
 *   help.mindtickle.com               0.778           0.724          0.75
 *
 * The previous value, 0.40, was swept against the fixture embedder — a hashed
 * bag-of-words stand-in — and was below every negative every real corpus
 * produced. Its measured false-answer rate was 92%, 100% and 92%: the floor
 * could not refuse anything, and the model's grounding prompt was doing all of
 * the refusing on its own. That is why users saw "I found related pages but
 * couldn't answer from them" instead of a clean refusal.
 *
 * 0.70 clears the negatives on all three corpora. It is only the fallback for
 * an index with no calibration of its own (`calibrate.ts`), which is the better
 * answer wherever it exists — cosine distributions shift with corpus size and
 * subject matter, so one global number is a compromise between three answers.
 *
 * Two honest caveats the sweep also reports. Gong and Mindtickle show genuine
 * *overlap*: answerable p05 sits below negatives p95, so no threshold separates
 * them perfectly and raising the floor to their 0.75 oracle would refuse ~48%
 * and ~38% of answerable questions. And the "answerable" set is known-item
 * (a page asked by its own title), which is an upper bound on retrieval rather
 * than a model of how people really ask.
 */
export const DEFAULT_REFUSAL_FLOOR = 0.7;

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
  cacheAnswers: true,
};

/**
 * Read the answering config, checking its shape rather than asserting it.
 *
 * This was `s["answer"] as AnswerSettings`, and the cast is what made a whole
 * class of failure invisible. A stored object missing `mode` — a partial write,
 * a record from an older shape, anything — yields `mode: undefined`, which is
 * not `"byok"`, so `byokIssue` reports *no issue*, Nano is selected, and no
 * notice is raised. The panel then states "on-device" beside an Options page
 * showing OpenAI, and neither is lying about what it read.
 *
 * A cast cannot fail. That is precisely why it is the wrong tool for data that
 * crossed a storage boundary.
 */
function readAnswer(stored: Record<string, unknown>): AnswerSettings {
  const raw = stored["answer"];
  if (raw === undefined || raw === null) return DEFAULTS.answer;
  if (typeof raw !== "object") {
    log.warn("settings_answer_not_object", { stored: typeof raw });
    return DEFAULTS.answer;
  }

  const a = raw as Record<string, unknown>;
  const mode = a["mode"];
  if (mode !== "auto" && mode !== "byok") {
    // Recoverable: a key and provider are present, the mode simply isn't. Infer
    // it rather than silently answering on-device with a key sitting right
    // there — and say so, because inferring a privacy-relevant setting is not
    // something to do quietly.
    const inferable =
      typeof a["provider"] === "string" && typeof a["apiKey"] === "string" && a["apiKey"] !== "";
    log.warn("settings_answer_mode_invalid", {
      mode: String(mode),
      resolution: inferable ? "inferred_byok" : "default_auto",
    });
    if (!inferable) return DEFAULTS.answer;
  }

  return {
    // Reached only with a valid mode, or an invalid one we just inferred as
    // byok — so anything that isn't explicitly "auto" is byok here.
    mode: mode === "auto" ? "auto" : "byok",
    ...(typeof a["provider"] === "string"
      ? { provider: a["provider"] as NonNullable<AnswerSettings["provider"]> }
      : {}),
    ...(typeof a["model"] === "string" ? { model: a["model"] } : {}),
    ...(typeof a["apiKey"] === "string" ? { apiKey: a["apiKey"] } : {}),
  };
}

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
  /**
   * Falling back to defaults here is right — outside the extension (tests, the
   * dev-server panel) there is no storage to read. Doing it *silently* is not.
   *
   * Every field this returns is a user decision, and the most consequential one
   * says whether queries leave the device. A context that cannot read storage
   * gets `mode: "auto"` and answers on-device while the Options page shows BYOK
   * selected — a disagreement with no error, no notice, and nothing in either
   * console to distinguish it from the user simply not having saved.
   */
  if (!hasStorage()) {
    log.warn("settings_storage_unavailable", { using: "defaults" });
    return DEFAULTS;
  }
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
    "cacheAnswers",
  ]);
  return {
    answer: readAnswer(s),
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
    /**
     * Defaults to on, so a missing key is not read as an opt-out.
     *
     * `=== true` would turn every existing install's silence into "caching
     * off", which is the same class of bug as `floorsOverride`: absence is not
     * a decision, and treating it as one silently discards a default the
     * product chose deliberately.
     */
    cacheAnswers: s["cacheAnswers"] !== false,
  };
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  if (!hasStorage()) return;
  await chrome.storage.local.set(patch);
}
