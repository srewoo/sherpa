import { describe, it, expect } from "vitest";
import { expandQuery, scoreExpansionTerms, DEFAULT_EXPANSION } from "./expansion.js";
import { hydeText, hydeQuery, hydePrompt, DEFAULT_HYDE } from "./hyde.js";

describe("scoreExpansionTerms", () => {
  /**
   * The whole point: a word appearing once in every feedback document is the
   * shared vocabulary, while a word repeated many times in one is that
   * document's quirk. Document count has to outrank raw frequency.
   */
  it("ranks a term shared across documents above one repeated in a single document", () => {
    const scored = scoreExpansionTerms(
      // "avatar" once in each of three documents; "mission" four times in one.
      ["avatar roleplay", "avatar scenario", "avatar mission mission mission mission"],
      new Set(),
    );
    expect(scored[0]?.term).toBe("avatar");
    // And the raw-frequency winner is ranked below it, not dropped.
    expect(scored.map((s) => s.term)).toContain("mission");
  });

  it("never suggests a word the query already contains", () => {
    const scored = scoreExpansionTerms(["avatar roleplay"], new Set(["avatar"]));
    expect(scored.map((s) => s.term)).not.toContain("avatar");
  });

  it("drops documentation filler that distinguishes nothing", () => {
    const scored = scoreExpansionTerms(["click the page and select what you want"], new Set());
    expect(scored.map((s) => s.term)).not.toContain("click");
    expect(scored.map((s) => s.term)).not.toContain("the");
  });

  it("drops terms too short to be worth matching", () => {
    const scored = scoreExpansionTerms(["ai ux avatar"], new Set());
    expect(scored.map((s) => s.term)).toEqual(["avatar"]);
  });

  it("reads only as many feedback documents as configured", () => {
    const scored = scoreExpansionTerms(
      ["alpha", "beta", "gamma", "delta"],
      new Set(),
      { ...DEFAULT_EXPANSION, feedbackDocs: 2 },
    );
    expect(scored.map((s) => s.term)).toEqual(["alpha", "beta"]);
  });

  it("is deterministic when documents and counts tie", () => {
    const once = scoreExpansionTerms(["avatar roleplay mission"], new Set());
    const twice = scoreExpansionTerms(["avatar roleplay mission"], new Set());
    expect(once.map((s) => s.term)).toEqual(twice.map((s) => s.term));
  });
});

describe("expandQuery", () => {
  /** The real case: the user's words and the docs' words barely overlap. */
  it("teaches the query the vocabulary of its own top results", () => {
    const expanded = expandQuery("how to create a two way role play", [
      "Practice with avatar lets learners hold an interactive conversation with a Copilot persona.",
      "Select Practice with avatar to create an interactive roleplay mission.",
    ]);
    expect(expanded).toContain("avatar");
    expect(expanded).toContain("interactive");
  });

  /**
   * Expansion widens, never redirects. The original terms have to survive, or a
   * bad set of feedback documents silently replaces the question.
   */
  it("keeps the original query intact", () => {
    const expanded = expandQuery("rotate api key", ["successor overlap window revoke predecessor"]);
    expect(expanded.startsWith("rotate api key")).toBe(true);
  });

  it("returns the query untouched when there is no feedback", () => {
    expect(expandQuery("rotate api key", [])).toBe("rotate api key");
  });

  it("returns the query untouched when the feedback teaches nothing new", () => {
    // Every candidate is either a query term or filler.
    expect(expandQuery("rotate api key", ["rotate the api key"])).toBe("rotate api key");
  });

  it("respects the term cap", () => {
    const expanded = expandQuery("q", ["alpha beta gamma delta epsilon zeta"], {
      ...DEFAULT_EXPANSION,
      maxTerms: 2,
    });
    expect(expanded.split(" ")).toHaveLength(3); // "q" + 2 terms
  });

  it("can be turned off entirely", () => {
    const expanded = expandQuery("q", ["alpha beta"], { ...DEFAULT_EXPANSION, maxTerms: 0 });
    expect(expanded).toBe("q");
  });
});

describe("hydeText", () => {
  it("embeds the hypothetical alongside the question", () => {
    const text = hydeText("how do I rotate a key", "Choose Generate successor to issue a new key.");
    expect(text).toContain("how do I rotate a key");
    expect(text).toContain("Generate successor");
  });

  /** The safety property: no hypothetical means an ordinary query embedding. */
  it("falls back to the plain query when the model produced nothing", () => {
    expect(hydeText("q", "")).toBe("q");
    expect(hydeText("q", "   \n  ")).toBe("q");
  });

  it("caps a rambling hypothetical so it can't drown the question", () => {
    const text = hydeText("q", "x".repeat(5000), { ...DEFAULT_HYDE, maxChars: 100 });
    expect(text.length).toBeLessThan(150);
  });

  it("can drop the question when the caller wants the hypothetical alone", () => {
    expect(hydeText("q", "passage", { maxChars: 600, keepQuery: false })).toBe("passage");
  });
});

describe("hydeQuery", () => {
  it("uses the generated passage", async () => {
    const text = await hydeQuery("q", async () => "a documentation passage");
    expect(text).toContain("a documentation passage");
  });

  /**
   * Retrieval must not fail because an optional enhancement did. Nano being
   * evicted, a BYOK key expiring, or a timeout all land here.
   */
  it("degrades to the plain query when generation throws", async () => {
    const text = await hydeQuery("q", async () => {
      throw new Error("model unavailable");
    });
    expect(text).toBe("q");
  });

  it("asks for a passage rather than an answer", () => {
    const prompt = hydePrompt("how do I rotate a key");
    expect(prompt).toContain("how do I rotate a key");
    expect(prompt.toLowerCase()).toContain("help centre");
  });
});
