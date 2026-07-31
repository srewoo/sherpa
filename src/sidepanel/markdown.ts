/**
 * Minimal, safe markdown → HTML for streamed answers (PRD 5.8.10).
 *
 * The generators emit markdown: numbered steps, fenced code, bold labels and
 * `[n]` citation markers. Rendering it as plain text lost the procedural
 * structure the PRD requires us to preserve, so we render a deliberately small
 * subset.
 *
 * Security: the input is model output, which is untrusted. Everything is
 * HTML-escaped *first* and only our own tags are introduced afterwards, so
 * there is no path from model text to live markup.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** Inline: code spans, bold, italics, then citation markers. */
function inline(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    // [1] → a citation chip the panel can scroll to its source card.
    .replace(/\[(\d{1,2})\]/g, '<a class="cite" href="#source-$1" data-cite="$1">$1</a>');
}

interface ListState {
  open: "ol" | "ul" | null;
}

function closeList(out: string[], state: ListState): void {
  if (state.open) {
    out.push(`</${state.open}>`);
    state.open = null;
  }
}

/**
 * Render a markdown subset: fenced code, ordered/unordered lists, paragraphs.
 * Called on every stream tick, so it stays a single linear pass.
 */
export function renderMarkdown(markdown: string): string {
  const lines = escapeHtml(markdown).split("\n");
  const out: string[] = [];
  const state: ListState = { open: null };

  let inCode = false;
  let code: string[] = [];

  for (const line of lines) {
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      if (inCode) {
        out.push(`<pre><code>${code.join("\n")}</code></pre>`);
        code = [];
        inCode = false;
      } else {
        closeList(out, state);
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }

    if (line.trim() === "") {
      closeList(out, state);
      continue;
    }

    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ordered) {
      if (state.open !== "ol") {
        closeList(out, state);
        out.push("<ol>");
        state.open = "ol";
      }
      out.push(`<li>${inline(ordered[1] ?? "")}</li>`);
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (state.open !== "ul") {
        closeList(out, state);
        out.push("<ul>");
        state.open = "ul";
      }
      out.push(`<li>${inline(bullet[1] ?? "")}</li>`);
      continue;
    }

    closeList(out, state);
    out.push(`<p>${inline(line)}</p>`);
  }

  // An unterminated fence mid-stream still shows the code it has so far.
  if (inCode && code.length > 0) out.push(`<pre><code>${code.join("\n")}</code></pre>`);
  closeList(out, state);

  return out.join("");
}

/** Strip our rendering back to plain markdown for the clipboard (PRD 5.9.6). */
export function htmlToText(html: string): string {
  return html
    .replace(/<\/(p|li|ol|ul|pre)>/gi, "\n")
    .replace(/<li>/gi, "- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
