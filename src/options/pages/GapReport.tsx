/**
 * Content gap report (PRD 5.11). The docs-owner view: which questions the index
 * failed to answer, clustered by topic and ranked by how often they were asked,
 * exportable to CSV/Markdown for a docs backlog.
 *
 * Everything is computed locally from the query log — no queries leave the
 * device to produce this.
 */

import { useEffect, useState } from "react";
import type { IndexMeta } from "@/domain/records.js";
import { openSherpaDb } from "@/storage/db.js";
import { indexRepo } from "@/storage/indexRepo.js";
import { queryLogStore } from "@/gap/queryLog.js";
import { buildGapReport, clusterFailures, isFailed, toCSV, toMarkdown, type GapRow, type QueryStat } from "@/gap/gap.js";
import { loadSettings } from "@/settings/settings.js";

function download(filename: string, body: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function GapReport(): JSX.Element {
  const [indexes, setIndexes] = useState<IndexMeta[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [rows, setRows] = useState<GapRow[]>([]);
  const [totals, setTotals] = useState({ queries: 0, failed: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const db = await openSherpaDb();
      const list = await indexRepo.list(db);
      setIndexes(list);
      const active = (await loadSettings()).activeIndexId;
      setSelected(active && list.some((i) => i.id === active) ? active : (list[0]?.id ?? ""));
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (!selected) {
      setRows([]);
      setTotals({ queries: 0, failed: 0 });
      return;
    }
    void (async () => {
      const db = await openSherpaDb();
      const floor = (await loadSettings()).floor;
      const log = await queryLogStore.listByIndex(db, selected);
      const stats: QueryStat[] = log.map((e) => ({
        query: e.query,
        topScore: e.topScore,
        answered: e.answered,
        ...(e.feedback ? { feedback: e.feedback } : {}),
      }));
      const failed = stats.filter((s) => isFailed(s, floor));
      setRows(buildGapReport(clusterFailures(failed)));
      setTotals({ queries: stats.length, failed: failed.length });
    })();
  }, [selected]);

  if (loading) {
    return (
      <div className="page">
        <h1>Gap report</h1>
        <p className="help">Loading…</p>
      </div>
    );
  }

  const site = indexes.find((i) => i.id === selected);

  return (
    <div className="page">
      <h1>Content gap report</h1>
      <p className="soft" style={{ maxWidth: "64ch" }}>
        Questions this index couldn't answer — below the confidence floor, refused, or marked not
        helpful — grouped by topic. Computed on this device from your own queries.
      </p>

      {indexes.length === 0 ? (
        <div className="card">
          <div className="card-body">
            <p className="help">No indexes yet, so there are no queries to analyse.</p>
          </div>
        </div>
      ) : (
        <>
          <section className="card">
            <div className="card-body">
              <div className="row-between" style={{ flexWrap: "wrap", gap: 12 }}>
                <div className="field" style={{ maxWidth: 320 }}>
                  <label htmlFor="idx">Index</label>
                  <select
                    className="select"
                    id="idx"
                    value={selected}
                    onChange={(e) => setSelected(e.target.value)}
                  >
                    {indexes.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.title || i.host}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="row gap-4">
                  <div className="stat">
                    <span className="stat-label">Queries logged</span>
                    <strong className="stat-value">{totals.queries.toLocaleString()}</strong>
                  </div>
                  <div className="stat">
                    <span className="stat-label">Unanswered</span>
                    <strong className="stat-value">{totals.failed.toLocaleString()}</strong>
                  </div>
                  <div className="stat">
                    <span className="stat-label">Topics</span>
                    <strong className="stat-value">{rows.length.toLocaleString()}</strong>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {rows.length === 0 ? (
            <div className="card">
              <div className="card-body">
                <p className="help">
                  {totals.queries === 0
                    ? "No queries logged for this index yet. Ask a few questions in the side panel first."
                    : `All ${totals.queries.toLocaleString()} logged queries were answered above the confidence floor — no gaps to report.`}
                </p>
              </div>
            </div>
          ) : (
            <>
              <table className="table">
                <thead>
                  <tr>
                    <th>Topic</th>
                    <th>Asks</th>
                    <th>Avg score</th>
                    <th>Examples</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.topic}>
                      <td>
                        <strong>{r.topic}</strong>
                      </td>
                      <td>{r.count.toLocaleString()}</td>
                      <td>
                        <span className="badge badge-amber">{r.avgScore.toFixed(2)}</span>
                      </td>
                      <td className="meta">{r.examples.join(" · ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="row gap-2" style={{ marginTop: 16 }}>
                <button
                  className="btn btn-sm"
                  type="button"
                  onClick={() =>
                    download(`sherpa-gaps-${site?.host ?? "index"}.csv`, toCSV(rows), "text/csv")
                  }
                >
                  Export CSV
                </button>
                <button
                  className="btn btn-sm"
                  type="button"
                  onClick={() =>
                    download(
                      `sherpa-gaps-${site?.host ?? "index"}.md`,
                      toMarkdown(rows),
                      "text/markdown",
                    )
                  }
                >
                  Export Markdown
                </button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
