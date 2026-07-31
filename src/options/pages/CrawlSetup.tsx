import { useEffect, useState } from "react";
import type { CrawlProgress } from "@/background/messages.js";
import { parseCrawlConfig } from "@/domain/config.js";
import { DEFAULT_EXCLUDES } from "@/lib/patterns.js";
import { requestHostPermission } from "@/permissions/host.js";
import { requestPersistent } from "@/storage/quota.js";

const PHASE_LABEL: Record<CrawlProgress["phase"], string> = {
  idle: "Idle", discovering: "Discovering pages", crawling: "Crawling", embedding: "Indexing",
  paused: "Paused", done: "Done", error: "Stopped",
};

async function ensureOffscreen(): Promise<void> {
  await chrome.runtime.sendMessage({ type: "ensure-offscreen" });
}

export function CrawlSetup(): JSX.Element {
  const [root, setRoot] = useState("");
  const [excludes, setExcludes] = useState(DEFAULT_EXCLUDES.join("\n"));
  const [maxPages, setMaxPages] = useState(5000);
  const [maxDepth, setMaxDepth] = useState(10);
  const [progress, setProgress] = useState<CrawlProgress | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.runtime?.id) return;
    void chrome.tabs?.query({ active: true, currentWindow: true }).then((tabs) => {
      const url = tabs[0]?.url;
      if (url && /^https?:/.test(url)) setRoot(new URL(url).origin + "/");
    });
    const listener = (msg: unknown): void => {
      const m = msg as { type?: string; progress?: CrawlProgress };
      if (m?.type === "crawl/progress" && m.progress) setProgress(m.progress);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const start = async (): Promise<void> => {
    setError("");
    let config;
    try {
      config = parseCrawlConfig({
        root,
        scope: { include: [], exclude: excludes.split("\n").map((s) => s.trim()).filter(Boolean) },
        maxPages,
        maxDepth,
      });
    } catch {
      setError("Enter a valid https:// crawl root.");
      return;
    }
    if (!(await requestHostPermission(config.root))) {
      setError("Permission to read this site was declined.");
      return;
    }
    await requestPersistent();
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ type: "crawl/start", config });
  };

  const send = (type: "crawl/pause" | "crawl/resume") => void chrome.runtime.sendMessage({ type });

  const running = progress && ["discovering", "crawling", "embedding"].includes(progress.phase);
  const wall = progress?.authWall;

  return (
    <div className="page">
      <h1>Set up an index</h1>
      <p className="soft" style={{ maxWidth: "64ch" }}>Sherpa crawls this site as you — reaching anything you can see when signed in — and builds a private index that lives only on this device.</p>

      <section className="card">
        <div className="card-head"><h2>Scope the crawl</h2></div>
        <div className="card-body stack-4">
          <div className="field">
            <label htmlFor="root">Crawl root</label>
            <input className="input mono" id="root" value={root} onChange={(e) => setRoot(e.target.value)} placeholder="https://docs.example.com/" />
            <span className="help">Detected from your current tab. Sherpa stays within this path.</span>
          </div>
          <div className="row gap-4" style={{ flexWrap: "wrap" }}>
            <div className="field"><label htmlFor="mp">Max pages</label><input className="input num" id="mp" type="number" value={maxPages} style={{ maxWidth: 140 }} onChange={(e) => setMaxPages(Number(e.target.value))} /></div>
            <div className="field"><label htmlFor="md">Max depth</label><input className="input num" id="md" type="number" value={maxDepth} style={{ maxWidth: 140 }} onChange={(e) => setMaxDepth(Number(e.target.value))} /></div>
          </div>
          <div className="field">
            <label htmlFor="ex">Exclude patterns (one per line)</label>
            <textarea className="textarea mono" id="ex" rows={3} value={excludes} onChange={(e) => setExcludes(e.target.value)} />
          </div>
          {error && <div className="notice notice-amber"><span>{error}</span></div>}
          <div className="row-between">
            <button className="btn btn-primary" type="button" onClick={() => void start()} disabled={Boolean(running)}>Start crawl</button>
            {running && <div className="row gap-2"><button className="btn btn-sm" type="button" onClick={() => send("crawl/pause")}>Pause</button></div>}
          </div>
        </div>
      </section>

      {wall && (
        <section className="card" style={{ borderColor: "var(--amber)" }}>
          <div className="card-body stack-3">
            <div className="row gap-2"><strong>Authentication required</strong><span className="badge badge-amber">{wall.kind === "basic" ? "HTTP Basic" : "Sign-in needed"}</span></div>
            <p className="help">Sherpa crawls as you. <span className="mono">{wall.host}</span> blocked {wall.blocked.toLocaleString()} URLs behind sign-in. Your credentials never touch Sherpa — it reuses your browser session.</p>
            <div className="row gap-2">
              <button className="btn btn-primary btn-sm" type="button" onClick={() => void chrome.tabs.create({ url: `https://${wall.host}/` })}>Sign in to {wall.host}</button>
              <button className="btn btn-sm" type="button" onClick={() => send("crawl/resume")}>Resume crawl</button>
            </div>
          </div>
        </section>
      )}

      {progress && (
        <section className="card">
          <div className="card-head"><h2>{PHASE_LABEL[progress.phase]}</h2></div>
          <div className="card-body stack-3">
            <div className="progress green"><span style={{ width: `${progress.queued + progress.fetched > 0 ? Math.round((progress.fetched / (progress.queued + progress.fetched)) * 100) : 0}%` }} /></div>
            <div className="row gap-4" style={{ flexWrap: "wrap", fontSize: 13 }}>
              <span>Fetched <strong>{progress.fetched.toLocaleString()}</strong></span>
              <span>Queued <strong>{progress.queued.toLocaleString()}</strong></span>
              <span>Failed <strong>{progress.failed.toLocaleString()}</strong></span>
              <span>Skipped <strong>{progress.skipped.toLocaleString()}</strong></span>
            </div>
            {progress.currentUrl && <div className="meta mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{progress.currentUrl}</div>}
          </div>
        </section>
      )}
    </div>
  );
}
