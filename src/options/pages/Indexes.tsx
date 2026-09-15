import { useEffect, useRef, useState } from "react";
import type { IndexMeta } from "@/domain/records.js";
import { openSherpaDb } from "@/storage/db.js";
import { indexRepo } from "@/storage/indexRepo.js";
import { chunkStore } from "@/storage/chunks.js";
import { buildCorpusExport, parseCorpusExport } from "@/storage/corpusExport.js";
import type { ImportProgress } from "@/offscreen/importCorpusJob.js";
import { loadSettings, saveSettings } from "@/settings/settings.js";
import { storageEstimate, type StorageEstimate } from "@/storage/quota.js";
import { formatBytes } from "../models.js";
import { nextRefreshAt } from "@/crawl/autoRefresh.js";
import { requestHostPermission } from "@/permissions/host.js";

/** "in 12 days" / "due now", for the scheduled-refresh column. */
function dueIn(ts: number): string {
  const days = Math.ceil((ts - Date.now()) / 86_400_000);
  if (days <= 0) return "due now";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

function daysAgo(ts: number): string {
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

const hasExtension = (): boolean => typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);

export function Indexes({
  onRecrawl,
}: {
  /** Hand off to crawl setup so the settings can be reviewed before rebuilding. */
  readonly onRecrawl?: (target: { indexId: string; host: string; config: IndexMeta["config"] }) => void;
} = {}): JSX.Element {
  const [rows, setRows] = useState<IndexMeta[]>([]);
  const [active, setActive] = useState<string | undefined>(undefined);
  const [estimate, setEstimate] = useState<StorageEstimate | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [cadence, setCadence] = useState<number | null>(null);
  const [importing, setImporting] = useState<ImportProgress | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = async (): Promise<void> => {
    const db = await openSherpaDb();
    setRows(await indexRepo.list(db));
    const settings = await loadSettings();
    setActive(settings.activeIndexId);
    setCadence(settings.autoRefreshDays);
    setEstimate(await storageEstimate().catch(() => null));
    setLoading(false);
  };
  useEffect(() => void refresh(), []);

  /**
   * Import progress arrives from the offscreen document, which owns the
   * embedder. Re-reads the table when it finishes so the new counts appear
   * without the user reloading the page.
   */
  useEffect(() => {
    if (!hasExtension()) return;
    const listener = (msg: unknown): void => {
      const m = msg as { type?: string; progress?: ImportProgress };
      if (m?.type !== "index/import-progress" || !m.progress) return;
      setImporting(m.progress);
      if (m.progress.phase === "done") {
        void refresh();
        // Leave the completed state on screen briefly — an import that finishes
        // instantly is otherwise indistinguishable from one that never ran.
        setTimeout(() => setImporting(null), 4000);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  /**
   * Rebuild an index from an exported corpus rather than crawling it again.
   *
   * The file is handed over as a blob URL, not as message content: a 1,400-page
   * export is several megabytes and does not belong in a runtime message. Both
   * pages share an extension origin, so the offscreen document can fetch it —
   * which is also why this page has to stay open until the import finishes.
   */
  const onImportFile = async (file: File): Promise<void> => {
    if (!hasExtension()) return;
    setImporting({ phase: "reading", done: 0, total: 0, host: file.name });

    // Validate here, where the error can be shown next to the button that
    // caused it, rather than discovering it in the offscreen document.
    try {
      parseCorpusExport(JSON.parse(await file.text()));
    } catch (err) {
      setImporting({
        phase: "error",
        done: 0,
        total: 0,
        host: file.name,
        error: err instanceof Error ? err.message : "not a Sherpa export",
      });
      return;
    }

    const url = URL.createObjectURL(file);
    await chrome.runtime.sendMessage({ type: "ensure-offscreen" });
    await chrome.runtime.sendMessage({ type: "index/import", url });
  };

  const makeActive = async (id: string): Promise<void> => {
    await saveSettings({ activeIndexId: id });
    setActive(id);
  };

  const remove = async (id: string): Promise<void> => {
    const row = rows.find((r) => r.id === id);
    const size = row && row.sizeBytes > 0 ? formatBytes(row.sizeBytes) : "its storage";
    if (!confirm(`Delete this index and reclaim ${size}? This cannot be undone.`)) return;
    const db = await openSherpaDb();
    await indexRepo.delete(db, id);
    await refresh();
  };

  /** Incremental: only changed pages are re-embedded (PRD 5.6.5). */
  const recrawl = async (id: string): Promise<void> => {
    if (!hasExtension()) return;
    setBusy(id);
    await chrome.runtime.sendMessage({ type: "ensure-offscreen" });
    await chrome.runtime.sendMessage({ type: "crawl/recrawl", indexId: id });
    setBusy(null);
  };

  /**
   * Write the index out for the offline eval (`npm run eval`).
   *
   * The corpus the extension queries lives in IndexedDB, which the harness
   * cannot reach — and rebuilding it in Node would measure a different corpus
   * from the one users search. This is the bridge. Text only; vectors are
   * recomputed by whichever model is being tested.
   */
  /**
   * Set this index's reranking preference.
   *
   * "default" clears the field rather than writing `false`, so the index keeps
   * following the global setting instead of being silently pinned to whatever
   * that setting happened to be at the moment of the click.
   */
  const setRerank = async (row: IndexMeta, choice: string): Promise<void> => {
    const { rerank: _drop, ...rest } = row;
    const next: IndexMeta =
      choice === "default" ? rest : { ...rest, rerank: choice === "on" };
    await indexRepo.upsert(await openSherpaDb(), next);
    await refresh();
  };

  const exportForEval = async (row: IndexMeta): Promise<void> => {
    setBusy(row.id);
    try {
      const db = await openSherpaDb();
      const chunks = await chunkStore.listByIndex(db, row.id);
      const payload = buildCorpusExport(row, chunks, Date.now());
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(payload)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `sherpa-corpus-${row.host}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(null);
    }
  };

  /**
   * Re-grant host access for an index whose scheduled refresh stood down.
   * Must run from a click: `permissions.request` only works inside a user
   * gesture, which is exactly why the background job could not do this itself.
   */
  const regrant = async (row: IndexMeta): Promise<void> => {
    if (!hasExtension()) return;
    if (!(await requestHostPermission(row.root))) return;
    const db = await openSherpaDb();
    await indexRepo.upsert(db, { ...row, autoRefreshBlocked: false });
    await refresh();
  };

  /**
   * Full: rebuild from scratch (PRD 5.6.4). Routed through crawl setup so the
   * scope, caps and politeness can be reviewed and changed first — a rebuild
   * is usually prompted by wanting something *different*, not identical.
   */
  const fullRecrawl = (row: IndexMeta): void => {
    onRecrawl?.({ indexId: row.id, host: row.host, config: row.config });
  };

  if (loading) {
    return (
      <div className="page">
        <h1>Indexes</h1>
        <p className="help">Loading…</p>
      </div>
    );
  }

  const totalBytes = rows.reduce((n, r) => n + r.sizeBytes, 0);

  return (
    <div className="page">
      <h1>Indexes</h1>
      <div className="row-between" style={{ alignItems: "flex-start", gap: 16 }}>
        <p className="soft" style={{ maxWidth: "64ch" }}>
          Each index is a self-contained, on-device copy of a help site. Refresh to pick up new
          pages, or delete to reclaim storage. <strong>Import</strong> rebuilds an index from a file
          another machine exported — no crawl, and no need to be signed in to the site.
        </p>
        <div className="row gap-2" style={{ flex: "none" }}>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Reset so re-picking the same file fires change again.
              e.target.value = "";
              if (file) void onImportFile(file);
            }}
          />
          <button
            className="btn"
            type="button"
            disabled={importing !== null && importing.phase !== "error"}
            onClick={() => fileRef.current?.click()}
          >
            Import
          </button>
        </div>
      </div>

      {importing && (
        <section
          className={importing.phase === "error" ? "notice notice-amber" : "notice"}
          style={{ marginBottom: 16 }}
        >
          <span>
            {importing.phase === "error" ? (
              <>Couldn't import {importing.host}: {importing.error}</>
            ) : importing.phase === "done" ? (
              <>
                Imported {importing.host} — {importing.total.toLocaleString()} chunks embedded and
                indexed.
              </>
            ) : importing.phase === "embedding" ? (
              <>
                Embedding {importing.host} — {importing.done.toLocaleString()} of{" "}
                {importing.total.toLocaleString()} chunks. Keep this page open until it finishes.
              </>
            ) : importing.phase === "indexing" ? (
              <>Building the search index for {importing.host}…</>
            ) : (
              <>Reading {importing.host}…</>
            )}
          </span>
        </section>
      )}

      {rows.length > 0 && (
        <section className="card">
          <div className="card-body">
            <div className="row-between">
              <span>
                Sherpa is using <strong>{formatBytes(totalBytes)}</strong> across{" "}
                {rows.length.toLocaleString()} {rows.length === 1 ? "index" : "indexes"}
              </span>
              {estimate && (
                <span className="meta mono">
                  {formatBytes(estimate.usage)} / {formatBytes(estimate.quota)} granted
                </span>
              )}
            </div>
          </div>
        </section>
      )}

      {rows.length === 0 ? (
        <div className="card">
          <div className="card-body">
            <p className="help">
              No indexes yet. Head to <strong>Set up an index</strong> to crawl a help site.
            </p>
          </div>
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Site</th>
              <th>Pages</th>
              <th>Chunks</th>
              <th>Size</th>
              <th>Last indexed</th>
              <th>Auto-refresh</th>
              <th title="Rescore the top results with the cross-encoder. Measured +45 points on one help centre and −30 on another, so it is decided per index.">Rerank</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const stale = Date.now() - r.lastIndexedAt > 7 * 86_400_000;
              const due = nextRefreshAt(r, cadence);
              return (
                <tr key={r.id}>
                  <td>
                    <div className="row gap-2">
                      <strong>{r.title || r.host}</strong>
                      {active === r.id && <span className="badge badge-terra">Active</span>}
                    </div>
                    <div className="meta mono">{r.host}</div>
                  </td>
                  <td>{r.pageCount.toLocaleString()}</td>
                  <td>{r.chunkCount.toLocaleString()}</td>
                  <td>
                    {r.sizeBytes > 0 ? formatBytes(r.sizeBytes) : <span className="meta">—</span>}
                  </td>
                  <td>
                    <span className={stale ? "badge badge-amber" : "badge badge-green"}>
                      {daysAgo(r.lastIndexedAt)}
                    </span>
                  </td>
                  <td>
                    {r.autoRefreshBlocked ? (
                      <button
                        className="btn btn-sm"
                        type="button"
                        title="Sherpa no longer has access to this site, so the scheduled refresh could not run."
                        onClick={() => void regrant(r)}
                      >
                        Needs access
                      </button>
                    ) : due === null ? (
                      <span className="meta">Off</span>
                    ) : (
                      <span className="meta">{dueIn(due)}</span>
                    )}
                  </td>
                  {/*
                    Per index, because it was measured helping and hurting on
                    the same day. Three states, not two: "Default" defers to
                    Settings, which is what every existing index does and what a
                    new one should do until someone has measured this corpus.
                  */}
                  <td>
                    <select
                      className="select"
                      style={{ maxWidth: 110 }}
                      aria-label={`Reranking for ${r.host}`}
                      value={r.rerank === undefined ? "default" : r.rerank ? "on" : "off"}
                      onChange={(e) => void setRerank(r, e.target.value)}
                    >
                      <option value="default">Default</option>
                      <option value="on">On</option>
                      <option value="off">Off</option>
                    </select>
                  </td>
                  <td>
                    <div className="row gap-2">
                      {active !== r.id && (
                        <button
                          className="btn btn-sm"
                          type="button"
                          onClick={() => void makeActive(r.id)}
                        >
                          Use
                        </button>
                      )}
                      <button
                        className="btn btn-sm"
                        type="button"
                        disabled={busy === r.id}
                        onClick={() => void recrawl(r.id)}
                      >
                        Refresh
                      </button>
                      <button
                        className="btn btn-sm"
                        type="button"
                        disabled={busy === r.id}
                        onClick={() => fullRecrawl(r)}
                      >
                        Full re-crawl
                      </button>
                      <button
                        className="btn btn-sm"
                        type="button"
                        disabled={busy === r.id}
                        title="Write this index out as JSON for the offline eval"
                        onClick={() => void exportForEval(r)}
                      >
                        Export
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        type="button"
                        onClick={() => void remove(r.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {rows.length > 0 && (
        <p className="help" style={{ marginTop: 12 }}>
          <strong>Refresh</strong> re-fetches every page but only re-embeds the ones that changed.{" "}
          <strong>Full re-crawl</strong> discards the index and rebuilds it. Scheduled refreshes
          run the same incremental pass on their own, while your machine is idle — the cadence
          lives in Settings.
        </p>
      )}
    </div>
  );
}
