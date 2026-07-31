/**
 * Seed discovery (PRD 5.1.2/5.1.3). Reads robots.txt (for rules + Sitemap
 * directives), then the sitemap(s) — following a sitemap index one level — to
 * produce the initial frontier. Falls back to /sitemap.xml, and the caller
 * falls back to BFS-from-root when this yields nothing. `fetchText` is injected
 * so this is testable without a network.
 */

import { parseRobots, type Robots } from "@/lib/robots.js";
import { parseSitemap } from "./sitemap.js";

export type TextFetcher = (url: string) => Promise<string>;

export interface Discovery {
  readonly urls: readonly string[];
  readonly robots: Robots;
}

async function safe(fetchText: TextFetcher, url: string): Promise<string> {
  try {
    return await fetchText(url);
  } catch {
    return "";
  }
}

export async function discoverSeeds(
  root: string,
  sitemapUrl: string | undefined,
  fetchText: TextFetcher,
): Promise<Discovery> {
  const robots = parseRobots(await safe(fetchText, new URL("/robots.txt", root).toString()));

  const sitemaps = sitemapUrl
    ? [sitemapUrl]
    : robots.sitemaps.length > 0
      ? [...robots.sitemaps]
      : [new URL("/sitemap.xml", root).toString()];

  const urls = new Set<string>();
  for (const sm of sitemaps) {
    const parsed = parseSitemap(await safe(fetchText, sm));
    if (parsed.isIndex) {
      for (const child of parsed.sitemaps) {
        parseSitemap(await safe(fetchText, child)).urls.forEach((u) => urls.add(u));
      }
    } else {
      parsed.urls.forEach((u) => urls.add(u));
    }
  }
  return { urls: [...urls], robots };
}
