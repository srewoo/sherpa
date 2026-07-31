import { describe, it, expect } from "vitest";
import { canonicalizeUrl, dedupeKey, sameHost, underRoot } from "./url.js";

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
