import { useEffect, useState } from "react";
import type { CrawlProgress } from "@/background/messages.js";
import type { CrawlPreview } from "@/crawl/preview.js";
import { parseCrawlConfig, type CrawlConfig } from "@/domain/config.js";
import { DEFAULT_EXCLUDES } from "@/lib/patterns.js";
import { requestHostPermission } from "@/permissions/host.js";
import { requestPersistent } from "@/storage/quota.js";
import { openSherpaDb } from "@/storage/db.js";
import { metaRepo } from "@/storage/metaRepo.js";
import { indexRepo } from "@/storage/indexRepo.js";
import { frontier } from "@/crawl/frontier.js";
import { formatBytes } from "../models.js";

const PHASE_LABEL: Record<CrawlProgress["phase"], string> = {
  idle: "Idle",
  discovering: "Discovering pages",
  crawling: "Crawling",
  embedding: "Indexing",
  paused: "Paused",
  done: "Done",
  error: "Stopped",
};

function formatDuration(seconds: number): string {
  if (seconds < 90) return `~${Math.max(1, Math.round(seconds))} sec`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `~${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `~${hours}h ${minutes % 60}m`;
}

async function ensureOffscreen(): Promise<void> {
  await chrome.runtime.sendMessage({ type: "ensure-offscreen" });
}

/** Ask the offscreen doc to discover + estimate without fetching pages (5.1.4). */
function requestPreview(
  config: CrawlConfig,
): Promise<{ preview: CrawlPreview | null; error: string | undefined }> {
  const requestId = `p-${Date.now()}`;
  return new Promise((resolve) => {
    const listener = (msg: unknown): void => {
      const m = msg as {
        type?: string;
        requestId?: string;
        preview?: CrawlPreview | null;
        error?: string;
      };
      if (m?.type !== "crawl/preview-result" || m.requestId !== requestId) return;
      chrome.runtime.onMessage.removeListener(listener);
      resolve({ preview: m.preview ?? null, error: m.error });
    };
    chrome.runtime.onMessage.addListener(listener);
    void chrome.runtime.sendMessage({ type: "crawl/preview", requestId, config });
    // Discovery over a large sitemap index can be slow; don't hang the UI forever.
    setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      resolve({ preview: null, error: "Discovery timed out. Check the root URL and try again." });
    }, 60_000);
  });
}

/** An existing index the user chose to re-crawl, with its stored settings. */
export interface RecrawlTarget {
  readonly indexId: string;
  readonly host: string;
  readonly config: CrawlConfig;
}

export function CrawlSetup({
  recrawl = null,
  onDone,
}: {
  readonly recrawl?: RecrawlTarget | null;
  readonly onDone?: () => void;
} = {}): JSX.Element {
  const [root, setRoot] = useState("");
  const [includes, setIncludes] = useState("");
  const [excludes, setExcludes] = useState(DEFAULT_EXCLUDES.join("\n"));
  const [maxPages, setMaxPages] = useState(5000);
  const [maxDepth, setMaxDepth] = useState(10);
  const [rps, setRps] = useState(1);
  const [concurrency, setConcurrency] = useState(3);
  const [progress, setProgress] = useState<CrawlProgress | null>(null);
  const [preview, setPreview] = useState<CrawlPreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");

  // Re-crawling an existing index starts from its stored settings, so they can
  // be reviewed and edited rather than silently reused (PRD 5.6.4).
  useEffect(() => {
    if (!recrawl) return;
    const { config } = recrawl;
    setRoot(config.root);
    setIncludes(config.scope.include.join("\n"));
    setExcludes(config.scope.exclude.join("\n"));
    setMaxPages(config.maxPages);
    setMaxDepth(config.maxDepth);
    setRps(config.requestsPerSecond);
    setConcurrency(config.concurrency);
    setPreview(null);
  }, [recrawl]);

  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.runtime?.id) return;
    // Guess the root from the current tab, but only for a brand-new index —
    // a re-crawl already has one. The progress listener is registered either
    // way, so a rebuild still reports its progress here.
    if (!recrawl) {
      void chrome.tabs?.query({ active: true, currentWindow: true }).then((tabs) => {
        const url = tabs[0]?.url;
        if (url && /^https?:/.test(url)) setRoot(new URL(url).origin + "/");
      });
    }
    const listener = (msg: unknown): void => {
      const m = msg as { type?: string; progress?: CrawlProgress };
      if (m?.type === "crawl/progress" && m.progress) setProgress(m.progress);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [recrawl]);

  const buildConfig = (): CrawlConfig | null => {
    try {
      return parseCrawlConfig({
        root,
        scope: {
          include: includes.split("\n").map((s) => s.trim()).filter(Boolean),
          exclude: excludes.split("\n").map((s) => s.trim()).filter(Boolean),
        },
        maxPages,
        maxDepth,
        requestsPerSecond: rps,
        concurrency,
      });
    } catch {
      setError("Enter a valid https:// crawl root.");
      return null;
    }
  };

  /** Step 1: discover and estimate. Nothing is fetched but robots + sitemap. */
  const check = async (): Promise<void> => {
    setError("");
    setPreview(null);
    const config = buildConfig();
    if (!config) return;

    // Discovery reads robots.txt and the sitemap, so it needs host access too.
    if (!(await requestHostPermission(config.root))) {
      setError("Permission to read this site was declined.");
      return;
    }
    setChecking(true);
    await ensureOffscreen();
    const { preview: result, error: failure } = await requestPreview(config);
    setChecking(false);
    if (!result) {
      setError(failure ?? "Could not read this site's sitemap.");
      return;
    }
    setPreview(result);
  };

  /** Step 2: crawl for real. Refused when the index won't fit (PRD 5.5.6). */
  const start = async (): Promise<void> => {
    setError("");
    const config = buildConfig();
    if (!config) return;
    if (preview && !preview.fits) {
      setError("Not enough free storage for this index. Narrow the scope or free space first.");
      return;
    }
    if (!(await requestHostPermission(config.root))) {
      setError("Permission to read this site was declined.");
      return;
    }
    await requestPersistent();
    await ensureOffscreen();

    if (recrawl) {
      // Rebuild in place, carrying whatever the user just edited, so the index
      // id — and the active-index selection pointing at it — survive.
      await chrome.runtime.sendMessage({
        type: "crawl/recrawl-full",
        indexId: recrawl.indexId,
        config,
      });
      onDone?.();
      return;
    }
    await chrome.runtime.sendMessage({ type: "crawl/start", config });
  };

  const send = (type: "crawl/pause" | "crawl/resume"): void =>
    void chrome.runtime.sendMessage({ type });

  /** Per-URL failure log with reason codes, as CSV (PRD 5.2.10). */
  const exportFailures = async (): Promise<void> => {
    const db = await openSherpaDb();
    const active = await metaRepo.activeCrawl(db);
    const indexId = active?.indexId ?? (await indexRepo.list(db))[0]?.id;
    if (!indexId) return;

    const rows = await frontier.failures(db, indexId);
    const csv = [
      "url,reason,http_status,attempts",
      ...rows.map((r) =>
        [`"${r.url.replace(/"/g, '""')}"`, r.reason ?? "other", r.lastStatus ?? "", r.attempts ?? 1].join(","),
      ),
    ].join("\n");

    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "sherpa-crawl-failures.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const running = progress && ["discovering", "crawling", "embedding"].includes(progress.phase);
  const wall = progress?.authWall;
  const total = progress ? progress.queued + progress.fetched : 0;

  return (
    <div className="page">
      <h1>{recrawl ? `Re-crawl ${recrawl.host}` : "Set up an index"}</h1>
      <p className="soft" style={{ maxWidth: "64ch" }}>
        {recrawl
          ? "Review the settings below, then rebuild. The existing index is replaced only once the crawl starts, and its conversations and place in the site switcher are kept."
          : "Sherpa crawls this site as you — reaching anything you can see when signed in — and builds a private index that lives only on this device."}
      </p>

      <section className="card">
        <div className="card-head">
          <h2>Scope the crawl</h2>
        </div>
        <div className="card-body stack-4">
          <div className="field">
            <label htmlFor="root">Crawl root</label>
            <input
              className="input mono"
              id="root"
              value={root}
              onChange={(e) => {
                setRoot(e.target.value);
                setPreview(null);
              }}
              placeholder="https://docs.example.com/"
            />
            <span className="help">
              Detected from your current tab. Sherpa stays within this path.
            </span>
          </div>

          <div className="row gap-4" style={{ flexWrap: "wrap" }}>
            <div className="field">
              <label htmlFor="mp">Max pages</label>
              <input
                className="input num"
                id="mp"
                type="number"
                value={maxPages}
                style={{ maxWidth: 140 }}
                onChange={(e) => setMaxPages(Number(e.target.value))}
              />
            </div>
            <div className="field">
              <label htmlFor="md">Max depth</label>
              <input
                className="input num"
                id="md"
                type="number"
                value={maxDepth}
                style={{ maxWidth: 140 }}
                onChange={(e) => setMaxDepth(Number(e.target.value))}
              />
            </div>
            <div className="field">
              <label htmlFor="rps">Requests / sec</label>
              <input
                className="input num"
                id="rps"
                type="number"
                step="0.5"
                min="0.5"
                value={rps}
                style={{ maxWidth: 140 }}
                onChange={(e) => setRps(Number(e.target.value))}
              />
            </div>
            <div className="field">
              <label htmlFor="cc">Concurrency</label>
              <input
                className="input num"
                id="cc"
                type="number"
                min="1"
                value={concurrency}
                style={{ maxWidth: 140 }}
                onChange={(e) => setConcurrency(Number(e.target.value))}
              />
            </div>
          </div>
          <span className="help">
            Politeness caps, per host. Sherpa also honours <span className="mono">Crawl-delay</span>{" "}
            when robots.txt sets one.
          </span>

          <div className="field">
            <label htmlFor="inc">
              Include patterns (one per line, blank = everything under the root)
            </label>
            <textarea
              className="textarea mono"
              id="inc"
              rows={2}
              value={includes}
              placeholder={"*/docs/*\n*/api/*"}
              onChange={(e) => {
                setIncludes(e.target.value);
                setPreview(null);
              }}
            />
          </div>
          <div className="field">
            <label htmlFor="ex">Exclude patterns (one per line)</label>
            <textarea
              className="textarea mono"
              id="ex"
              rows={3}
              value={excludes}
              onChange={(e) => {
                setExcludes(e.target.value);
                setPreview(null);
              }}
            />
            <span className="help">Exclude always wins over include.</span>
          </div>

          {error && (
            <div className="notice notice-amber">
              <span>{error}</span>
            </div>
          )}

          <div className="row-between">
            <div className="row gap-2">
              <button
                className={preview ? "btn" : "btn btn-primary"}
                type="button"
                onClick={() => void check()}
                disabled={checking || Boolean(running)}
              >
                {checking ? "Checking…" : preview ? "Re-check scope" : "Check scope"}
              </button>
              {preview && (
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => void start()}
                  disabled={Boolean(running) || !preview.fits}
                >
                  {recrawl ? "Rebuild index" : "Start crawl"}
                </button>
              )}
            </div>
            {running && (
              <button className="btn btn-sm" type="button" onClick={() => send("crawl/pause")}>
                Pause
              </button>
            )}
          </div>
        </div>
      </section>

      {preview && (
        <section className="card">
          <div className="card-head">
            <h2>Estimated crawl</h2>
          </div>
          <div className="card-body stack-3">
            <div className="row gap-4" style={{ flexWrap: "wrap" }}>
              <div className="stat">
                <span className="stat-label">Pages in scope</span>
                <strong className="stat-value">{preview.inScope.toLocaleString()}</strong>
              </div>
              <div className="stat">
                <span className="stat-label">Duration</span>
                <strong className="stat-value">{formatDuration(preview.estimatedSeconds)}</strong>
              </div>
              <div className="stat">
                <span className="stat-label">On disk</span>
                <strong className="stat-value">{formatBytes(preview.estimatedBytes)}</strong>
              </div>
              <div className="stat">
                <span className="stat-label">Free</span>
                <strong className="stat-value">{formatBytes(preview.storage.available)}</strong>
              </div>
            </div>

            <p className="help">
              {preview.hasSitemap
                ? `Discovered ${preview.discovered.toLocaleString()} URLs from the sitemap.`
                : "No sitemap found — Sherpa will follow links from the root instead."}{" "}
              {preview.linkedInScope > 0 &&
                `${preview.linkedInScope.toLocaleString()} more linked from the root page. `}
              {preview.excluded > 0 &&
                `${preview.excluded.toLocaleString()} excluded by your patterns. `}
              {preview.blockedByRobots > 0 &&
                `${preview.blockedByRobots.toLocaleString()} disallowed by robots.txt.`}
            </p>
            <p className="help">
              Scope: <span className="mono">{new URL(root).hostname}{preview.scopePrefix}</span> —
              Sherpa only follows links under this path.
            </p>

            {preview.requiresAuth && (
              <div className="notice notice-amber">
                <span>
                  <strong>{new URL(root).hostname} is asking you to sign in.</strong> The crawl root
                  returns a sign-in page rather than content, so Sherpa would index the login screen
                  and stop. Sign in to the site in this browser, then re-check the scope — Sherpa
                  crawls using your existing session and never sees your credentials.
                  <button
                    className="link-btn"
                    type="button"
                    style={{ marginLeft: 8 }}
                    onClick={() => void chrome.tabs.create({ url: root })}
                  >
                    Open {new URL(root).hostname}
                  </button>
                </span>
              </div>
            )}

            {preview.suggestion && !preview.requiresAuth && (
              <div className="notice notice-amber">
                <span>
                  This root reaches <strong>{preview.linkedInScope.toLocaleString()}</strong> of the{" "}
                  {preview.linkedOnHost.toLocaleString()} pages linked from it — the rest sit outside{" "}
                  <span className="mono">{preview.scopePrefix}</span>. Broadening to{" "}
                  <span className="mono">{new URL(preview.suggestion.root).hostname}</span> reaches{" "}
                  {preview.suggestion.reachable.toLocaleString()} linked pages.
                  <button
                    className="link-btn"
                    type="button"
                    style={{ marginLeft: 8 }}
                    onClick={() => {
                      setRoot(preview.suggestion!.root);
                      setPreview(null);
                    }}
                  >
                    Use {preview.suggestion.root}
                  </button>
                </span>
              </div>
            )}

            {!preview.fits && (
              <div className="notice notice-amber">
                <span>
                  This index needs about {formatBytes(preview.estimatedBytes)} but only{" "}
                  {formatBytes(preview.storage.available)} is free. Narrow the scope, lower max
                  pages, or free up space — Sherpa won't start a crawl it can't finish.
                </span>
              </div>
            )}
          </div>
        </section>
      )}

      {wall && (
        <section className="card" style={{ borderColor: "var(--amber)" }}>
          <div className="card-body stack-3">
            <div className="row gap-2">
              <strong>Authentication required</strong>
              <span className="badge badge-amber">
                {wall.kind === "basic" ? "HTTP Basic" : "Sign-in needed"}
              </span>
            </div>
            <p className="help">
              Sherpa crawls as you. <span className="mono">{wall.host}</span> blocked{" "}
              {wall.blocked.toLocaleString()} URLs behind sign-in. Your credentials never touch
              Sherpa — it reuses your browser session.
            </p>
            <div className="row gap-2">
              <button
                className="btn btn-primary btn-sm"
                type="button"
                onClick={() => void chrome.tabs.create({ url: `https://${wall.host}/` })}
              >
                Sign in to {wall.host}
              </button>
              <button className="btn btn-sm" type="button" onClick={() => send("crawl/resume")}>
                Resume crawl
              </button>
            </div>
          </div>
        </section>
      )}

      {progress && (
        <section className="card">
          <div className="card-head">
            <h2>{PHASE_LABEL[progress.phase]}</h2>
          </div>
          <div className="card-body stack-3">
            <div className="progress green">
              <span
                style={{
                  width: `${total > 0 ? Math.round((progress.fetched / total) * 100) : 0}%`,
                }}
              />
            </div>
            <div className="row gap-4" style={{ flexWrap: "wrap", fontSize: 13 }}>
              <span>
                Fetched <strong>{progress.fetched.toLocaleString()}</strong>
              </span>
              <span>
                Queued <strong>{progress.queued.toLocaleString()}</strong>
              </span>
              <span>
                Failed <strong>{progress.failed.toLocaleString()}</strong>
              </span>
              <span>
                Skipped <strong>{progress.skipped.toLocaleString()}</strong>
              </span>
              <span>
                Chunks <strong>{progress.embedded.toLocaleString()}</strong>
              </span>
              {progress.unchanged !== undefined && progress.unchanged > 0 && (
                <span>
                  Unchanged <strong>{progress.unchanged.toLocaleString()}</strong>
                </span>
              )}
            </div>
            {progress.retrying !== undefined && progress.retrying > 0 && (
              <p className="help">
                Retrying {progress.retrying.toLocaleString()} pages that failed transiently.
              </p>
            )}

            {/*
              An aborted crawl used to look identical to a finished one with a
              few failures: the heading said "Stopped", the counters said 222
              fetched, and nothing said that 14 pages were still queued and
              would never be fetched. The index is real and usable, so say both
              halves — what you have, and what is missing — and offer the one
              action that finishes the job.
            */}
            {progress.phase === "error" && progress.queued > 0 && (
              <div className="notice notice-amber">
                <p>
                  The crawl stopped early: too many pages failed in a row, which usually means the
                  site started refusing requests. {progress.fetched.toLocaleString()} pages were
                  indexed and are ready to search; {progress.queued.toLocaleString()} were never
                  fetched.
                </p>
                <p className="help" style={{ marginTop: 4 }}>
                  Run a refresh to pick up the pages that were missed — it keeps what is already
                  indexed and only fetches the rest.
                </p>
              </div>
            )}

            {progress.failed > 0 && ["done", "error", "paused"].includes(progress.phase) && (
              <div className="row gap-2">
                <span className="help">
                  {progress.failed.toLocaleString()} pages could not be fetched, after a retry pass.
                </span>
                <button className="link-btn" type="button" onClick={() => void exportFailures()}>
                  Download failure log
                </button>
              </div>
            )}

            {progress.currentUrl && (
              <div
                className="meta mono"
                style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {progress.currentUrl}
              </div>
            )}
            {progress.phase === "paused" && !wall && (
              <div className="row gap-2">
                <button className="btn btn-sm" type="button" onClick={() => send("crawl/resume")}>
                  Resume crawl
                </button>
              </div>
            )}
            {["crawling", "embedding"].includes(progress.phase) && (
              <p className="help">
                You can already ask questions — coverage grows as indexing continues.
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
