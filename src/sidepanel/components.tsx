import type { SourceView, Turn } from "./types.js";
import { tierLabel } from "./types.js";

export function BrandMark({ className = "brand-mark" }: { className?: string }): JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 20 L9.5 7 L13 14 L15.5 9 L21 20 Z" />
      <path d="M8 20 L11 14.5" />
    </svg>
  );
}

function SourceCard({ source }: { source: SourceView }): JSX.Element {
  return (
    <div className="source-card">
      <div className="source-top">
        <div>
          <div className="source-title">
            <a href={source.url} target="_blank" rel="noreferrer">
              {source.title}
            </a>
          </div>
          <div className="source-crumb">{source.breadcrumb}</div>
        </div>
        <span className="source-idx">{source.index}</span>
      </div>
      <div className="source-snippet">{source.snippet}</div>
      <div className="row-between mt-3">
        <span className="relevance">
          <span className="relevance-bar">
            <span style={{ width: `${source.relevance}%` }} />
          </span>
          {source.relevance}% relevant
        </span>
        <a className="mono" href={source.url} style={{ fontSize: 11 }} target="_blank" rel="noreferrer">
          {source.displayUrl}
        </a>
      </div>
    </div>
  );
}

/** Build a paste-ready markdown answer with numbered citations (PRD 5.9.6). */
function answerMarkdown(question: string, html: string, sources: readonly SourceView[]): string {
  const body = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
  const cites = sources.map((s) => `[${s.index}] ${s.title} — ${s.url}`).join("\n");
  return `**${question}**\n\n${body}\n\nSources:\n${cites}`;
}

/** Renders one Q→A exchange, including sources or a refusal (PRD 5.9.4/5.8.8). */
export function TurnView({ turn }: { turn: Turn }): JSX.Element {
  const { answer } = turn;

  const copy = (): void => {
    if (answer.kind !== "answer") return;
    void navigator.clipboard?.writeText(answerMarkdown(turn.question, answer.html, answer.sources));
  };
  return (
    <div className="turn" style={{ marginBottom: 8 }}>
      <div className="q-row">
        <div className="q-bubble">{turn.question}</div>
      </div>

      {answer.kind === "refusal" ? (
        <div className="answer">
          <div className="notice notice-amber" style={{ marginTop: 4 }}>
            <span>
              I don't have that in this index. Nothing scored above the confidence floor, so
              I won't guess. The nearest pages are below.
            </span>
          </div>
          {answer.nearest.length > 0 && <div className="sources-label">Nearest pages</div>}
          {answer.nearest.map((s) => (
            <SourceCard key={s.index} source={s} />
          ))}
        </div>
      ) : (
        <div className="answer">
          <div className="answer-tier">
            <span className="dot dot-terra" />
            {tierLabel(answer.tier)}
          </div>
          <div className="answer-body" dangerouslySetInnerHTML={{ __html: answer.html }} />
          <div className="sources-label">Sources · {answer.sources.length}</div>
          {answer.sources.map((s) => (
            <SourceCard key={s.index} source={s} />
          ))}
          <div className="row gap-2 mt-4">
            <button className="btn btn-sm" type="button" onClick={copy}>
              Copy answer with citations
            </button>
            <button className="btn btn-sm btn-ghost" type="button" aria-label="Good answer">
              Helpful
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
