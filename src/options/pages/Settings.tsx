import { useEffect, useState } from "react";
import type { ByokProvider } from "@/domain/generator.js";
import { loadSettings, saveSettings } from "@/settings/settings.js";
import { storageEstimate, requestPersistent, type StorageEstimate } from "@/storage/quota.js";
import { deleteEverything } from "@/storage/wipe.js";
import { PROVIDERS, PROVIDER_MODELS, formatBytes } from "../models.js";

export function Settings(): JSX.Element {
  const [mode, setMode] = useState<"auto" | "byok">("auto");
  const [provider, setProvider] = useState<ByokProvider>("openai");
  const [model, setModel] = useState<string>(PROVIDER_MODELS.openai[0]!);
  const [apiKey, setApiKey] = useState("");
  const [floor, setFloor] = useState(0.45);
  const [estimate, setEstimate] = useState<StorageEstimate | null>(null);
  const [persisted, setPersisted] = useState(false);
  const [wipeError, setWipeError] = useState("");

  useEffect(() => {
    void loadSettings().then((s) => {
      setMode(s.answer.mode);
      if (s.answer.provider) setProvider(s.answer.provider);
      if (s.answer.model) setModel(s.answer.model);
      if (s.answer.apiKey) setApiKey(s.answer.apiKey);
      setFloor(s.floor);
    });
    void storageEstimate().then(setEstimate);
    void navigator.storage?.persisted?.().then(setPersisted);
  }, []);

  const persist = (patch: Record<string, unknown>): void => void saveSettings(patch);

  const saveAnswer = (next: Partial<{ mode: "auto" | "byok"; provider: ByokProvider; model: string; apiKey: string }>): void => {
    const merged = { mode, provider, model, apiKey, ...next };
    persist({ answer: merged });
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
            <input type="radio" hidden checked={mode === "auto"} onChange={() => { setMode("auto"); saveAnswer({ mode: "auto" }); }} />
            <span className="grow">
              <span className="row gap-2"><strong style={{ fontSize: 14 }}>Chrome built-in (Gemini Nano)</strong><span className="badge badge-green">On-device · free</span></span>
              <span className="help" style={{ display: "block", marginTop: 4 }}>Default. No key, nothing leaves your device.</span>
            </span>
          </label>

          <label className={mode === "byok" ? "radio-card selected" : "radio-card"}>
            <span className="radio-dot" />
            <input type="radio" hidden checked={mode === "byok"} onChange={() => { setMode("byok"); saveAnswer({ mode: "byok" }); }} />
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
                <select className="select" aria-label="Model" style={{ maxWidth: 220 }} value={model}
                  onChange={(e) => { setModel(e.target.value); saveAnswer({ model: e.target.value }); }}>
                  {PROVIDER_MODELS[provider].map((m) => <option key={m}>{m}</option>)}
                </select>
              </span>
              <span className="input-group mt-3">
                <span className="input-affix pre" aria-hidden>key</span>
                <input className="input mono" type="password" placeholder="Paste your API key" aria-label="API key" value={apiKey}
                  style={{ borderRadius: 0 }} onChange={(e) => setApiKey(e.target.value)} onBlur={() => saveAnswer({ apiKey })} />
              </span>
              <span className="help" style={{ display: "block", marginTop: 8 }}>Stored only on this device; sent only to {provider} to answer.</span>
            </span>
          </label>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2>Answer confidence</h2></div>
        <div className="card-body">
          <div className="field">
            <div className="label-row"><label htmlFor="floor">Score floor for refusal</label><span className="meta mono">{floor.toFixed(2)}</span></div>
            <input className="input num" id="floor" type="number" step="0.05" min="0" max="1" value={floor} style={{ maxWidth: 120 }}
              onChange={(e) => { const v = Number(e.target.value); setFloor(v); persist({ floor: v }); }} />
            <span className="help">Below this hybrid retrieval score, Sherpa refuses and shows nearest pages instead of guessing.</span>
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
