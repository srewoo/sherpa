import { useEffect, useState } from "react";
import type { ByokProvider } from "@/domain/generator.js";
import { loadSettings, saveSettings } from "@/settings/settings.js";
import { DEFAULT_FLOORS } from "@/retrieval/confidence.js";
import { storageEstimate, requestPersistent, type StorageEstimate } from "@/storage/quota.js";
import { deleteEverything } from "@/storage/wipe.js";
import { PROVIDERS, PROVIDER_MODELS, formatBytes } from "../models.js";
import { EMBEDDING_MODELS } from "@/embed/models.js";
import { AUTO_REFRESH_CHOICES } from "@/crawl/autoRefresh.js";
import { byokIssue } from "@/generator/select.js";
import { fetchModels } from "@/generator/modelList.js";
import { DEFAULT_EMBEDDING_MODEL_ID } from "@/embed/embedder.js";

export function Settings(): JSX.Element {
  const [mode, setMode] = useState<"auto" | "byok">("auto");
  const [provider, setProvider] = useState<ByokProvider>("openai");
  const [model, setModel] = useState<string>(PROVIDER_MODELS.openai[0]!);
  const [apiKey, setApiKey] = useState("");
  const [floors, setFloors] = useState(DEFAULT_FLOORS);
  const [floorsOverride, setFloorsOverride] = useState(false);
  const [estimate, setEstimate] = useState<StorageEstimate | null>(null);
  const [persisted, setPersisted] = useState(false);
  const [wipeError, setWipeError] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState<string>(DEFAULT_EMBEDDING_MODEL_ID);
  const [autoRefreshDays, setAutoRefreshDays] = useState<number | null>(null);
  const [hyde, setHyde] = useState(false);
  const [rerank, setRerank] = useState(false);
  const [rewriteQueries, setRewriteQueries] = useState(false);
  /** Models this key can actually use; empty until a key lists successfully. */
  const [fetchedModels, setFetchedModels] = useState<readonly string[]>([]);
  const [modelListError, setModelListError] = useState("");

  useEffect(() => {
    void loadSettings().then((s) => {
      setMode(s.answer.mode);
      if (s.answer.provider) setProvider(s.answer.provider);
      if (s.answer.model) setModel(s.answer.model);
      if (s.answer.apiKey) setApiKey(s.answer.apiKey);
      setFloors(s.floors);
      setFloorsOverride(s.floorsOverride);
      setEmbeddingModel(s.embeddingModel);
      setAutoRefreshDays(s.autoRefreshDays);
      setHyde(s.hyde);
      setRerank(s.rerank);
      setRewriteQueries(s.rewriteQueries);
    });
    void storageEstimate().then(setEstimate);
    void navigator.storage?.persisted?.().then(setPersisted);
  }, []);

  /**
   * Ask the provider what this key can use, whenever the key or provider
   * settles.
   *
   * Debounced because this runs on every keystroke of a pasted API key, and a
   * partial key is a guaranteed 401 — firing per character would rate-limit the
   * user against their own provider before they finished pasting.
   */
  useEffect(() => {
    if (mode !== "byok" || apiKey.trim() === "") {
      setFetchedModels([]);
      setModelListError("");
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void fetchModels(provider, apiKey).then((res) => {
        if (cancelled) return;
        setFetchedModels(res.models);
        setModelListError(res.error ?? "");
      });
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mode, provider, apiKey]);

  const persist = (patch: Record<string, unknown>): void => void saveSettings(patch);

  /**
   * Save the answering config, then show what was actually stored.
   *
   * The read-back is the point. This page showed "Bring your own key" selected
   * while answers came back labelled Gemini Nano — the panel reads
   * `chrome.storage`, this page read React state, and nothing ever compared
   * them. Whatever caused the divergence, a UI that reports its own intentions
   * rather than the stored truth cannot show the user they disagree.
   *
   * `saveSettings` writes a partial patch, so re-reading is cheap and is the
   * only way to know the write landed.
   */
  const saveAnswer = (
    next: Partial<{ mode: "auto" | "byok"; provider: ByokProvider; model: string; apiKey: string }>,
  ): void => {
    const merged = { mode, provider, model, apiKey, ...next };
    void saveSettings({ answer: merged })
      .then(() => loadSettings())
      .then((stored) => {
        setMode(stored.answer.mode);
        if (stored.answer.provider) setProvider(stored.answer.provider);
        if (stored.answer.model) setModel(stored.answer.model);
      });
  };

  const onDeleteAll = async (): Promise<void> => {
    if (!confirm("Delete every index, the stored API key, and all settings? This cannot be undone."))
      return;
    const result = await deleteEverything();
    if (!result.deleted) {
      // Never claim a wipe that didn't happen (PRD 5.10.6).
      setWipeError(result.blockedBy ?? "Could not delete the local index.");
      return;
    }
    location.reload();
  };

  const usedPct = estimate && estimate.quota > 0 ? Math.round((estimate.usage / estimate.quota) * 100) : 0;

  return (
    <div className="page">
      <h1>Settings</h1>

      <section className="card">
        <div className="card-head"><h2>Answering model</h2></div>
        <div className="card-body stack-4">
          <label className={mode === "auto" ? "radio-card selected" : "radio-card"}>
            <span className="radio-dot" />
            <input type="radio" name="answer-mode" hidden checked={mode === "auto"} onChange={() => { setMode("auto"); saveAnswer({ mode: "auto" }); }} />
            <span className="grow">
              <span className="row gap-2"><strong style={{ fontSize: 14 }}>Chrome built-in (Gemini Nano)</strong><span className="badge badge-green">On-device · free</span></span>
              <span className="help" style={{ display: "block", marginTop: 4 }}>Default. No key, nothing leaves your device.</span>
            </span>
          </label>

          <label className={mode === "byok" ? "radio-card selected" : "radio-card"}>
            <span className="radio-dot" />
            <input type="radio" name="answer-mode" hidden checked={mode === "byok"} onChange={() => { setMode("byok"); saveAnswer({ mode: "byok" }); }} />
            <span className="grow">
              <span className="row-between">
                <span className="row gap-2"><strong style={{ fontSize: 14 }}>Bring your own key</strong><span className="badge badge-amber">Queries leave device</span></span>
                <span className="badge badge-neutral">{provider} · {model}</span>
              </span>
              <span className="row gap-3 mt-3" style={{ flexWrap: "wrap", alignItems: "center" }}>
                <span className="segmented" role="tablist" aria-label="Provider">
                  {PROVIDERS.map((p) => (
                    <button key={p} role="tab" type="button" aria-pressed={provider === p}
                      onClick={() => { const m = PROVIDER_MODELS[p][0]!; setProvider(p); setModel(m); saveAnswer({ provider: p, model: m }); }}>
                      {p === "openai" ? "OpenAI" : p === "anthropic" ? "Anthropic" : "Gemini"}
                    </button>
                  ))}
                </span>
                {/*
                  A datalist rather than a select. The fetched list is the right
                  answer almost always, but "almost" is doing work: a brand-new
                  model, a fine-tune, or a provider whose listing endpoint moved
                  would leave the user unable to type the one model they are
                  paying for. This offers the list and still accepts anything.
                */}
                <input
                  className="input mono"
                  list="byok-models"
                  aria-label="Model"
                  style={{ maxWidth: 220 }}
                  value={model}
                  onChange={(e) => { setModel(e.target.value); saveAnswer({ model: e.target.value }); }}
                />
                <datalist id="byok-models">
                  {(fetchedModels.length > 0 ? fetchedModels : PROVIDER_MODELS[provider]).map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </span>
              <span className="input-group mt-3">
                <span className="input-affix pre" aria-hidden>key</span>
                {/*
                  Saved on change, not on blur. Typing a key and pressing Enter,
                  switching apps, or closing the tab never fired blur — so the
                  key was silently never stored, BYOK stayed unusable, and
                  answers came from Nano while this page showed OpenAI selected.
                */}
                <input className="input mono" type="password" placeholder="Paste your API key" aria-label="API key" value={apiKey}
                  style={{ borderRadius: 0 }}
                  onChange={(e) => { setApiKey(e.target.value); saveAnswer({ apiKey: e.target.value }); }} />
              </span>
              {mode === "byok" && byokIssue({ mode, provider, model, apiKey }) ? (
                <span className="notice notice-amber" style={{ display: "block", marginTop: 8 }}>
                  {byokIssue({ mode, provider, model, apiKey })} Answers will come from the
                  on-device model until this is fixed.
                </span>
              ) : (
                <span className="help" style={{ display: "block", marginTop: 8 }}>
                  Stored only on this device; sent only to {provider} to answer.
                  {fetchedModels.length > 0
                    ? ` ${fetchedModels.length} models available to this key.`
                    : modelListError
                      ? ` ${modelListError} Showing the built-in list.`
                      : ""}
                </span>
              )}
            </span>
          </label>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2>Search model</h2></div>
        <div className="card-body stack-4">
          <p className="help">
            The model that turns pages and questions into vectors. Both run entirely on this device
            and are already bundled — switching downloads nothing.
          </p>
          {EMBEDDING_MODELS.map((m) => (
            <label key={m.id} className={embeddingModel === m.id ? "radio-card selected" : "radio-card"}>
              <span className="radio-dot" />
              <input
                type="radio"
                hidden
                name="embedding-model"
                checked={embeddingModel === m.id}
                onChange={() => {
                  setEmbeddingModel(m.id);
                  persist({ embeddingModel: m.id });
                }}
              />
              <span className="grow">
                <span className="row-between">
                  <strong style={{ fontSize: 14 }}>{m.label}</strong>
                  <span className="badge badge-neutral">{m.dim}-d · {m.sizeMB} MB</span>
                </span>
                <span className="help" style={{ display: "block", marginTop: 4 }}>{m.description}</span>
              </span>
            </label>
          ))}
          <div className="notice notice-amber">
            <span>
              Vectors from different models can't be compared, so changing this means every index
              has to be rebuilt. Sherpa flags the ones that need it and offers a re-crawl — nothing
              is deleted until you start one.
            </span>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2>Answer confidence</h2></div>
        <div className="card-body stack-4">
          <p className="help">
            Sherpa compares your question to each page and scores the match from 0 to 1. These two
            numbers decide what it does with that score.
          </p>
          {/*
            The important thing on this card, so it comes before the sliders it
            governs. Every index measures its own thresholds when it finishes
            crawling, because the right value depends on the documentation, not
            on Sherpa — one site's confident match is another's near miss.
          */}
          <label className="row gap-3" style={{ alignItems: "flex-start", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={floorsOverride}
              onChange={(e) => {
                setFloorsOverride(e.target.checked);
                persist({ floorsOverride: e.target.checked });
              }}
            />
            <span className="grow">
              <strong style={{ fontSize: 13.5 }}>Use these numbers for every index</strong>
              <span className="help" style={{ display: "block", marginTop: 2 }}>
                Off by default. Each index measures its own thresholds against its own pages when
                the crawl finishes, which fits it far better than one setting can — what counts as
                a strong match on one documentation site is a near miss on another. Tick this to
                override every index with the values below.
              </span>
            </span>
          </label>
          <div className="field">
            <div className="label-row">
              <label htmlFor="floor-refuse">Refuse below</label>
              <span className="meta mono">{floors.refuse.toFixed(2)}</span>
            </div>
            <input
              className="input num" id="floor-refuse" type="number" step="0.05" min="0" max="1"
              value={floors.refuse} style={{ maxWidth: 120 }}
              onChange={(e) => {
                const next = { ...floors, refuse: Number(e.target.value) };
                setFloors(next);
                persist({ floors: next });
              }}
            />
            <span className="help">
              Below this, Sherpa won't answer — it shows the nearest pages instead. Raise it if it
              answers questions your docs don't cover; lower it if it declines ones they do.
            </span>
          </div>
          <div className="field">
            <div className="label-row">
              <label htmlFor="floor-confident">Answer plainly above</label>
              <span className="meta mono">{floors.confident.toFixed(2)}</span>
            </div>
            <input
              className="input num" id="floor-confident" type="number" step="0.05" min="0" max="1"
              value={floors.confident} style={{ maxWidth: 120 }}
              onChange={(e) => {
                const next = { ...floors, confident: Number(e.target.value) };
                setFloors(next);
                persist({ floors: next });
              }}
            />
            <span className="help">
              Between the two, Sherpa still answers but says the match wasn't strong — because in
              that band the score genuinely can't tell a good match from a near miss, and saying so
              is more useful than guessing either way. Defaults {DEFAULT_FLOORS.refuse.toFixed(2)}{" "}
              and {DEFAULT_FLOORS.confident.toFixed(2)}.
            </span>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2>Search quality</h2></div>
        <div className="card-body stack-3">
          <label className="row gap-3" style={{ alignItems: "flex-start", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={hyde}
              onChange={(e) => { setHyde(e.target.checked); persist({ hyde: e.target.checked }); }}
            />
            <span className="grow">
              {/*
                This checkbox is `hyde`, and it was labelled "Rewrite questions
                before searching" — which is what the *other* checkbox below
                does. Two settings both claiming to happen "before searching",
                with the first one's name describing the third one's behaviour,
                left no way to tell which was which. The label now matches the
                description underneath it.
              */}
              <strong style={{ fontSize: 14 }}>Search using a sketched answer</strong>
              <span className="help" style={{ display: "block", marginTop: 4 }}>
                A question and the passage that answers it don't look alike — "how do I set up a
                two-way roleplay" shares almost no words with an article titled "Practice with
                avatar". This has the on-device model sketch what an answer would look like and
                searches with that instead, which finds pages your wording wouldn't.
                <br />
                Costs one extra on-device model call per question, so answers start a little later.
                Off by default because its benefit hasn't been measured on real content yet.
              </span>
            </span>
          </label>

          <label className="row gap-3" style={{ alignItems: "flex-start", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={rerank}
              onChange={(e) => { setRerank(e.target.checked); persist({ rerank: e.target.checked }); }}
            />
            <span className="grow">
              <strong style={{ fontSize: 14 }}>Re-read the top results before answering</strong>
              <span className="help" style={{ display: "block", marginTop: 4 }}>
                Ordinary search compares your question and each page separately, so it can only
                tell that they're about similar things. This re-reads the best twenty results with
                the question in hand and asks a sharper question — does this page actually answer
                it — then reorders them.
                <br />
                Needs an extra 23&nbsp;MB model that isn't installed by default; without it this
                setting does nothing. It also adds a moment before each answer.
              </span>
            </span>
          </label>

          <label className="row gap-3" style={{ alignItems: "flex-start", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={rewriteQueries}
              onChange={(e) => { setRewriteQueries(e.target.checked); persist({ rewriteQueries: e.target.checked }); }}
            />
            <span className="grow">
              <strong style={{ fontSize: 14 }}>Rewrite the question before searching</strong>
              <span className="help" style={{ display: "block", marginTop: 4 }}>
                Has the on-device model turn your question into a cleaner search phrase — useful for
                short, conversational, or non-English questions. Every rewrite is checked first: if
                it drops an error code, a quoted label, or an identifier like SAML, or wanders off
                the subject, it's thrown away and your own words are used instead.
                <br />
                Costs one extra on-device model call per question.
              </span>
            </span>
          </label>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2>Automatic refresh</h2></div>
        <div className="card-body stack-3">
          <div className="field">
            <label htmlFor="auto-refresh">Re-check every index</label>
            <select
              className="select"
              id="auto-refresh"
              style={{ maxWidth: 260 }}
              value={autoRefreshDays === null ? "off" : String(autoRefreshDays)}
              onChange={(e) => {
                const days = e.target.value === "off" ? null : Number(e.target.value);
                setAutoRefreshDays(days);
                persist({ autoRefreshDays: days });
              }}
            >
              {AUTO_REFRESH_CHOICES.map((c) => (
                <option key={c.label} value={c.days === null ? "off" : String(c.days)}>
                  {c.label}
                </option>
              ))}
            </select>
            <span className="help">
              Docs drift, and a stale index still answers confidently — so Sherpa re-runs the same
              incremental refresh the Refresh button does, on this cadence. Only pages that actually
              changed are re-embedded.
            </span>
          </div>
          <div className="notice">
            <span>
              Scheduled refreshes wait until your machine has been idle for five minutes, run at
              half speed, and stop the moment you come back — they never interrupt a crawl you
              started. One site is refreshed at a time. Nothing runs while Chrome is closed; an
              index that came due meanwhile is picked up after you next open it.
            </span>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2>Privacy &amp; storage</h2></div>
        <div className="card-body stack-4">
          <div className="row-between">
            <span>Persistent storage {persisted ? <span className="badge badge-green">On</span> : <span className="badge badge-amber">Off</span>}</span>
            {!persisted && <button className="btn btn-sm" type="button" onClick={() => void requestPersistent().then(setPersisted)}>Request</button>}
          </div>
          {estimate && (
            <div className="field">
              <div className="label-row"><label>Storage used</label><span className="meta mono">{formatBytes(estimate.usage)} / {formatBytes(estimate.quota)}</span></div>
              <div className="meter"><span style={{ width: `${usedPct}%` }} /></div>
            </div>
          )}
        </div>
      </section>

      <section className="card" style={{ borderColor: "var(--danger)" }}>
        <div className="card-head"><h2 style={{ color: "var(--danger)" }}>Delete everything</h2></div>
        <div className="card-body stack-3">
          <p className="help">Permanently erases every index, the stored API key, all host permissions data, and settings. This cannot be undone.</p>
          {wipeError && <div className="notice notice-amber"><span>{wipeError}</span></div>}
          <button className="btn btn-danger-solid" type="button" onClick={() => void onDeleteAll()}>Delete everything</button>
        </div>
      </section>
    </div>
  );
}
