/**
 * URL canonicalisation and dedupe helpers (PRD 5.2.6).
 *
 * Help sites serve the same page under many URLs: tracking params, trailing
 * slashes, fragments, mixed case hosts. We normalise to a single canonical
 * form so the frontier and the content index never double-count a page.
 */

/** Query params that never change page content and must be stripped. */
const TRACKING_PARAMS: readonly string[] = [
  "gclid",
  "fbclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
  "source",
  "_ga",
  "yclid",
];

const TRACKING_PREFIXES: readonly string[] = ["utm_"];

function isTrackingParam(key: string): boolean {
  const lower = key.toLowerCase();
  if (TRACKING_PARAMS.includes(lower)) return true;
  return TRACKING_PREFIXES.some((p) => lower.startsWith(p));
}

/**
 * Normalise a URL to its canonical string form. Returns `null` for anything
 * that is not an http(s) URL we are willing to crawl (mailto:, javascript:,
 * data:, unparseable input, etc.).
 *
 * @param raw   the href as found (may be relative)
 * @param base  the page the href was found on, for resolving relative links
 */
export function canonicalizeUrl(raw: string, base?: string): string | null {
  let u: URL;
  try {
    u = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  u.hostname = u.hostname.toLowerCase();
  u.hash = "";

  // Drop default ports so :443/:80 don't fork the identity.
  if (
    (u.protocol === "https:" && u.port === "443") ||
    (u.protocol === "http:" && u.port === "80")
  ) {
    u.port = "";
  }

  // Strip tracking params, then sort the survivors for a stable identity.
  const kept: [string, string][] = [];
  for (const [k, v] of u.searchParams) {
    if (!isTrackingParam(k)) kept.push([k, v]);
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = "";
  for (const [k, v] of kept) u.searchParams.append(k, v);

  // Normalise an empty path to "/", but leave real trailing slashes alone —
  // some sites route "/a/" and "/a" to genuinely different pages. We only
  // collapse the root.
  if (u.pathname === "") u.pathname = "/";

  return u.toString();
}

/**
 * A stable dedupe key. Treats "/a" and "/a/" as the same page — used for
 * content dedupe where trailing-slash variants are almost always identical.
 */
export function dedupeKey(canonical: string): string {
  const u = new URL(canonical);
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.slice(0, -1);
  }
  return u.toString();
}

/** True when `candidate` is on the same registrable host as `root`. */
export function sameHost(candidate: string, root: string): boolean {
  try {
    return new URL(candidate).hostname === new URL(root).hostname;
  } catch {
    return false;
  }
}

/**
 * True when `candidate` sits under the crawl root's path prefix. Scoping a
 * crawl to docs.example.com/help keeps it out of the marketing site sharing
 * the host.
 */
export function underRoot(candidate: string, root: string): boolean {
  let c: URL;
  let r: URL;
  try {
    c = new URL(candidate);
    r = new URL(root);
  } catch {
    return false;
  }
  if (c.hostname !== r.hostname) return false;
  const prefix = r.pathname.endsWith("/") ? r.pathname : r.pathname + "/";
  return c.pathname === r.pathname || c.pathname.startsWith(prefix);
}
