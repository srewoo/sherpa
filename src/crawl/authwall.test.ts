import { describe, it, expect } from "vitest";
import { isLoginShell, detectAuthWall } from "./authwall.js";
import type { FetchResult } from "@/domain/crawl.js";

const base = { url: "https://h/p", finalUrl: "https://h/p", etag: undefined, lastmod: undefined };
const res = (over: Partial<FetchResult>): FetchResult => ({ ...base, status: 200, html: null, ...over });

/**
 * The exact shape help.mindtickle.com returns for an unauthenticated request:
 * HTTP 200, a couple of KB, and a script that navigates to /login. Nothing in
 * the status line or the final URL reveals it.
 */
const FRESHDESK_SHELL = `<!DOCTYPE html>
<html dir="ltr" lang="en-US">
<head>
  <script nonce="uTyhrqba">
    var url = window.location.origin + "/login?isHelpDeskLogin=true";
    window.location.href = url;
  </script>
  <title>Sign In | Mindtickle</title>
</head>
<body><div class="fullPageloadingScreen"></div></body>
</html>`;

describe("isLoginShell", () => {
  it("catches a client-side redirect built from window.location.origin", () => {
    expect(isLoginShell(FRESHDESK_SHELL)).toBe(true);
  });

  it("catches a direct location assignment", () => {
    expect(isLoginShell('<script>window.location.href = "/signin";</script>')).toBe(true);
    expect(isLoginShell('<script>location.replace("/account/login")</script>')).toBe(true);
  });

  it("catches a meta refresh to a login page", () => {
    expect(
      isLoginShell('<meta http-equiv="refresh" content="0; url=/login?next=/docs">'),
    ).toBe(true);
  });

  it("catches a tiny page that calls itself a sign-in page", () => {
    expect(isLoginShell("<html><head><title>Log in — Acme</title></head><body></body></html>")).toBe(
      true,
    );
  });

  it("does not flag a real article about signing in", () => {
    // Long, substantive page whose title mentions login — must not be a wall.
    const article = `<html><head><title>How to log in with SSO</title></head><body>${"Detailed instructions about signing in. ".repeat(400)}</body></html>`;
    expect(article.length).toBeGreaterThan(6000);
    expect(isLoginShell(article)).toBe(false);
  });

  it("does not flag a page that merely links to /login", () => {
    expect(isLoginShell('<html><body><a href="/login">Sign in</a> and read on.</body></html>')).toBe(
      false,
    );
  });

  it("ignores empty and oversized bodies", () => {
    expect(isLoginShell(null)).toBe(false);
    expect(isLoginShell("")).toBe(false);
    expect(isLoginShell(`<script>window.location="/login"</script>${"x".repeat(25_000)}`)).toBe(false);
  });
});

describe("detectAuthWall", () => {
  it("treats a 200 login shell as a session wall", () => {
    const wall = detectAuthWall(res({ status: 200, html: FRESHDESK_SHELL }), "help.mindtickle.com");
    expect(wall).toEqual({ host: "h", kind: "session" });
  });

  it("still distinguishes basic from session", () => {
    expect(detectAuthWall(res({ status: 401 }), "h")?.kind).toBe("basic");
    expect(detectAuthWall(res({ status: 403 }), "h")?.kind).toBe("session");
  });

  it("leaves a normal content page alone", () => {
    const html = `<html><head><title>Bulk import</title></head><body>${"Real content. ".repeat(500)}</body></html>`;
    expect(detectAuthWall(res({ status: 200, html }), "h")).toBeNull();
  });
});
