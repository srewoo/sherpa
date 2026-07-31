/**
 * Structured content extraction (PRD 5.3). Where help-site tuning pays off:
 * we keep lists, code blocks and tables intact, expand collapsed panels, strip
 * chrome (nav/aside/footer/cookie/"was this helpful"), and capture breadcrumbs
 * + heading anchors for deep-linked citations. Operates on an injected Document
 * so it runs in the offscreen doc and under linkedom in tests.
 */

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
];

function clean(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function pickRoot(doc: Document, selectors: readonly string[]): Element {
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    if (el) return el;
  }
  return doc.body;
}

/** Reveal collapsed content so it's indexed too (PRD 5.3.8). */
function expandCollapsed(root: Element): void {
  root.querySelectorAll("details").forEach((d) => d.setAttribute("open", ""));
  root.querySelectorAll('[hidden], [aria-hidden="true"]').forEach((el) => {
    el.removeAttribute("hidden");
    el.removeAttribute("aria-hidden");
  });
}

function stripJunk(root: Element, extra: readonly string[]): void {
  root.querySelectorAll([...JUNK, ...extra].join(",")).forEach((el) => el.remove());
}

function breadcrumbOf(doc: Document): string[] {
  const nav =
    doc.querySelector('nav[aria-label*="readcrumb" i]') ??
    doc.querySelector('[class*="breadcrumb"]');
  if (!nav) return [];
  return [...nav.querySelectorAll("a, li")]
    .map((el) => clean(el.textContent))
    .filter((t) => t.length > 0 && t !== "/");
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

function walk(node: Element, out: Block[]): void {
  for (const child of [...node.children]) {
    const tag = child.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      const text = clean(child.textContent);
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
    } else if (tag === "p" || tag === "blockquote") {
      const text = clean(child.textContent);
      if (text) out.push({ type: "paragraph", text });
    } else {
      walk(child, out);
    }
  }
}

export function extractPage(doc: Document, baseUrl: string, platform?: Platform): ExtractedPage {
  const detected = platform ?? detectPlatform(doc);
  const profile = profileFor(detected);
  const title = clean(doc.querySelector("h1")?.textContent) || clean(doc.title);
  const canonicalHref = doc.querySelector('link[rel="canonical"]')?.getAttribute("href");
  const lastmod =
    doc.querySelector('meta[property="article:modified_time"]')?.getAttribute("content") ??
    doc.querySelector("time[datetime]")?.getAttribute("datetime") ??
    undefined;

  const breadcrumb = breadcrumbOf(doc);
  const root = pickRoot(doc, profile.rootSelectors);
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
