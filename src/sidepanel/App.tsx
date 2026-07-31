import { useEffect, useRef, useState } from "react";
import type { Turn, SourceView } from "./types.js";
import type { PanelEvent } from "@/shared/answer.js";
import { SEED_TURNS } from "./seed.js";
import { BrandMark, TurnView } from "./components.js";
import { askQuery, activeIndexId, hasExtension } from "./client.js";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Fold a streamed PanelEvent into the turn it belongs to. */
function applyEvent(turn: Turn, event: PanelEvent, textRef: { text: string }): Turn {
  if (event.kind === "sources") {
    return { ...turn, answer: { kind: "answer", tier: event.tier, html: turn.answer.kind === "answer" ? turn.answer.html : "", sources: event.sources as SourceView[] } };
  }
  if (event.kind === "delta" && turn.answer.kind === "answer") {
    textRef.text += event.delta;
    return { ...turn, answer: { ...turn.answer, html: escapeHtml(textRef.text).replace(/\n/g, "<br>") } };
  }
  if (event.kind === "refusal") {
    return { ...turn, answer: { kind: "refusal", nearest: event.nearest as SourceView[] } };
  }
  return turn;
}

export function App(): JSX.Element {
  const [turns, setTurns] = useState<readonly Turn[]>(hasExtension ? [] : SEED_TURNS);
  const [draft, setDraft] = useState("");
  const indexRef = useRef("");
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void activeIndexId().then((id) => (indexRef.current = id));
  }, []);

  const scrollToEnd = (): void => {
    requestAnimationFrame(() => bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight }));
  };

  const submit = (): void => {
    const question = draft.trim();
    if (question === "") return;
    const id = `t-${turns.length}-${question.length}`;
    setDraft("");

    if (!hasExtension) {
      setTurns((prev) => [...prev, { id, question, answer: { kind: "refusal", nearest: [] } }]);
      scrollToEnd();
      return;
    }

    const pending: Turn = { id, question, answer: { kind: "answer", tier: "extractive", html: "…", sources: [] } };
    setTurns((prev) => [...prev, pending]);
    scrollToEnd();
    const textRef = { text: "" };
    askQuery(indexRef.current, question, (event) => {
      setTurns((prev) => prev.map((t) => (t.id === id ? applyEvent(t, event, textRef) : t)));
      if (event.kind !== "done") scrollToEnd();
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="panel" role="region" aria-label="Sherpa side panel">
      <div className="panel-head">
        <div className="brand">
          <BrandMark />
          <span className="brand-name">Sherpa</span>
        </div>
        <div className="row gap-2">
          <button className="site-switch" type="button" aria-label="Switch indexed site">
            <span className="dot dot-green" />
            Northwind Help
            <svg className="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <button className="btn-icon" type="button" aria-label="New conversation" onClick={() => setTurns([])}>
            <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
      </div>

      <div className="panel-freshness">
        <span className="dot dot-green" />
        <span>
          Index up to date · <span className="mono">docs.northwind.com</span> · 1,847 pages
        </span>
      </div>

      <div className="panel-body" ref={bodyRef}>
        {turns.length === 0 ? (
          <EmptyState onPick={setDraft} />
        ) : (
          turns.map((t) => <TurnView key={t.id} turn={t} />)
        )}
      </div>

      <div className="panel-footer">
        <div className="composer">
          <textarea
            rows={1}
            placeholder="Ask about the Northwind docs…"
            aria-label="Ask a question"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button className="composer-send" type="button" aria-label="Send question" onClick={submit}>
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

const STARTERS: readonly string[] = [
  "How do I configure SSO for a sandbox tenant?",
  "What triggers a webhook retry, and how many times?",
  "Why did my bulk data import fail validation?",
];

function EmptyState({ onPick }: { onPick: (q: string) => void }): JSX.Element {
  return (
    <>
      <div className="empty">
        <BrandMark className="empty-mark" />
        <h3>Ask the Northwind docs</h3>
        <p>Answers come only from the pages Sherpa has indexed, with a citation on every reply.</p>
      </div>
      <div className="eyebrow" style={{ margin: "24px 0 12px" }}>
        Try one of these
      </div>
      {STARTERS.map((s) => (
        <button key={s} className="starter" type="button" onClick={() => onPick(s)}>
          <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          {s}
        </button>
      ))}
    </>
  );
}
