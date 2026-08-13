/**
 * Structured content extraction (PRD 5.3). Where help-site tuning pays off:
 * we keep lists, code blocks and tables intact, expand collapsed panels, strip
 * chrome (nav/aside/footer/cookie/"was this helpful"), and capture breadcrumbs
 * + heading anchors for deep-linked citations. Operates on an injected Document
 * so it runs in the offscreen doc and under linkedom in tests.
 */

import { Readability } from "@mozilla/readability";
import type { Block } from "@/domain/content.js";
import { detectPlatform, profileFor, type Platform } from "./profiles.js";

export interface ExtractedPage {
  readonly title: string;
  readonly breadcrumb: readonly string[];
  readonly canonical: string | undefined;
  readonly lastmod: string | undefined;
  readonly outline: readonly string[];
  readonly platform: Platform;
  readonly blocks: readonly Block[];
}

const JUNK = [
  "nav", "aside", "footer", "header", "script", "style", "noscript", "form",
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
  ".sidebar", ".toc", ".breadcrumb", ".breadcrumbs",
  '[class*="cookie"]', '[id*="cookie"]', '[class*="related"]',
  '[class*="helpful"]', '[class*="feedback"]', '[class*="edit-page"]',
  // Transient interface chrome. These carry text that is never on screen at
  // read time — a copy-link button's "Copied!" confirmation, a tooltip, a live
  // region — and it otherwise lands inside headings and titles.
  '[role="tooltip"]', '[role="status"]', '[role="alert"]', "[aria-live]",
  '[class*="tooltip" i]', '[class*="toast" i]', '[class*="snackbar" i]',
  '[class*="copy-link" i]', '[class*="copy-button" i]', '[class*="copied" i]',
  "[data-clipboard-text]", "[data-copy]",
];

/**
 * Trailing interface text that survives when a copy widget is part of the
 * heading element itself rather than a removable sibling.
 */
const TITLE_NOISE = /\s*(copied!?|copy link|copy|share|permalink)\s*$/i;

function cleanTitle(text: string): string {
  let out = clean(text);
  // Twice, so "Title Copy Copied!" collapses fully.
  for (let i = 0; i < 2; i++) out = out.replace(TITLE_NOISE, "").trim();
  return out;
}

function clean(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function pickRoot(doc: Document, selectors: readonly string[]): Element | null {
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    if (el) return el;
  }
  return null;
}

/** Words of visible text, used to compare candidate content roots. */
function textWeight(el: Element): number {
  const t = (el.textContent ?? "").trim();
  return t === "" ? 0 : t.split(/\s+/).length;
}

/**
 * Choose the element to extract from (PRD 5.3.1).
 *
 * Readability is the base extractor: it is far better than a selector list at
 * finding the article on an unfamiliar template. But it also rewrites the DOM
 * it returns, and we need the *original* nodes to preserve code blocks, tables
 * and list nesting (5.3.3–5.3.5), so we use it as a locator rather than a
 * renderer — parse a throwaway clone, then map its article back onto the real
 * document. A platform profile, when one matched, wins outright; it was written
 * for exactly this template. Readability's own output is the fallback when
 * neither finds anything substantial.
 */
function pickContentRoot(doc: Document, selectors: readonly string[]): Element {
  const profiled = pickRoot(doc, selectors);
  if (profiled && textWeight(profiled) > 0) return profiled;

  const article = readabilityRoot(doc);
  if (article && textWeight(article) > 0) return article;

  return profiled ?? doc.body;
}

/**
 * Run Readability over a clone and re-find the same region in the live
 * document. Returns null when Readability declines the page (very short pages,
 * link farms) or when the environment can't clone — extraction then falls back
 * to the profile selectors, which is the pre-Readability behaviour.
 */
function readabilityRoot(doc: Document): Element | null {
  try {
    const clone = doc.cloneNode(true) as Document;
    const parsed = new Readability(clone, { keepClasses: true }).parse();
    if (!parsed?.content) return null;

    // Readability wraps the article; find the id/class it kept so we can locate
    // the corresponding live node and keep its untouched markup.
    const marker = /<div[^>]*\bid=["']([^"']+)["']/i.exec(parsed.content)?.[1];
    if (marker) {
      const live = doc.getElementById(marker);
      if (live) return live;
    }
    // No usable handle: fall back to the densest of the usual article wrappers.
    const candidates = [...doc.querySelectorAll("article, main, [role='main'], .content, #content")];
    return candidates.sort((a, b) => textWeight(b) - textWeight(a))[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Containers whose hidden children are genuinely collapsed *content* — an
 * accordion, a tab panel, a disclosure — as opposed to the interface furniture
 * that also uses `hidden`/`aria-hidden`.
 */
const COLLAPSIBLE = [
  "details",
  '[role="tabpanel"]',
  '[class*="accordion" i]',
  '[class*="collapse" i]',
  '[class*="expand" i]',
  '[class*="tab-panel" i]',
  '[class*="tabpanel" i]',
  '[class*="disclosure" i]',
  '[data-accordion]',
].join(",");

/**
 * Reveal collapsed content so it's indexed too (PRD 5.3.8).
 *
 * Scoped deliberately. Un-hiding every `[hidden]`/`[aria-hidden]` node in the
 * document also reveals toast and tooltip text that is never on screen — which
 * is how "Copied!" from a copy-link button ended up glued onto article titles.
 * We only reveal what sits inside something that looks like a collapsible
 * region.
 */
function expandCollapsed(root: Element): void {
  root.querySelectorAll("details").forEach((d) => d.setAttribute("open", ""));

  const reveal = (el: Element): void => {
    el.removeAttribute("hidden");
    el.removeAttribute("aria-hidden");
  };

  for (const container of root.querySelectorAll(COLLAPSIBLE)) {
    reveal(container);
    container.querySelectorAll('[hidden], [aria-hidden="true"]').forEach(reveal);
  }
}

function stripJunk(root: Element, extra: readonly string[]): void {
  root.querySelectorAll([...JUNK, ...extra].join(",")).forEach((el) => el.remove());
}

/**
 * The breadcrumb trail (PRD 5.3.6).
 *
 * Read from `li` when the trail is a list, otherwise from `a`. Querying both
 * double-counts every crumb, because each `li` contains its own `a` — which is
 * what produced trails like "Help & Support › Help & Support › Asset Hub ›
 * Asset Hub". Consecutive repeats are dropped as a second line of defence
 * against nested markup.
 */
function breadcrumbOf(doc: Document): string[] {
  const nav =
    doc.querySelector('nav[aria-label*="readcrumb" i]') ??
    doc.querySelector('[class*="breadcrumb"]');
  if (!nav) return [];

  const items = nav.querySelectorAll("li");
  const source = items.length > 0 ? items : nav.querySelectorAll("a");

  const crumbs: string[] = [];
  for (const el of source) {
    const text = clean(el.textContent);
    if (text === "" || text === "/" || text === "›" || text === ">") continue;
    if (crumbs[crumbs.length - 1] === text) continue;
    crumbs.push(text);
  }
  return crumbs;
}

function codeBlock(pre: Element): Block {
  const code = pre.querySelector("code") ?? pre;
  const cls = code.getAttribute("class") ?? "";
  const lang = /language-(\w+)/.exec(cls)?.[1] ?? "";
  const text = (code.textContent ?? "").replace(/\s+$/, "");
  return { type: "code", text: "```" + lang + "\n" + text + "\n```" };
}

function renderList(list: Element, depth = 0): string {
  const ordered = list.tagName.toLowerCase() === "ol";
  const pad = "  ".repeat(depth);
  const lines: string[] = [];
  let n = 1;
  for (const li of [...list.children].filter((c) => c.tagName.toLowerCase() === "li")) {
    const sub = li.querySelector("ul, ol");
    const own = clean([...li.childNodes].filter((node) => !(node as Element).matches?.("ul, ol")).map((node) => node.textContent).join(" "));
    lines.push(`${pad}${ordered ? `${n}.` : "-"} ${own}`);
    if (sub) lines.push(renderList(sub, depth + 1));
    n += 1;
  }
  return lines.join("\n");
}

function tableToMarkdown(table: Element): string {
  const rows = [...table.querySelectorAll("tr")].map((tr) =>
    [...tr.querySelectorAll("th, td")].map((c) => clean(c.textContent)),
  );
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]) => "| " + Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ") + " |";
  const sep = "| " + Array.from({ length: width }, () => "---").join(" | ") + " |";
  return [line(rows[0]!), sep, ...rows.slice(1).map(line)].join("\n");
}

/** Tags whose own text the walker emits directly. */
const BLOCK_TAGS = /^(p|blockquote|figcaption|dd|dt|caption|summary)$/;

/**
 * This element's own text, ignoring text that belongs to nested blocks.
 *
 * `textContent` would swallow a child paragraph's words into the parent and
 * then emit them again when the walker reached that child, duplicating text and
 * inflating BM25 term frequencies for whichever pages happen to nest their
 * markup deeply.
 */
function ownText(node: Element): string {
  const parts: string[] = [];
  for (const child of [...node.childNodes]) {
    // Node.TEXT_NODE === 3. Element children are handled by the walker itself.
    if ((child as { nodeType?: number }).nodeType === 3) parts.push(child.textContent ?? "");
  }
  return clean(parts.join(" "));
}

/**
 * Text an image carries.
 *
 * In a help centre this is rarely decorative: alt text and captions are where
 * the UI label lives — "Record button in the toolbar", "the Share dialog" — and
 * that label is very often the exact phrase someone searches for. A screenshot
 * with its caption dropped is a step of a procedure with no words at all.
 */
function imageText(img: Element): string {
  const alt = clean(img.getAttribute("alt") ?? "");
  const title = clean(img.getAttribute("title") ?? "");
  // Alt is the accessible name; title only adds when it says something else.
  return alt && title && title !== alt ? `${alt} — ${title}` : alt || title;
}

function walk(node: Element, out: Block[]): void {
  for (const child of [...node.children]) {
    const tag = child.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      const text = cleanTitle(child.textContent ?? "");
      const anchor = child.getAttribute("id");
      if (text) out.push({ type: "heading", level: Number(tag[1]), text, ...(anchor ? { anchor } : {}) });
    } else if (tag === "pre") {
      out.push(codeBlock(child));
    } else if (tag === "ul" || tag === "ol") {
      const text = renderList(child);
      if (text.trim()) out.push({ type: "list", text });
    } else if (tag === "table") {
      const text = tableToMarkdown(child);
      if (text) out.push({ type: "table", text });
    } else if (tag === "img") {
      const text = imageText(child);
      if (text) out.push({ type: "paragraph", text });
    } else if (BLOCK_TAGS.test(tag)) {
      const text = clean(child.textContent);
      if (text) out.push({ type: "paragraph", text });
    } else {
      /**
       * Anything else: emit its own loose text, then descend.
       *
       * The descent alone used to be the whole branch, which silently dropped
       * every word not wrapped in one of the tags above. A `<div class="note">
       * You must be an admin.</div>` has no element children, so the walker
       * recursed into nothing and the sentence never reached the index — and
       * help centres put their most consequential lines in exactly those
       * callout and alert divs. Emitting `ownText` first keeps loose text while
       * `ownText`'s text-node filter keeps nested blocks from being counted
       * twice.
       */
      const own = ownText(child);
      if (own) out.push({ type: "paragraph", text: own });
      walk(child, out);
    }
  }
}

export function extractPage(doc: Document, baseUrl: string, platform?: Platform): ExtractedPage {
  const detected = platform ?? detectPlatform(doc);
  const profile = profileFor(detected);
  const title = cleanTitle(doc.querySelector("h1")?.textContent ?? "") || cleanTitle(doc.title);
  const canonicalHref = doc.querySelector('link[rel="canonical"]')?.getAttribute("href");
  const lastmod =
    doc.querySelector('meta[property="article:modified_time"]')?.getAttribute("content") ??
    doc.querySelector("time[datetime]")?.getAttribute("datetime") ??
    undefined;

  const breadcrumb = breadcrumbOf(doc);
  // Breadcrumbs come from the full document — Readability and the platform
  // profiles both strip the nav they live in.
  const root = pickContentRoot(doc, profile.rootSelectors);
  stripJunk(root, profile.junkSelectors);
  expandCollapsed(root);

  const blocks: Block[] = [];
  walk(root, blocks);
  const outline = blocks.filter((b) => b.type === "heading" && (b.level ?? 6) <= 3).map((b) => b.text);

  let canonical: string | undefined;
  try {
    canonical = canonicalHref ? new URL(canonicalHref, baseUrl).toString() : undefined;
  } catch {
    canonical = undefined;
  }
  return { title, breadcrumb, canonical, lastmod: lastmod ?? undefined, outline, platform: detected, blocks };
}
