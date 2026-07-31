/**
 * Real network implementations for the crawl, used only inside the offscreen
 * document. `credentials: "include"` sends the user's session cookies, which is
 * what lets Sherpa crawl authenticated/internal help centres (PRD 5.2.8).
 * Not unit-tested here — they wrap browser fetch/DOMParser.
 */

import type { Fetcher, LinkExtractor } from "@/domain/crawl.js";

export const browserFetch: Fetcher = async (url) => {
  try {
    const res = await fetch(url, { credentials: "include", redirect: "follow" });
    const contentType = res.headers.get("content-type") ?? "";
    const isHtml = contentType.includes("text/html") || contentType.includes("xhtml");
    return {
      url,
      finalUrl: res.url || url,
      status: res.status,
      html: isHtml ? await res.text() : null,
      etag: res.headers.get("etag") ?? undefined,
      lastmod: res.headers.get("last-modified") ?? undefined,
    };
  } catch {
    // Network error / blocked host → status 0, treated as a failure by the engine.
    return { url, finalUrl: url, status: 0, html: null, etag: undefined, lastmod: undefined };
  }
};

/** Plain-text fetch for robots.txt and sitemaps. */
export const fetchText = async (url: string): Promise<string> => {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
};

export const domLinks: LinkExtractor = (html, base) => {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out: string[] = [];
  doc.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href");
    if (!href) return;
    try {
      out.push(new URL(href, base).toString());
    } catch {
      /* skip unparseable href */
    }
  });
  return out;
};
