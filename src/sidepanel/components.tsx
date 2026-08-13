import { useState, type MouseEvent as ReactMouseEvent } from "react";
import type { SourceView, Turn } from "./types.js";
import type { RefineOption } from "@/retrieval/refine.js";
import type { RefusalReason } from "@/generator/answerService.js";
import { tierLabel } from "./types.js";
import { htmlToText } from "./markdown.js";
import { sendFeedback } from "./client.js";

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

/**
 * Open a source in a real tab.
 *
 * A plain `target="_blank"` is unreliable from a side panel: the panel is an
 * extension page, and depending on how it was opened the navigation can be
 * swallowed, leaving a link that looks live and does nothing. `chrome.tabs`
 * is the dependable route when it exists; the href stays for middle-click,
 * copy-link, and any context where the API doesn't.
 */
function openSource(url: string) {
  return (event: ReactMouseEvent<HTMLAnchorElement>): void => {
    // Let the browser handle modified clicks — the user asked for a specific
    // window or a background tab, and we should not override that.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    if (typeof chrome === "undefined" || !chrome.tabs?.create) return;
    event.preventDefault();
    void chrome.tabs.create({ url });
  };
}

/**
 * One source, one line.
 *
 * These used to be cards carrying a breadcrumb, a snippet and the full URL.
 * In a 400px panel five of them buried the answer they were supporting, and the
 * snippet duplicated text the answer had already quoted. A citation's job here
 * is to be checkable — name the page, go to it — so the line is the title as a
 * link, with the relevance kept as the one signal the title can't convey. The
 * breadcrumb and URL move to the tooltip rather than being dropped.
 */
function SourceCard({ source }: { source: SourceView }): JSX.Element {
  return (
    // The id is the anchor target for the inline [n] citation chips.
    <li className="source-item" id={`source-${source.index}`}>
      <span className="source-idx" aria-hidden="true">
        {source.index}
      </span>
      <a
        className="source-link"
        href={source.url}
        title={`${source.breadcrumb}\n${source.displayUrl}`}
        target="_blank"
        rel="noreferrer"
        onClick={openSource(source.url)}
      >
        {source.title}
      </a>
      <span className="source-score" title={`${source.relevance}% relevant`}>
        {source.relevance}%
      </span>
    </li>
  );
}

/**
 * What to say when there is no answer — matched to why there isn't one.
 *
 * This used to be one hard-coded sentence blaming the confidence floor. It was
 * shown for *every* refusal, including the case where retrieval had cleared the
 * floor comfortably and the model was the one that declined — so the panel
 * claimed nothing scored high enough directly above three sources reading 75%.
 * The user can see both. Only one of them can be true.
 */
function refusalText(reason: RefusalReason, hasNearest: boolean): string {
  const nearest = hasNearest ? " The nearest pages are below." : "";
  switch (reason) {
    case "below-floor":
      return `I don't have that in this index. Nothing scored above the confidence floor, so I won't guess.${nearest}`;
    case "model-declined":
      // Retrieval succeeded; be specific about that, and point at the pages —
      // they are frequently the answer even when the model couldn't extract it.
      return `I found related pages but couldn't answer from them — the wording may not match how your docs put it.${
        hasNearest ? " Try these, or rephrase the question." : ""
      }`;
    case "no-index":
      return "No index is selected yet. Crawl a documentation site first, then ask again.";
    case "generator-error":
      return "The selected answering model could not produce an answer. Check its key and model in Settings, then try again.";
    case "unknown":
      return `This question wasn't answered.${nearest}`;
  }
}

/** Build a paste-ready markdown answer with numbered citations (PRD 5.9.6). */
function answerMarkdown(
  question: string,
  markdown: string,
  html: string,
  sources: readonly SourceView[],
): string {
  const body = markdown.trim() !== "" ? markdown.trim() : htmlToText(html);
  const cites = sources.map((s) => `[${s.index}] ${s.title} — ${s.url}`).join("\n");
  return `**${question}**\n\n${body}\n\nSources:\n${cites}`;
}

/** Renders one Q→A exchange, including sources or a refusal (PRD 5.9.4/5.8.8). */
export function TurnView({
  turn,
  indexId,
  onPick,
}: {
  turn: Turn;
  indexId: string | null;
  /** Called when a refinement chip is chosen; re-asks scoped to that page. */
  onPick?: (option: RefineOption) => void;
}): JSX.Element {
  const { answer } = turn;
  const [copied, setCopied] = useState(false);
  const [voted, setVoted] = useState<"up" | "down" | null>(null);

  const copy = (): void => {
    if (answer.kind !== "answer") return;
    void navigator.clipboard
      ?.writeText(answerMarkdown(turn.question, answer.markdown, answer.html, answer.sources))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
  };

  const vote = (feedback: "up" | "down"): void => {
    setVoted(feedback);
    if (indexId) void sendFeedback(indexId, turn.question, feedback);
  };

  return (
    <div className="turn" style={{ marginBottom: 8 }}>
      <div className="q-row">
        <div className="q-bubble">{turn.question}</div>
      </div>

      {answer.kind === "refusal" ? (
        <div className="answer">
          <div className="notice notice-amber" style={{ marginTop: 4 }}>
            <span>{refusalText(answer.reason, answer.nearest.length > 0)}</span>
          </div>
          {answer.detail && (
            <div className="notice notice-amber" style={{ marginTop: 4 }}>
              <span>{answer.detail}</span>
            </div>
          )}
          {answer.nearest.length > 0 && (
            <>
              <div className="sources-label">Nearest pages</div>
              <ul className="source-list">
                {answer.nearest.map((s) => (
                  <SourceCard key={s.index} source={s} />
                ))}
              </ul>
            </>
          )}
        </div>
      ) : (
        <div className="answer">
          <div className="answer-tier">
            <span className="dot dot-terra" />
            {tierLabel(answer.tier)}
          </div>
          {/*
            An honest hedge beats a confident guess. In this score band the
            match genuinely might be a near miss, and the user can judge that
            far better than a threshold can — they can see the sources.
          */}
          {answer.certainty === "uncertain" && !answer.pending && (
            <div className="notice notice-amber" style={{ marginTop: 4 }}>
              <span>
                This wasn't a strong match, so I'm not certain it's what you meant — worth checking
                the sources below.
              </span>
            </div>
          )}
          {/*
            The tier line alone reads as a statement of fact — "answered with
            Gemini Nano" — which is exactly wrong when Settings says OpenAI and
            a missing key silently sent us here. Name the gap where it shows.
          */}
          {answer.notice && (
            <div className="notice notice-amber" style={{ marginTop: 4 }}>
              <span>{answer.notice}</span>
            </div>
          )}

          {answer.html === "" && answer.pending ? (
            // Once sources are on screen the search is over and the model is
            // writing — saying "searching" then would contradict the six cards
            // sitting right below it.
            <div className="answer-body soft">
              {answer.sources.length > 0 ? "Writing the answer…" : "Searching your index…"}
            </div>
          ) : (
            <div className="answer-body" dangerouslySetInnerHTML={{ __html: answer.html }} />
          )}

          {/*
            Other readings of the question — offered, never demanded.

            This sits *below* a finished answer for a reason. Its predecessor
            appeared instead of one, and a user who didn't recognise any chip
            had nowhere to go but to re-ask; picking one re-searched the chosen
            title and produced the same three chips again. Underneath an answer
            the same information costs nothing to ignore.

            The facet question is used when a model could name what the options
            differ by ("Which platform?"); otherwise the chips are page titles
            under a neutral prompt, which is weaker but never wrong.
          */}
          {!answer.pending && answer.refine && answer.refine.options.length > 0 && (
            <div className="refine">
              <div className="refine-prompt soft">
                {answer.refine.facet?.question ?? "Not what you meant?"}
              </div>
              <ul className="option-chips">
                {(answer.refine.facet?.options ?? answer.refine.options).map((option) => (
                  <li key={option.url}>
                    <button className="chip" type="button" onClick={() => onPick?.(option)}>
                      {option.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/*
            Source cards belong *under* the answer (PRD 5.9.4). Retrieval
            resolves before the first token, so rendering them on arrival put
            six cards above an empty answer body — they read as the reply.
            Hold them until there is an answer for them to support.
          */}
          {answer.sources.length > 0 && (answer.html !== "" || !answer.pending) && (
            <>
              <div className="sources-label">Sources · {answer.sources.length}</div>
              <ul className="source-list">
                {answer.sources.map((s) => (
                  <SourceCard key={s.index} source={s} />
                ))}
              </ul>
            </>
          )}

          {!answer.pending && (
            <div className="row gap-2 mt-4">
              <button className="btn btn-sm" type="button" onClick={copy}>
                {copied ? "Copied" : "Copy answer with citations"}
              </button>
              <button
                className={voted === "up" ? "btn btn-sm" : "btn btn-sm btn-ghost"}
                type="button"
                aria-label="Good answer"
                aria-pressed={voted === "up"}
                onClick={() => vote("up")}
              >
                Helpful
              </button>
              <button
                className={voted === "down" ? "btn btn-sm" : "btn btn-sm btn-ghost"}
                type="button"
                aria-label="Poor answer"
                aria-pressed={voted === "down"}
                onClick={() => vote("down")}
              >
                Not helpful
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
