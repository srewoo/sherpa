import { useEffect, useState } from "react";
import type { IndexMeta } from "@/domain/records.js";
import { openSherpaDb } from "@/storage/db.js";
import { indexRepo } from "@/storage/indexRepo.js";
import { loadSettings, saveSettings } from "@/settings/settings.js";
import { storageEstimate, type StorageEstimate } from "@/storage/quota.js";
import { formatBytes } from "../models.js";

function daysAgo(ts: number): string {
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

const hasExtension = (): boolean => typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);

export function Indexes(): JSX.Element {
  const [rows, setRows] = useState<IndexMeta[]>([]);
  const [active, setActive] = useState<string | undefined>(undefined);
  const [estimate, setEstimate] = useState<StorageEstimate | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    const db = await openSherpaDb();
    setRows(await indexRepo.list(db));
    setActive((await loadSettings()).activeIndexId);
    setEstimate(await storageEstimate().catch(() => null));
    setLoading(false);
  };
  useEffect(() => void refresh(), []);

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

  /** Full: discard and rebuild from scratch (PRD 5.6.4). */
  const fullRecrawl = async (id: string): Promise<void> => {
    if (!hasExtension()) return;
    if (
      !confirm(
        "Discard this index and crawl the whole site again? This takes as long as the first crawl.",
      )
    ) {
      return;
    }
    setBusy(id);
    await chrome.runtime.sendMessage({ type: "ensure-offscreen" });
    await chrome.runtime.sendMessage({ type: "crawl/recrawl-full", indexId: id });
    setBusy(null);
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
      <p className="soft" style={{ maxWidth: "64ch" }}>
        Each index is a self-contained, on-device copy of a help site. Refresh to pick up new pages,
        or delete to reclaim storage.
      </p>

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
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const stale = Date.now() - r.lastIndexedAt > 7 * 86_400_000;
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
                        onClick={() => void fullRecrawl(r.id)}
                      >
                        Full re-crawl
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
          <strong>Full re-crawl</strong> discards the index and rebuilds it.
        </p>
      )}
    </div>
  );
}
