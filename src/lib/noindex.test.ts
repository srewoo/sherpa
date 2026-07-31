import { describe, it, expect } from "vitest";
import { headerSaysNoindex, metaSaysNoindex, isNoindex } from "./noindex.js";

describe("X-Robots-Tag", () => {
  it("detects noindex and none", () => {
    expect(headerSaysNoindex("noindex")).toBe(true);
    expect(headerSaysNoindex("noindex, nofollow")).toBe(true);
    expect(headerSaysNoindex("NONE")).toBe(true);
    expect(headerSaysNoindex("googlebot: noindex")).toBe(true);
  });

  it("leaves indexable pages alone", () => {
    expect(headerSaysNoindex(undefined)).toBe(false);
    expect(headerSaysNoindex("all")).toBe(false);
    expect(headerSaysNoindex("nofollow")).toBe(false);
    // "noindexing" is not the directive.
    expect(headerSaysNoindex("noindexing")).toBe(false);
  });
});

describe("robots meta", () => {
  it("detects the robots meta in any quoting style", () => {
    expect(metaSaysNoindex('<meta name="robots" content="noindex">')).toBe(true);
    expect(metaSaysNoindex("<meta name=robots content='noindex, follow'>")).toBe(true);
    expect(metaSaysNoindex('<meta name="googlebot" content="none">')).toBe(true);
  });

  it("ignores unrelated metas", () => {
    expect(metaSaysNoindex('<meta name="description" content="noindex">')).toBe(false);
    expect(metaSaysNoindex('<meta name="robots" content="index, follow">')).toBe(false);
    expect(metaSaysNoindex("<p>noindex</p>")).toBe(false);
  });
});

describe("isNoindex", () => {
  it("takes either signal", () => {
    expect(isNoindex("<html></html>", "noindex")).toBe(true);
    expect(isNoindex('<meta name="robots" content="noindex">', undefined)).toBe(true);
    expect(isNoindex("<html></html>", undefined)).toBe(false);
    expect(isNoindex(null, undefined)).toBe(false);
  });
});
