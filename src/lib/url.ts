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

  /**
   * Upgrade a same-host `http://` link found on an `https://` page.
   *
   * Help centres are full of legacy absolute links written before the site
   * moved to TLS, and every one of them costs a redirect and — because scope is
   * scheme-blind — forks the page's identity, so the same article is fetched
   * and hashed twice. Following the page we found it on is the conservative
   * read: the server has already told us it serves this host over TLS.
   *
   * Restricted to the default port so an explicit `:80` is left alone.
   */
  if (u.protocol === "http:" && u.port === "" && base) {
    try {
      const b = new URL(base);
      if (b.protocol === "https:" && b.hostname === u.hostname) u.protocol = "https:";
    } catch {
      // An unparseable base only means we can't make this judgement.
    }
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

/**
 * True when two URLs sit in the same documentation section — same host, and
 * sharing at least the first two path segments.
 *
 * Backs the page-context boost: a question asked while reading
 * `/support/solutions/articles/asset-hub-x` should favour other Asset Hub
 * pages. Two segments is the useful granularity on help sites, where the first
 * is usually a constant like `/support` or `/docs`.
 */
export function sameSection(candidate: string, current: string): boolean {
  let a: URL;
  let b: URL;
  try {
    a = new URL(candidate);
    b = new URL(current);
  } catch {
    return false;
  }
  if (a.hostname !== b.hostname) return false;

  const segments = (u: URL): string[] => u.pathname.split("/").filter(Boolean);
  const left = segments(a);
  const right = segments(b);
  if (left.length === 0 || right.length === 0) return false;

  const depth = Math.min(2, left.length, right.length);
  for (let i = 0; i < depth; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
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
 * The path prefix a crawl root confines the crawl to.
 *
 * A root of `/help` admits `/help/anything`, which is the scoping the PRD asks
 * for (5.1.1) — but it means a root pointing at a *page* rather than a section,
 * like `/support/home`, admits almost nothing, because the site's articles are
 * siblings rather than children. We don't silently widen the scope; we surface
 * this string in the crawl preview so the user can see what they've chosen.
 */
export function scopePrefix(root: string): string {
  try {
    const u = new URL(root);
    return u.pathname.endsWith("/") ? u.pathname : `${u.pathname}/`;
  } catch {
    return "/";
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
