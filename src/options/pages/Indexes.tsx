import { useEffect, useState } from "react";
import type { IndexMeta } from "@/domain/records.js";
import { openSherpaDb } from "@/storage/db.js";
import { indexRepo } from "@/storage/indexRepo.js";
import { loadSettings, saveSettings } from "@/settings/settings.js";
import { formatBytes } from "../models.js";

function daysAgo(ts: number): string {
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

export function Indexes(): JSX.Element {
  const [rows, setRows] = useState<IndexMeta[]>([]);
  const [active, setActive] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const refresh = async (): Promise<void> => {
    const db = await openSherpaDb();
    setRows(await indexRepo.list(db));
    setActive((await loadSettings()).activeIndexId);
    setLoading(false);
  };
  useEffect(() => void refresh(), []);

  const makeActive = async (id: string): Promise<void> => {
    await saveSettings({ activeIndexId: id });
    setActive(id);
  };

  const remove = async (id: string): Promise<void> => {
    if (!confirm("Delete this index and reclaim its storage?")) return;
    const db = await openSherpaDb();
    await indexRepo.delete(db, id);
    await refresh();
  };

  const recrawl = async (id: string): Promise<void> => {
    if (typeof chrome === "undefined" || !chrome.runtime?.id) return;
    await chrome.runtime.sendMessage({ type: "ensure-offscreen" });
    await chrome.runtime.sendMessage({ type: "crawl/recrawl", indexId: id });
  };

  if (loading) return <div className="page"><h1>Indexes</h1><p className="help">Loading…</p></div>;

  return (
    <div className="page">
      <h1>Indexes</h1>
      {rows.length === 0 ? (
        <div className="card"><div className="card-body"><p className="help">No indexes yet. Head to <strong>Set up an index</strong> to crawl a help site.</p></div></div>
      ) : (
        <table className="table">
          <thead>
            <tr><th>Site</th><th>Pages</th><th>Chunks</th><th>Size</th><th>Last indexed</th><th /></tr>
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
                  <td>{formatBytes(r.sizeBytes || r.pageCount * 23_000)}</td>
                  <td><span className={stale ? "badge badge-amber" : "badge badge-green"}>{daysAgo(r.lastIndexedAt)}</span></td>
                  <td>
                    <div className="row gap-2">
                      {active !== r.id && <button className="btn btn-sm" type="button" onClick={() => void makeActive(r.id)}>Use</button>}
                      <button className="btn btn-sm" type="button" onClick={() => void recrawl(r.id)}>Recrawl</button>
                      <button className="btn btn-sm btn-danger" type="button" onClick={() => void remove(r.id)}>Delete</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
