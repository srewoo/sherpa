import { describe, it, expect } from "vitest";
import { parseRobots, isAllowed, crawlDelay } from "./robots.js";

const SAMPLE = `
# Northwind help centre
User-agent: *
Disallow: /admin/
Allow: /admin/public/
Crawl-delay: 2

User-agent: BadBot
Disallow: /

Sitemap: https://docs.northwind.com/sitemap.xml
`;

describe("parseRobots", () => {
  it("extracts sitemaps", () => {
    expect(parseRobots(SAMPLE).sitemaps).toEqual([
      "https://docs.northwind.com/sitemap.xml",
    ]);
  });
});

describe("isAllowed", () => {
  const r = parseRobots(SAMPLE);

  it("blocks a disallowed prefix for the * group", () => {
    expect(isAllowed(r, "/admin/settings", "Sherpa")).toBe(false);
  });

  it("longest match lets a nested Allow override a broader Disallow", () => {
    expect(isAllowed(r, "/admin/public/guide", "Sherpa")).toBe(true);
  });

  it("allows anything not covered by a rule", () => {
    expect(isAllowed(r, "/docs/intro", "Sherpa")).toBe(true);
  });

  it("applies the specific agent group over the * group", () => {
    expect(isAllowed(r, "/docs/intro", "BadBot")).toBe(false);
  });
});

describe("crawlDelay", () => {
  it("reads Crawl-delay for the matching group", () => {
    expect(crawlDelay(parseRobots(SAMPLE), "Sherpa")).toBe(2);
  });
  it("is undefined when unspecified", () => {
    expect(crawlDelay(parseRobots("User-agent: *\nDisallow:"), "x")).toBe(
      undefined,
    );
  });
});
