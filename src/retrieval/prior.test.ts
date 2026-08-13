import { describe, it, expect } from "vitest";
import { buildPriors, priorBoosts, DEFAULT_PRIOR } from "./prior.js";
import { ResultCache, cacheKey, DEFAULT_RESULT_CACHE } from "./cache.js";
import type { QueryLogEntry } from "@/storage/schema.js";
import type { RetrieveResult } from "./retrieve.js";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/**
 * A pick turn as the job actually logs it: `query` is the chip's *label*, and
 * `pickedFor` is the question the user originally asked.
 */
function pick(pickedFor: string, url: string, at = NOW, label = "Some Page Title"): QueryLogEntry {
  return {
    indexId: "i",
    query: label,
    topScore: 0.6,
    answered: true,
    pickedUrl: url,
    pickedFor,
    at,
  };
}

describe("pick priors", () => {
  it("folds repeated picks for one page into a single prior", () => {
    const priors = buildPriors([
      pick("how to record a call", "https://h/zoom"),
      pick("recording calls on zoom", "https://h/zoom"),
    ]);
    expect(priors).toHaveLength(1);
    expect(priors[0]?.count).toBe(2);
    expect(priors[0]?.terms.get("record")).toBe(1);
    expect(priors[0]?.terms.get("recording")).toBe(1);
  });

  /**
   * The bug this locks down was silent and self-consistent: binding the chip's
   * label to the page it names ("Zoom Phone" → the Zoom Phone page) produces a
   * prior that looks populated, matches nothing anyone would type, and has no
   * symptom. What has to be learned is the *question* the pick answered.
   */
  it("learns the question the pick answered, not the chip's label", () => {
    const priors = buildPriors([
      pick("how to record a call", "https://h/zoom", NOW, "Zoom Phone"),
    ]);
    expect(priors[0]?.terms.get("record")).toBe(1);
    expect(priors[0]?.terms.has("zoom")).toBe(false);

    // And the payoff: the original wording now finds the chosen page.
    expect(priorBoosts("how to record a call", priors, NOW).get("https://h/zoom")).toBeGreaterThan(1);
  });

  /** Records written before `pickedFor` existed still load. */
  it("falls back to the logged query for older records", () => {
    const legacy: QueryLogEntry = {
      indexId: "i",
      query: "record a call",
      topScore: 0.6,
      answered: true,
      pickedUrl: "https://h/zoom",
      at: NOW,
    };
    expect(buildPriors([legacy])[0]?.terms.get("record")).toBe(1);
  });

  it("ignores turns where nothing was picked", () => {
    const noPick: QueryLogEntry = {
      indexId: "i",
      query: "q",
      topScore: 0.6,
      answered: true,
      at: NOW,
    };
    expect(buildPriors([noPick])).toEqual([]);
  });

  it("boosts a page previously picked for a question like this one", () => {
    const priors = buildPriors([
      pick("how to record a call", "https://h/zoom"),
      pick("how to record a call", "https://h/zoom"),
      pick("how to record a call", "https://h/zoom"),
    ]);
    const boosts = priorBoosts("record a call", priors, NOW);
    expect(boosts.get("https://h/zoom")).toBeGreaterThan(1);
  });

  it("says nothing about a question sharing no vocabulary", () => {
    const priors = buildPriors([pick("how to record a call", "https://h/zoom")]);
    expect(priorBoosts("export invoices for a date range", priors, NOW).size).toBe(0);
  });

  /** One click must not pin a page to the top of everything, forever. */
  it("caps the multiplier however many picks accumulate", () => {
    const many = Array.from({ length: 50 }, () => pick("record a call", "https://h/zoom"));
    const boost = priorBoosts("record a call", buildPriors(many), NOW).get("https://h/zoom");
    expect(boost).toBeLessThanOrEqual(DEFAULT_PRIOR.maxBoost);
  });

  /** Docs change and so does what people look for. */
  it("decays with age", () => {
    const fresh = buildPriors([pick("record a call", "https://h/zoom", NOW)]);
    const old = buildPriors([
      pick("record a call", "https://h/zoom", NOW - 120 * DAY),
    ]);
    const freshBoost = priorBoosts("record a call", fresh, NOW).get("https://h/zoom") ?? 1;
    const oldBoost = priorBoosts("record a call", old, NOW).get("https://h/zoom") ?? 1;
    expect(oldBoost).toBeLessThan(freshBoost);
  });

  /**
   * A page picked for many different questions accumulates vocabulary. Scoring
   * overlap against that total would make a popular page match everything, so
   * overlap is measured as a share of the *query's* terms.
   */
  it("does not let a broadly-picked page match every query", () => {
    const broad = buildPriors([
      pick("record a call", "https://h/hub"),
      pick("export invoices", "https://h/hub"),
      pick("rotate api keys", "https://h/hub"),
      pick("configure saml sso", "https://h/hub"),
    ]);
    const narrow = buildPriors([
      pick("record a call", "https://h/zoom"),
      pick("record a call", "https://h/zoom"),
      pick("record a call", "https://h/zoom"),
    ]);
    const broadBoost = priorBoosts("record a call", broad, NOW).get("https://h/hub") ?? 1;
    const narrowBoost = priorBoosts("record a call", narrow, NOW).get("https://h/zoom") ?? 1;
    expect(narrowBoost).toBeGreaterThan(broadBoost);
  });

  it("keeps only the most recent entries", () => {
    const entries = Array.from({ length: 600 }, (_, i) =>
      pick(`query number ${i}`, `https://h/${i}`, NOW - i * 1000),
    );
    expect(buildPriors(entries).length).toBe(DEFAULT_PRIOR.maxEntries);
  });
});

describe("result cache", () => {
  const result = (topScore: number): RetrieveResult => ({
    articles: [],
    topScore,
    denseAvailable: true,
  });

  it("returns a stored result for an identical query", () => {
    const cache = new ResultCache();
    const key = cacheKey({ indexId: "i", search: "q" });
    cache.set(key, result(0.5), NOW);
    expect(cache.get(key, NOW)?.topScore).toBe(0.5);
  });

  /** A cache that answers the wrong question is worse than no cache. */
  it("keys on every input that changes the result", () => {
    const base = { indexId: "i", search: "q" };
    const keys = new Set([
      cacheKey(base),
      cacheKey({ ...base, focusUrl: "https://h/a" }),
      cacheKey({ ...base, currentUrl: "https://h/b" }),
      cacheKey({ ...base, denseText: "a hypothetical passage" }),
      cacheKey({ ...base, indexId: "j" }),
      cacheKey({ ...base, search: "other" }),
    ]);
    expect(keys.size).toBe(6);
  });

  it("expires an entry once it is older than the TTL", () => {
    const cache = new ResultCache();
    cache.set("k", result(0.5), NOW);
    expect(cache.get("k", NOW + DEFAULT_RESULT_CACHE.ttlMs + 1)).toBeUndefined();
  });

  /** Reading an entry keeps it, but does not make it younger. */
  it("does not let repeated reads keep a stale entry alive", () => {
    const cache = new ResultCache();
    cache.set("k", result(0.5), NOW);
    const nearlyExpired = NOW + DEFAULT_RESULT_CACHE.ttlMs - 1;
    expect(cache.get("k", nearlyExpired)).toBeDefined();
    expect(cache.get("k", NOW + DEFAULT_RESULT_CACHE.ttlMs + 1)).toBeUndefined();
  });

  it("evicts the least recently used entry past capacity", () => {
    const cache = new ResultCache({ maxEntries: 2, ttlMs: 60_000 });
    cache.set("a", result(1), NOW);
    cache.set("b", result(2), NOW);
    cache.get("a", NOW); // 'a' is now the more recently used
    cache.set("c", result(3), NOW);
    expect(cache.get("b", NOW)).toBeUndefined();
    expect(cache.get("a", NOW)).toBeDefined();
  });

  it("clears only the index that changed", () => {
    const cache = new ResultCache();
    cache.set(cacheKey({ indexId: "i", search: "q" }), result(1), NOW);
    cache.set(cacheKey({ indexId: "j", search: "q" }), result(2), NOW);
    cache.clear("i");
    expect(cache.get(cacheKey({ indexId: "i", search: "q" }), NOW)).toBeUndefined();
    expect(cache.get(cacheKey({ indexId: "j", search: "q" }), NOW)).toBeDefined();
  });
});

describe("cache key covers reranker state", () => {
  /**
   * `getReranker()` returns undefined while the weights load and after a
   * transient failure, so the same query can be reranked on one turn and not
   * the next. Without this in the key, the first un-reranked result is served
   * for the rest of the TTL and the reranker appears not to work.
   */
  it("distinguishes a reranked result from an un-reranked one", () => {
    const base = { indexId: "i", search: "q" };
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, reranked: true }));
  });

  /** Free-text parts must not run together into a colliding key. */
  it("does not collide when a field boundary shifts", () => {
    expect(cacheKey({ indexId: "a", search: "b c" })).not.toBe(
      cacheKey({ indexId: "a b", search: "c" }),
    );
  });
});
