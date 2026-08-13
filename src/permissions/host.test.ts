import { describe, it, expect } from "vitest";
import {
  originPatterns,
  providerOrigin,
  hasProviderPermission,
  PROVIDER_ORIGINS,
} from "./host.js";

const BOTH = ["http://help.acme.test/*", "https://help.acme.test/*"];

describe("originPatterns", () => {
  /**
   * The regression this guards: scope (`underRoot`) ignores the scheme, so an
   * `http://` link on an `https://` site is crawled. A pattern pinned to the
   * root's scheme leaves that fetch unprivileged, and an unprivileged extension
   * fetch is blocked by CORS before the redirect to https can happen.
   */
  it("covers both schemes for the host", () => {
    expect(originPatterns("https://help.acme.test/")).toEqual(BOTH);
    expect(originPatterns("http://help.acme.test/")).toEqual(BOTH);
  });

  /**
   * The regression that shipped: a single scheme-wildcard pattern was rejected
   * at runtime with "Only permissions specified in the manifest may be
   * requested". Chrome asks whether one *single* declared
   * `optional_host_permissions` pattern contains the request, and the manifest
   * declares the http and https wildcards as two separate entries — so a `*`
   * scheme is inside neither. Every emitted pattern must name a concrete scheme.
   */
  it("never emits a wildcard scheme, which no single declaration can cover", () => {
    for (const pattern of originPatterns("https://help.acme.test/")) {
      expect(pattern.startsWith("*://")).toBe(false);
      expect(/^https?:\/\//.test(pattern)).toBe(true);
    }
  });

  it("asks for the whole host, not just the crawl path", () => {
    // Redirects and sibling articles routinely land outside the root's path;
    // a path-scoped grant would break them.
    expect(originPatterns("https://help.acme.test/support/solutions/")).toEqual(BOTH);
  });

  it("never widens beyond the one host", () => {
    for (const pattern of originPatterns("https://help.acme.test/")) {
      expect(pattern).not.toContain("*.acme.test");
      expect(pattern).not.toContain("<all_urls>");
      expect(pattern).toContain("//help.acme.test/");
    }
  });

  it("drops the port, which match patterns do not accept", () => {
    expect(originPatterns("https://help.acme.test:8443/docs")).toEqual(BOTH);
  });

  it("lowercases the host the way a match pattern requires", () => {
    expect(originPatterns("https://HELP.Acme.TEST/")).toEqual(BOTH);
  });
});

describe("provider API permissions", () => {
  /**
   * BYOK needs a host permission for the same reason a crawl does: an extension
   * fetch to an origin it has no grant for is a plain cross-origin request, and
   * OpenAI sends no permissive CORS headers to browser origins. Without this the
   * request fails before the key is used, and the only signal is "Failed to
   * fetch" — which reads as a bad key, or as nothing at all.
   */
  it("maps every provider to its API origin", () => {
    expect(providerOrigin("openai")).toBe("https://api.openai.com/*");
    expect(providerOrigin("anthropic")).toBe("https://api.anthropic.com/*");
    expect(providerOrigin("gemini")).toBe("https://generativelanguage.googleapis.com/*");
  });

  it("has no origin for an unknown provider", () => {
    expect(providerOrigin("nope")).toBeUndefined();
  });

  /**
   * Each pattern must sit inside a single `optional_host_permissions` entry, or
   * `permissions.request` rejects the whole call — the trap `originPatterns`
   * documents. The manifest declares an https wildcard, so an explicit https
   * origin is contained; a scheme wildcard would not be.
   */
  it("requests https origins, which the manifest's https wildcard contains", () => {
    for (const origin of Object.values(PROVIDER_ORIGINS)) {
      expect(origin.startsWith("https://")).toBe(true);
      expect(origin.endsWith("/*")).toBe(true);
    }
  });

  it("never claims a grant it could not check", async () => {
    const original = globalThis.chrome;
    // @ts-expect-error — deliberately removing the API to model a restricted context.
    globalThis.chrome = {};
    await expect(hasProviderPermission("openai")).resolves.toBe(false);
    globalThis.chrome = original;
  });
});
