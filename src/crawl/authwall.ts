/**
 * Auth-wall detection (PRD 5.2.8). When a fetch is bounced by authentication we
 * pause and let the user sign in (session) or supply Basic Auth creds. We infer
 * the kind from the response: 401 implies an HTTP Basic challenge; 403 or a
 * redirect to a login page implies a session/cookie wall.
 */

import type { AuthWall, FetchResult } from "@/domain/crawl.js";

const LOGIN_RE = /\/(login|signin|sign-in|sso|auth|account\/login|session\/new)(\/|$|\?)/i;

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

export function detectAuthWall(res: FetchResult, rootHost: string): AuthWall | null {
  if (res.status === 401) {
    return { host: hostOf(res.finalUrl, rootHost), kind: "basic" };
  }
  if (res.status === 403 || isLoginRedirect(res.url, res.finalUrl)) {
    return { host: hostOf(res.finalUrl, rootHost), kind: "session" };
  }
  return null;
}
