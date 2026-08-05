import { describe, it, expect } from "vitest";
import { originPatterns } from "./host.js";

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
