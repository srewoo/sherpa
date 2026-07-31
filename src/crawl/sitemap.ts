/**
 * Sitemap parsing (PRD 5.1.2). Handles both a urlset and a sitemapindex
 * (nested sitemaps). Regex-based rather than DOMParser so it runs in the worker
 * and in Node tests without a DOM.
 */

export interface Sitemap {
  /** True when this document points to more sitemaps rather than pages. */
  readonly isIndex: boolean;
  /** Page URLs (when !isIndex). */
  readonly urls: readonly string[];
  /** Child sitemap URLs (when isIndex). */
  readonly sitemaps: readonly string[];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const raw = m[1];
    if (raw) out.push(decodeEntities(raw.trim()));
  }
  return out;
}

export function parseSitemap(xml: string): Sitemap {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const locs = extractLocs(xml);
  return isIndex
    ? { isIndex: true, urls: [], sitemaps: locs }
    : { isIndex: false, urls: locs, sitemaps: [] };
}
