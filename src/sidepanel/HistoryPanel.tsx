/**
 * Chat history drawer (PRD 5.9.9). Lists the conversations held for the active
 * index, most recent first, and lets the user reopen or delete one.
 */

import { MAX_CHAT_SESSIONS } from "@/storage/schema.js";
import { relativeTime, type HistoryEntry } from "./history.js";

interface Props {
  readonly entries: readonly HistoryEntry[];
  readonly activeId: string | null;
  readonly onOpen: (id: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onClear: () => void;
  readonly onClose: () => void;
}

export function HistoryPanel({
  entries,
  activeId,
  onOpen,
  onDelete,
  onClear,
  onClose,
}: Props): JSX.Element {
  return (
    <div className="history">
      <div className="history-head">
        <span className="eyebrow">Recent conversations</span>
        <button className="btn-icon" type="button" aria-label="Close history" onClick={onClose}>
          <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {entries.length === 0 ? (
        <p className="help" style={{ padding: "12px 2px" }}>
          Nothing yet. Ask a question and it'll be saved here.
        </p>
      ) : (
        <>
          <ul className="history-list">
            {entries.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className={entry.id === activeId ? "history-item current" : "history-item"}
                  onClick={() => onOpen(entry.id)}
                  aria-current={entry.id === activeId ? "true" : undefined}
                >
                  <span className="history-title">{entry.title}</span>
                  <span className="history-meta">
                    {entry.turnCount} {entry.turnCount === 1 ? "question" : "questions"} ·{" "}
                    {relativeTime(entry.updatedAt)}
                  </span>
                </button>
                <button
                  className="history-del"
                  type="button"
                  aria-label={`Delete conversation: ${entry.title}`}
                  onClick={() => onDelete(entry.id)}
                >
                  <svg className="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>

          <div className="row-between history-foot">
            <span className="meta">
              Keeping the last {MAX_CHAT_SESSIONS} conversations, on this device only.
            </span>
            <button className="link-btn" type="button" onClick={onClear}>
              Clear all
            </button>
          </div>
        </>
      )}
    </div>
  );
}
