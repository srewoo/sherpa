/**
 * URLs a crawler must never request, regardless of scope or robots.txt.
 *
 * This is not an optimisation, it's a safety rail. A crawler that follows a
 * logout link performs the logout: the user's session is destroyed mid-crawl,
 * every subsequent page redirects to a sign-in screen, and the crawl collapses
 * — having also signed the user out of a site they were using. That happened on
 * a real help centre, where `/logout` sat outside robots.txt's disallow list
 * and was linked from every page.
 *
 * robots.txt cannot be relied on for this. Plenty of sites never think to
 * disallow their own logout, and a `Disallow` we happen to honour is luck
 * rather than protection.
 */

/**
 * Session-ending actions, matched as *whole path segments*.
 *
 * Substring matching is too blunt here: `/articles/how-to-log-out-safely` is an
 * ordinary help article and must still be indexed, while `/log-out` must not be
 * requested. Comparing normalised segments distinguishes the two, which a
 * regex over the whole path cannot.
 */
const DESTRUCTIVE_SEGMENTS = new Set([
  "logout",
  "signout",
  "signoff",
  "endsession",
  "destroysession",
  "unsubscribe",
  "deactivate",
  "revoke",
]);

/**
 * Adjacent segment pairs that are destructive together but innocuous apart.
 * `destroy` alone is not listed: `/api/users/delete`-style API reference pages
 * are real documentation, and blocking them would lose content.
 */
const DESTRUCTIVE_PAIRS = new Set([
  "sessiondestroy",
  "sessionsdestroy",
  "accountdelete",
  "accountclose",
]);

/** Values of an action-style query parameter that perform something. */
const DESTRUCTIVE_ACTIONS = new Set([
  "logout",
  "signout",
  "delete",
  "remove",
  "destroy",
  "reset",
  "unsubscribe",
]);

/** "sign_out" / "log-out" / "Log Out" all normalise to one token. */
function normaliseSegment(segment: string): string {
  return segment.toLowerCase().replace(/[\s_-]+/g, "");
}

/**
 * Binary and attachment URLs. Fetching these costs a full download and yields
 * nothing indexable — the extractor needs HTML. Freshdesk's
 * `/helpdesk/attachments/…` redirects to a signed S3 URL on another origin,
 * which then fails CORS and books a spurious failure.
 */
const BINARY_EXTENSION =
  /\.(pdf|zip|gz|tar|rar|7z|csv|tsv|xlsx?|docx?|pptx?|odt|ods|png|jpe?g|gif|svg|webp|ico|bmp|tiff?|mp[34]|m4[av]|mov|avi|wmv|webm|wav|ogg|woff2?|ttf|eot|exe|dmg|pkg|apk|bin|iso)(\?|#|$)/i;

const ATTACHMENT_PATH = /\/(attachments?|downloads?|uploads?|files?)\/[^/]*\d/i;

/** True when requesting this URL could change state on the user's behalf. */
export function isDestructiveUrl(url: string): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  const segments = target.pathname.split("/").filter(Boolean).map(normaliseSegment);
  for (const segment of segments) {
    if (DESTRUCTIVE_SEGMENTS.has(segment)) return true;
  }
  for (let i = 0; i + 1 < segments.length; i++) {
    if (DESTRUCTIVE_PAIRS.has(`${segments[i]}${segments[i + 1]}`)) return true;
  }
  // `?action=logout`, `?do=delete` — a GET that isn't one.
  for (const [key, value] of target.searchParams) {
    if (!/^(action|do|cmd|op|method)$/i.test(key)) continue;
    if (DESTRUCTIVE_ACTIONS.has(normaliseSegment(value))) return true;
  }
  return false;
}

/** True when the URL is a binary asset rather than an indexable page. */
export function isBinaryAsset(url: string): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  return BINARY_EXTENSION.test(target.pathname) || ATTACHMENT_PATH.test(target.pathname);
}

/**
 * The single check the crawler applies before enqueueing or fetching anything.
 * Deliberately independent of the user's include/exclude patterns: nobody
 * should have to know to exclude their own logout URL.
 */
export function isUnsafeToFetch(url: string): boolean {
  return isDestructiveUrl(url) || isBinaryAsset(url);
}
