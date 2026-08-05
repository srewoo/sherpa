import { describe, it, expect } from "vitest";
import { canonicalizeUrl, dedupeKey, sameHost, underRoot , sameSection } from "./url.js";

describe("canonicalizeUrl", () => {
  it("lowercases the host and drops the fragment", () => {
    expect(canonicalizeUrl("https://Docs.Example.com/a#section")).toBe(
      "https://docs.example.com/a",
    );
  });

  it("strips utm_* and known tracking params but keeps real ones", () => {
    expect(
      canonicalizeUrl("https://x.com/p?utm_source=t&id=7&gclid=abc&q=hi"),
    ).toBe("https://x.com/p?id=7&q=hi");
  });

  it("sorts surviving query params for a stable identity", () => {
    expect(canonicalizeUrl("https://x.com/p?b=2&a=1")).toBe(
      canonicalizeUrl("https://x.com/p?a=1&b=2"),
    );
  });

  it("drops default ports", () => {
    expect(canonicalizeUrl("https://x.com:443/a")).toBe("https://x.com/a");
    expect(canonicalizeUrl("http://x.com:80/a")).toBe("http://x.com/a");
  });

  it("resolves relative hrefs against the base", () => {
    expect(canonicalizeUrl("../guide", "https://x.com/docs/intro")).toBe(
      "https://x.com/guide",
    );
  });

  it("rejects non-http protocols and junk", () => {
    expect(canonicalizeUrl("mailto:a@b.com")).toBeNull();
    expect(canonicalizeUrl("javascript:void(0)")).toBeNull();
    expect(canonicalizeUrl("not a url")).toBeNull();
  });
});

describe("dedupeKey", () => {
  it("treats trailing-slash variants as one page", () => {
    expect(dedupeKey("https://x.com/a/")).toBe(dedupeKey("https://x.com/a"));
  });
  it("never strips the root slash", () => {
    expect(dedupeKey("https://x.com/")).toBe("https://x.com/");
  });
});

describe("scope checks", () => {
  it("sameHost compares hostnames only", () => {
    expect(sameHost("https://x.com/a", "https://x.com/b")).toBe(true);
    expect(sameHost("https://y.com/a", "https://x.com/b")).toBe(false);
  });

  it("underRoot honours a path prefix", () => {
    expect(underRoot("https://x.com/help/a", "https://x.com/help")).toBe(true);
    expect(underRoot("https://x.com/help", "https://x.com/help")).toBe(true);
    expect(underRoot("https://x.com/helpdesk", "https://x.com/help")).toBe(
      false,
    );
    expect(underRoot("https://x.com/blog", "https://x.com/help")).toBe(false);
  });
});

describe("sameSection (page-context boost)", () => {
  it("matches pages sharing the first two path segments", () => {
    expect(
      sameSection(
        "https://help.acme.test/support/solutions/articles/1",
        "https://help.acme.test/support/solutions/articles/2",
      ),
    ).toBe(true);
  });

  it("rejects a different section on the same host", () => {
    expect(
      sameSection("https://help.acme.test/support/tickets/9", "https://help.acme.test/docs/api/x"),
    ).toBe(false);
  });

  it("rejects a different host", () => {
    expect(sameSection("https://other.test/support/a", "https://help.acme.test/support/a")).toBe(
      false,
    );
  });

  it("is false for a root URL, which would otherwise match everything", () => {
    expect(sameSection("https://help.acme.test/support/a", "https://help.acme.test/")).toBe(false);
  });

  it("tolerates unparseable input", () => {
    expect(sameSection("not a url", "https://help.acme.test/support/a")).toBe(false);
  });
});

describe("scheme normalisation", () => {
  const PAGE = "https://help.acme.test/docs/a";

  /**
   * Legacy absolute links on a TLS site. Left as http they cost a redirect and
   * — because scope is scheme-blind — fork the page's identity, so the same
   * article is fetched and indexed twice.
   */
  it("upgrades a same-host http link found on an https page", () => {
    expect(canonicalizeUrl("http://help.acme.test/docs/b", PAGE)).toBe(
      "https://help.acme.test/docs/b",
    );
  });

  it("gives an http link the same identity as its https twin", () => {
    expect(canonicalizeUrl("http://help.acme.test/docs/b", PAGE)).toBe(
      canonicalizeUrl("https://help.acme.test/docs/b", PAGE),
    );
  });

  it("leaves another host's http link alone", () => {
    expect(canonicalizeUrl("http://other.test/x", PAGE)).toBe("http://other.test/x");
  });

  it("leaves http alone when the page itself is http", () => {
    expect(canonicalizeUrl("http://help.acme.test/docs/b", "http://help.acme.test/docs/a")).toBe(
      "http://help.acme.test/docs/b",
    );
  });

  it("leaves an explicit port alone rather than guessing", () => {
    expect(canonicalizeUrl("http://help.acme.test:8080/x", PAGE)).toBe(
      "http://help.acme.test:8080/x",
    );
  });

  it("still upgrades when the link spelled out the default port", () => {
    expect(canonicalizeUrl("http://help.acme.test:80/x", PAGE)).toBe("https://help.acme.test/x");
  });

  it("does not upgrade without a base to judge from", () => {
    expect(canonicalizeUrl("http://help.acme.test/x")).toBe("http://help.acme.test/x");
  });
});
