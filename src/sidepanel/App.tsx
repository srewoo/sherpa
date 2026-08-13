import { useCallback, useEffect, useRef, useState } from "react";
import type { Turn, SourceView } from "./types.js";
import type { PanelEvent } from "@/shared/answer.js";
import { SEED_TURNS } from "./seed.js";
import { BrandMark, TurnView } from "./components.js";
import { renderMarkdown } from "./markdown.js";
import {
  askQuery,
  warmIndex,
  hasExtension,
  requestRefresh,
  requestFullRecrawl,
  openOptions,
} from "./client.js";
import {
  loadIndexes,
  setActiveIndex,
  starterQuestions,
  freshnessLabel,
  isStale,
  type IndexOption,
} from "./indexInfo.js";
import { HistoryPanel } from "./HistoryPanel.js";
import {
  newSession,
  saveSession,
  listHistory,
  loadSession,
  deleteSession,
  clearHistory,
  toTurns,
  type HistoryEntry,
  type LiveSession,
} from "./history.js";

/**
 * Absolute URL for one of the bundled documentation pages.
 *
 * `chrome.runtime.getURL` outside the extension — the panel renders in a plain
 * browser during development and in tests — returns nothing useful, so the raw
 * path is the fallback. Either way the link is local: these pages ship inside
 * the extension precisely so the privacy policy is readable without a network
 * request, which a hosted link could not promise.
 */
function docUrl(page: "help" | "privacy"): string {
  const path = `src/${page}/index.html`;
  return typeof chrome !== "undefined" && chrome.runtime?.getURL
    ? chrome.runtime.getURL(path)
    : `/${path}`;
}

/** Fold a streamed PanelEvent into the turn it belongs to. */
function applyEvent(turn: Turn, event: PanelEvent, textRef: { text: string }): Turn {
  if (event.kind === "sources") {
    return {
      ...turn,
      answer: {
        kind: "answer",
        tier: event.tier,
        html: turn.answer.kind === "answer" ? turn.answer.html : "",
        markdown: turn.answer.kind === "answer" ? turn.answer.markdown : "",
        sources: event.sources as SourceView[],
        pending: true,
        certainty: event.certainty,
        ...(event.notice ? { notice: event.notice } : {}),
      },
    };
  }
  if (event.kind === "delta" && turn.answer.kind === "answer") {
    textRef.text += event.delta;
    return {
      ...turn,
      answer: {
        ...turn.answer,
        markdown: textRef.text,
        // Bound citations to the sources actually on screen, so the model
        // writing [6] against five sources cannot render a chip to nowhere.
        html: renderMarkdown(textRef.text, turn.answer.sources.length),
      },
    };
  }
  // Arrives after the answer has streamed, so it only ever decorates one.
  if (event.kind === "refine" && turn.answer.kind === "answer") {
    return {
      ...turn,
      answer: {
        ...turn.answer,
        refine: { options: event.options, ...(event.facet ? { facet: event.facet } : {}) },
      },
    };
  }
  if (event.kind === "refusal") {
    return {
      ...turn,
      answer: {
        kind: "refusal",
        nearest: event.nearest as SourceView[],
        reason: event.reason,
      },
    };
  }
  return turn;
}

export function App(): JSX.Element {
  const [turns, setTurns] = useState<readonly Turn[]>(hasExtension ? [] : SEED_TURNS);
  const [draft, setDraft] = useState("");
  const [indexes, setIndexes] = useState<readonly IndexOption[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [starters, setStarters] = useState<readonly string[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<readonly HistoryEntry[]>([]);
  const sessionRef = useRef<LiveSession | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const active = indexes.find((i) => i.id === activeId) ?? null;

  const refreshHistory = useCallback(async (indexId: string): Promise<void> => {
    setHistory(await listHistory(indexId));
  }, []);

  /** Start a fresh conversation against the current index. */
  const startSession = useCallback((indexId: string): void => {
    sessionRef.current = newSession(indexId);
    setTurns([]);
  }, []);

  useEffect(() => {
    if (!hasExtension) return;
    void loadIndexes().then(({ options, activeId: id }) => {
      setIndexes(options);
      setActiveId(id);
    });
  }, []);

  // Starter questions come from the active index's own headings (PRD 5.9.7);
  // history and the running session are scoped to the same index.
  useEffect(() => {
    if (!hasExtension || !activeId) return;
    void starterQuestions(activeId).then(setStarters);
    void refreshHistory(activeId);
    if (sessionRef.current?.indexId !== activeId) startSession(activeId);
    /**
     * Start loading the embedder and the index while the user is still reading
     * the page. Neither depends on the question, and both are slow enough to
     * dominate the first answer's latency — the weights are 33 MB and a cold
     * session is 350–1000 ms at 15k chunks. Also runs on a site switch, which
     * is exactly when the next index is cold.
     */
    warmIndex(activeId);
  }, [activeId, refreshHistory, startSession]);

  // The keyboard shortcut opens the panel and focuses the question box (5.9.2).
  useEffect(() => {
    inputRef.current?.focus();
    if (!hasExtension) return;
    const listener = (msg: unknown): void => {
      if ((msg as { type?: string })?.type === "panel/open") inputRef.current?.focus();
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const scrollToEnd = useCallback((): void => {
    requestAnimationFrame(() => bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight }));
  }, []);

  /**
   * Switching sites ends the conversation — its context no longer applies
   * (5.9.3). It stays in history under the index it was asked against.
   */
  const switchIndex = async (id: string): Promise<void> => {
    setSwitcherOpen(false);
    setHistoryOpen(false);
    if (id === activeId) return;
    await setActiveIndex(id);
    setActiveId(id);
    startSession(id);
  };

  const openHistoryEntry = async (id: string): Promise<void> => {
    const session = await loadSession(id);
    if (!session) return;
    // Re-render the stored markdown through the panel's own renderer.
    const restored = toTurns(session).map((t) =>
      t.answer.kind === "answer"
        ? {
            ...t,
            answer: {
              ...t.answer,
              html: renderMarkdown(t.answer.markdown, t.answer.sources.length),
            },
          }
        : t,
    );
    sessionRef.current = {
      id: session.id,
      indexId: session.indexId,
      createdAt: session.createdAt,
    };
    setTurns(restored);
    setHistoryOpen(false);
    scrollToEnd();
  };

  const removeHistoryEntry = async (id: string): Promise<void> => {
    await deleteSession(id);
    if (sessionRef.current?.id === id && activeId) startSession(activeId);
    if (activeId) await refreshHistory(activeId);
  };

  const clearAllHistory = async (): Promise<void> => {
    if (!activeId) return;
    if (!confirm("Delete every saved conversation for this site?")) return;
    await clearHistory(activeId);
    startSession(activeId);
    await refreshHistory(activeId);
  };

  /**
   * Ask a question.
   *
   * `focusUrl` is set when the question came from a refinement chip: the user
   * has named an exact page, and searching for its *title* instead would throw
   * that away and re-run the very query most likely to scatter again. The label
   * is still what appears in the conversation — only the retrieval is scoped.
   */
  const submit = (question: string = draft, focusUrl?: string, pickedFor?: string): void => {
    const asked = question.trim();
    if (asked === "") return;
    const id = `t-${turns.length}-${asked.length}`;
    setDraft("");

    if (!hasExtension || !activeId) {
      setTurns((prev) => [
        ...prev,
        {
          id,
          question: asked,
          // Nothing was searched, so nothing can be said about scores.
          answer: { kind: "refusal", nearest: [], reason: "no-index" as const },
        },
      ]);
      scrollToEnd();
      return;
    }

    const pending: Turn = {
      id,
      question: asked,
      answer: { kind: "answer", tier: "extractive", html: "", markdown: "", sources: [], pending: true },
    };
    setTurns((prev) => [...prev, pending]);
    scrollToEnd();

    const textRef = { text: "" };
    // Most recent first, and only questions — the resolver carries a subject
    // forward, never an answer.
    const recentQuestions = [...turns].reverse().map((t) => t.question);

    askQuery(activeId, asked, (event) => {
      setTurns((prev) => {
        const next = prev.map((t) => {
          if (t.id !== id) return t;
          const folded = applyEvent(t, event, textRef);
          if (event.kind === "done" && folded.answer.kind === "answer") {
            return { ...folded, answer: { ...folded.answer, pending: false } };
          }
          return folded;
        });

        // Save once the answer has settled, so history never holds a
        // half-streamed turn (PRD 5.9.9).
        if (event.kind === "done" && sessionRef.current) {
          const session = sessionRef.current;
          void saveSession(session, next).then(() => refreshHistory(session.indexId));
        }
        return next;
      });
      if (event.kind !== "done") scrollToEnd();
    }, recentQuestions, focusUrl, pickedFor);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const stale = active ? isStale(active.lastIndexedAt) : false;

  return (
    <div className="panel" role="region" aria-label="Sherpa side panel">
      <div className="panel-head">
        <div className="brand">
          <BrandMark />
          <span className="brand-name">Sherpa</span>
        </div>
        <div className="row gap-2">
          {active && (
            <div className="switcher-wrap">
              <button
                className="site-switch"
                type="button"
                aria-label="Switch indexed site"
                aria-expanded={switcherOpen}
                onClick={() => setSwitcherOpen((v) => !v)}
              >
                <span className={stale ? "dot dot-amber" : "dot dot-green"} />
                {active.label}
                <svg className="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {switcherOpen && (
                <ul className="switcher-menu" role="listbox" aria-label="Indexed sites">
                  {indexes.map((option) => (
                    <li key={option.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={option.id === activeId}
                        onClick={() => void switchIndex(option.id)}
                      >
                        <span>{option.label}</span>
                        <span className="meta mono">{option.host}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <button
            className="btn-icon"
            type="button"
            aria-label="Recent conversations"
            aria-expanded={historyOpen}
            onClick={() => {
              setSwitcherOpen(false);
              setHistoryOpen((v) => !v);
              if (activeId) void refreshHistory(activeId);
            }}
          >
            <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          </button>
          <button
            className="btn-icon"
            type="button"
            aria-label="New conversation"
            onClick={() => {
              setHistoryOpen(false);
              if (activeId) startSession(activeId);
              else setTurns([]);
            }}
          >
            <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button
            className="btn-icon"
            type="button"
            aria-label="Settings and indexes"
            title="Settings, indexes and crawl setup"
            onClick={() => openOptions()}
          >
            <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </div>

      {active && active.pageCount === 0 ? (
        <div className="panel-freshness">
          <span className="dot dot-amber" />
          <span>This index is empty — nothing has been crawled into it yet.</span>
          <button className="link-btn" type="button" onClick={() => openOptions()}>
            Crawl it
          </button>
        </div>
      ) : active?.needsRebuild ? (
        <div className="panel-freshness">
          <span className="dot dot-amber" />
          <span>
            This index was built with an older embedding model, so search would be unreliable.
          </span>
          <button className="link-btn" type="button" onClick={() => requestFullRecrawl(active.id)}>
            Rebuild
          </button>
        </div>
      ) : active ? (
        <div className="panel-freshness">
          <span className={stale ? "dot dot-amber" : "dot dot-green"} />
          <span>
            {freshnessLabel(active.lastIndexedAt)} · <span className="mono">{active.host}</span> ·{" "}
            {active.pageCount.toLocaleString()} pages
          </span>
          {stale && (
            <button className="link-btn" type="button" onClick={() => requestRefresh(active.id)}>
              Refresh
            </button>
          )}
        </div>
      ) : (
        hasExtension && (
          <div className="panel-freshness">
            <span className="dot dot-amber" />
            <span>No index yet</span>
          </div>
        )
      )}

      {historyOpen && (
        <HistoryPanel
          entries={history}
          activeId={sessionRef.current?.id ?? null}
          onOpen={(id) => void openHistoryEntry(id)}
          onDelete={(id) => void removeHistoryEntry(id)}
          onClear={() => void clearAllHistory()}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      <div className="panel-body" ref={bodyRef}>
        {turns.length === 0 ? (
          <EmptyState site={active} starters={starters} onPick={submit} />
        ) : (
          turns.map((t) => (
            <TurnView
              key={t.id}
              turn={t}
              indexId={activeId}
              // Three things, and each matters. The label becomes the visible
              // question so the conversation reads naturally; the URL scopes
              // the search to the page the user chose, which is what stops the
              // old ask-again loop; and the *original* question is what the
              // pick gets learned against, since binding a page title to its
              // own page teaches nothing (prior.ts).
              onPick={(option) => submit(option.label, option.url, t.question)}
            />
          ))
        )}
      </div>

      <div className="panel-footer">
        <div className="composer">
          <textarea
            ref={inputRef}
            rows={1}
            placeholder={active ? `Ask about ${active.label}…` : "Index a site to start asking…"}
            aria-label="Ask a question"
            value={draft}
            disabled={hasExtension && !activeId}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button
            className="composer-send"
            type="button"
            aria-label="Send question"
            onClick={() => submit()}
          >
            <svg className="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true">
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
          </button>
        </div>
        <div className="composer-hint">
          {/*
            The privacy claim and the proof of it, side by side. "Grounded in
            your indexed pages only" is the product's central promise, and until
            now there was nowhere in the panel to go and check it.
          */}
          <span>
            Grounded in your indexed pages only · <a href={docUrl("help")}>Help</a> ·{" "}
            <a href={docUrl("privacy")}>Privacy</a>
          </span>
          <span>
            <kbd>Enter</kbd> to send · <kbd>⇧</kbd>
            <kbd>Enter</kbd> newline
          </span>
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  site,
  starters,
  onPick,
}: {
  site: IndexOption | null;
  starters: readonly string[];
  onPick: (q: string) => void;
}): JSX.Element {
  if (!site) {
    return (
      <div className="empty">
        <BrandMark className="empty-mark" />
        <h3>No index yet</h3>
        <p>Crawl a help site to get started. Everything stays on this device.</p>
        <button className="btn btn-primary" type="button" onClick={() => openOptions()}>
          Set up an index
        </button>
      </div>
    );
  }

  // An index that exists but holds nothing — usually a re-crawl that was
  // cleared and then couldn't run, e.g. blocked at a sign-in page.
  if (site.pageCount === 0) {
    return (
      <div className="empty">
        <BrandMark className="empty-mark" />
        <h3>{site.label} has no pages</h3>
        <p>
          The index is registered but empty. If a re-crawl was interrupted — by a sign-in prompt,
          for instance — start it again from setup.
        </p>
        <button className="btn btn-primary" type="button" onClick={() => openOptions()}>
          Open crawl setup
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="empty">
        <BrandMark className="empty-mark" />
        <h3>Ask {site.label}</h3>
        <p>
          Answers come only from the {site.pageCount.toLocaleString()} pages Sherpa has indexed, with
          a citation on every reply.
        </p>
      </div>
      {starters.length > 0 && (
        <>
          <div className="eyebrow" style={{ margin: "24px 0 12px" }}>
            Try one of these
          </div>
          {starters.map((s) => (
            <button key={s} className="starter" type="button" onClick={() => onPick(s)}>
              <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              {s}
            </button>
          ))}
        </>
      )}
    </>
  );
}
