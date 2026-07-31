/**
 * `noindex` detection (PRD 5.2.4). A page can opt out of indexing two ways: a
 * `<meta name="robots" content="noindex">` in the document, or an
 * `X-Robots-Tag: noindex` response header. Both must be honoured, and both are
 * per-page — unlike robots.txt, they don't stop the crawl, they only stop us
 * from indexing that one page. Links on it are still followed, matching the
 * conventional split between `noindex` and `nofollow`.
 *
 * Pure string/regex work so it runs in the offscreen doc and under Node tests.
 */

/**
 * Directive names that mean "don't index this page". `none` is shorthand for
 * `noindex, nofollow`.
 */
const NOINDEX = /(^|[\s,])(noindex|none)([\s,]|$)/i;

/**
 * True when the header opts this page out. Handles the ua-scoped form
 * (`X-Robots-Tag: googlebot: noindex`) by inspecting every comma-separated
 * directive, since we can't assume our own UA is named.
 */
export function headerSaysNoindex(headerValue: string | undefined | null): boolean {
  if (!headerValue) return false;
  return NOINDEX.test(headerValue);
}

/**
 * True when the document carries a robots meta opting out. Matches
 * `name="robots"` and the crawler-specific variants help platforms emit.
 */
export function metaSaysNoindex(html: string): boolean {
  const tags = html.match(/<meta\b[^>]*>/gi);
  if (!tags) return false;

  for (const tag of tags) {
    const name = /\bname\s*=\s*["']?([\w-]+)/i.exec(tag)?.[1]?.toLowerCase();
    if (name !== "robots" && name !== "googlebot" && name !== "sherpabot") continue;
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (content && NOINDEX.test(content)) return true;
  }
  return false;
}

/** Either signal opting the page out of the index. */
export function isNoindex(html: string | null, robotsTag: string | undefined): boolean {
  return headerSaysNoindex(robotsTag) || (html !== null && metaSaysNoindex(html));
}
