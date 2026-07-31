import { useCallback, useEffect, useRef, useState } from "react";
import type { Turn, SourceView } from "./types.js";
import type { PanelEvent } from "@/shared/answer.js";
import { SEED_TURNS } from "./seed.js";
import { BrandMark, TurnView } from "./components.js";
import { renderMarkdown } from "./markdown.js";
import { askQuery, hasExtension, requestRefresh } from "./client.js";
import {
  loadIndexes,
  setActiveIndex,
  starterQuestions,
  freshnessLabel,
  isStale,
  type IndexOption,
} from "./indexInfo.js";

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
      },
    };
  }
  if (event.kind === "delta" && turn.answer.kind === "answer") {
    textRef.text += event.delta;
    return {
      ...turn,
      answer: { ...turn.answer, markdown: textRef.text, html: renderMarkdown(textRef.text) },
    };
  }
  if (event.kind === "refusal") {
    return { ...turn, answer: { kind: "refusal", nearest: event.nearest as SourceView[] } };
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
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const active = indexes.find((i) => i.id === activeId) ?? null;

  useEffect(() => {
    if (!hasExtension) return;
    void loadIndexes().then(({ options, activeId: id }) => {
      setIndexes(options);
      setActiveId(id);
    });
  }, []);

  // Starter questions come from the active index's own headings (PRD 5.9.7).
  useEffect(() => {
    if (!hasExtension || !activeId) return;
    void starterQuestions(activeId).then(setStarters);
  }, [activeId]);

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

  /** Switching sites clears the conversation — its context no longer applies (5.9.3). */
  const switchIndex = async (id: string): Promise<void> => {
    setSwitcherOpen(false);
    if (id === activeId) return;
    await setActiveIndex(id);
    setActiveId(id);
    setTurns([]);
  };

  const submit = (question: string = draft): void => {
    const asked = question.trim();
    if (asked === "") return;
    const id = `t-${turns.length}-${asked.length}`;
    setDraft("");

    if (!hasExtension || !activeId) {
      setTurns((prev) => [
        ...prev,
        { id, question: asked, answer: { kind: "refusal", nearest: [] } },
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
    askQuery(activeId, asked, (event) => {
      setTurns((prev) =>
        prev.map((t) => {
          if (t.id !== id) return t;
          const next = applyEvent(t, event, textRef);
          if (event.kind === "done" && next.answer.kind === "answer") {
            return { ...next, answer: { ...next.answer, pending: false } };
          }
          return next;
        }),
      );
      if (event.kind !== "done") scrollToEnd();
    });
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
            aria-label="New conversation"
            onClick={() => setTurns([])}
          >
            <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
      </div>

      {active ? (
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

      <div className="panel-body" ref={bodyRef}>
        {turns.length === 0 ? (
          <EmptyState site={active} starters={starters} onPick={submit} />
        ) : (
          turns.map((t) => <TurnView key={t.id} turn={t} indexId={activeId} />)
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
          <span>Grounded in your indexed pages only</span>
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
        <p>
          Open <strong>Options → Set up an index</strong> to crawl a help site. Everything stays on
          this device.
        </p>
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
