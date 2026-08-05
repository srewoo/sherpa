/**
 * Auth-wall detection (PRD 5.2.8). When a fetch is bounced by authentication we
 * pause and let the user sign in (session) or supply Basic Auth creds.
 *
 * Three shapes, because help centres use all of them:
 *  - 401 → an HTTP Basic challenge;
 *  - 403, or a server redirect landing on a login path → a session/cookie wall;
 *  - **200 carrying a login shell** → a client-side redirect. Freshdesk and most
 *    SPA help centres answer an unauthenticated request with an ordinary 200
 *    whose body is a few KB of `window.location = "/login"`. Neither the status
 *    nor the final URL gives it away, so without inspecting the body the
 *    crawler indexes the sign-in page and reports success — which is what a
 *    one-page "index" of a large help centre turns out to be.
 */

import type { AuthWall, FetchResult } from "@/domain/crawl.js";

const LOGIN_RE = /\/(login|signin|sign-in|sso|auth|account\/login|session\/new)(\/|$|\?)/i;

/** A body this small cannot be a real documentation page. */
const SHELL_MAX_BYTES = 20_000;

function hostOf(url: string, fallback: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return fallback;
  }
}

function isLoginRedirect(requested: string, final: string): boolean {
  return final !== requested && LOGIN_RE.test(final);
}

/**
 * A 200 response that is really a login page. We look for the strong signals —
 * a script navigating to a login URL, or a meta refresh to one — rather than a
 * page merely mentioning "login", so a genuine article about signing in is not
 * mistaken for a wall.
 */
export function isLoginShell(html: string | null): boolean {
  if (!html || html.length > SHELL_MAX_BYTES) return false;

  const navigatesToLogin =
    // window.location = "…/login…", location.href = "…/signin…"
    /(?:window\.)?location(?:\.href)?\s*=\s*["'][^"']*(?:login|signin|sign-in|sso)[^"']*["']/i.test(html) ||
    /location\.(?:replace|assign)\s*\(\s*["'][^"']*(?:login|signin|sign-in|sso)[^"']*["']/i.test(html) ||
    // Freshdesk builds the target first: var url = origin + "/login…"; location.href = url
    (/location\.href\s*=\s*\w+\s*;/i.test(html) && /["'][^"']*\/login[^"']*["']/i.test(html));

  const metaRefresh =
    /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]+content\s*=\s*["'][^"']*(?:login|signin|sso)[^"']*["']/i.test(
      html,
    );

  if (navigatesToLogin || metaRefresh) return true;

  // Weaker signal, trusted only on a tiny body: the page calls itself a sign-in
  // page in its title and carries no real content.
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  return html.length < 6_000 && /\b(sign[\s-]?in|log[\s-]?in)\b/i.test(title);
}

export function detectAuthWall(res: FetchResult, rootHost: string): AuthWall | null {
  if (res.status === 401) {
    return { host: hostOf(res.finalUrl, rootHost), kind: "basic" };
  }
  if (res.status === 403 || isLoginRedirect(res.url, res.finalUrl)) {
    return { host: hostOf(res.finalUrl, rootHost), kind: "session" };
  }
  // A 200 that is only a login shell is still a wall.
  if (res.status >= 200 && res.status < 300 && isLoginShell(res.html)) {
    return { host: hostOf(res.finalUrl, rootHost), kind: "session" };
  }
  return null;
}
