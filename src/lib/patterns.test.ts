import { describe, it, expect } from "vitest";
import { inScope, globToRegExp, DEFAULT_EXCLUDES } from "./patterns.js";

describe("globToRegExp", () => {
  it("maps * to any run and ? to a single char", () => {
    expect(globToRegExp("*.pdf").test("https://x.com/a.pdf")).toBe(true);
    expect(globToRegExp("/v?/*").test("/v2/intro")).toBe(true);
    expect(globToRegExp("/v?/*").test("/v10/intro")).toBe(false);
  });

  it("escapes regex metacharacters in the literal parts", () => {
    expect(globToRegExp("*?print=*").test("https://x.com/a?print=1")).toBe(true);
    expect(globToRegExp("/a.b").test("/axb")).toBe(false);
  });
});

describe("inScope", () => {
  const rules = { include: [], exclude: [...DEFAULT_EXCLUDES] };

  it("includes everything when include list is empty", () => {
    expect(inScope("https://x.com/docs/intro", rules)).toBe(true);
  });

  it("applies the default excludes", () => {
    expect(inScope("https://x.com/blog/post", rules)).toBe(false);
    expect(inScope("https://x.com/a.pdf", rules)).toBe(false);
    expect(inScope("https://x.com/a?print=1", rules)).toBe(false);
  });

  it("exclude overrides include", () => {
    expect(
      inScope("https://x.com/docs/secret", {
        include: ["*/docs/*"],
        exclude: ["*/secret"],
      }),
    ).toBe(false);
  });

  it("respects a non-empty include allowlist", () => {
    const only = { include: ["*/admin/*"], exclude: [] };
    expect(inScope("https://x.com/admin/sso", only)).toBe(true);
    expect(inScope("https://x.com/user/home", only)).toBe(false);
  });
});
