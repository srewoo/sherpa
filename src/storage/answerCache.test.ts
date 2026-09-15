import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { openSherpaDb } from "./db.js";
import {
  answerCacheStore,
  answerKey,
  normaliseQuery,
  settingsFingerprint,
  type AnswerKeyParts,
} from "./answerCache.js";
import type { CachedAnswer } from "./schema.js";

let seq = 0;
const freshDb = () => openSherpaDb(`sherpa-answercache-${seq++}`);

const FINGERPRINT = settingsFingerprint({
  refuseFloor: 0.7,
  confidentFloor: 0.8,
  rerank: false,
  hyde: false,
  rewriteQueries: false,
});

const BASE: AnswerKeyParts = {
  indexId: "i",
  indexedAt: 1000,
  query: "how do I rotate an API key",
  tier: "byok",
  model: "gpt-4o-mini",
  settingsFingerprint: FINGERPRINT,
};

function entry(over: Partial<CachedAnswer> = {}): CachedAnswer {
  return {
    key: answerKey(BASE),
    indexId: "i",
    query: BASE.query,
    tier: "byok",
    markdown: "Open Settings, then press Rotate. [1]",
    sources: [],
    certainty: "confident",
    topScore: 0.86,
    at: Date.now(),
    hits: 0,
    ...over,
  };
}

describe("answerKey", () => {
  it("matches the same question asked again in different case and spacing", () => {
    expect(answerKey({ ...BASE, query: "  How Do I Rotate An API KEY  " })).toBe(answerKey(BASE));
  });

  /**
   * Everything below is the rule the whole file exists for: a cache that
   * returns the right answer to the wrong question is worse than no cache.
   */
  describe("changes when anything that changes the answer changes", () => {
    const cases: readonly [string, Partial<AnswerKeyParts>][] = [
      ["a different index", { indexId: "other" }],
      ["a re-crawl of the same index", { indexedAt: 2000 }],
      ["a different question", { query: "how do I delete a user" }],
      ["a different tier", { tier: "nano" }],
      ["a different model on the same tier", { model: "gpt-4o" }],
      ["a turn scoped to one page", { focusUrl: "https://d/a" }],
      ["a settings change", { settingsFingerprint: "different" }],
    ];
    for (const [label, patch] of cases) {
      it(label, () => {
        expect(answerKey({ ...BASE, ...patch })).not.toBe(answerKey(BASE));
      });
    }
  });

  it("keeps a negation distinct, which is why normalisation stops at case", () => {
    // "can I" and "can't I" want opposite answers, and no cheap normalisation
    // can be trusted to tell those apart — so none is attempted.
    expect(answerKey({ ...BASE, query: "can I delete a user" })).not.toBe(
      answerKey({ ...BASE, query: "can't I delete a user" }),
    );
  });

  it("cannot be confused by a field boundary", () => {
    // A NUL separator, so an index "a" + query "b c" never keys the same as an
    // index "a b" + query "c".
    expect(answerKey({ ...BASE, indexId: "a", query: "b c" })).not.toBe(
      answerKey({ ...BASE, indexId: "a b", query: "c" }),
    );
  });
});

describe("normaliseQuery", () => {
  it("folds case and collapses whitespace, and does nothing else", () => {
    expect(normaliseQuery("  How   DO I\tpay? ")).toBe("how do i pay?");
  });
});

describe("settingsFingerprint", () => {
  it("separates a moved floor from an unmoved one", () => {
    const a = settingsFingerprint({ refuseFloor: 0.7, confidentFloor: 0.8, rerank: false, hyde: false, rewriteQueries: false });
    const b = settingsFingerprint({ refuseFloor: 0.75, confidentFloor: 0.8, rerank: false, hyde: false, rewriteQueries: false });
    expect(a).not.toBe(b);
  });

  it("separates each retrieval switch independently", () => {
    const base = { refuseFloor: 0.7, confidentFloor: 0.8, rerank: false, hyde: false, rewriteQueries: false };
    const seen = new Set([
      settingsFingerprint(base),
      settingsFingerprint({ ...base, rerank: true }),
      settingsFingerprint({ ...base, hyde: true }),
      settingsFingerprint({ ...base, rewriteQueries: true }),
    ]);
    expect(seen.size).toBe(4);
  });
});

describe("answerCacheStore", () => {
  it("stores and serves an answer", async () => {
    const db = await freshDb();
    await answerCacheStore.put(db, entry());
    const hit = await answerCacheStore.get(db, answerKey(BASE));
    expect(hit?.markdown).toContain("press Rotate");
  });

  it("returns nothing for a key it has never seen", async () => {
    const db = await freshDb();
    expect(await answerCacheStore.get(db, "nope")).toBeUndefined();
  });

  it("expires an answer past its TTL and removes it", async () => {
    const db = await freshDb();
    const at = 1_000_000;
    await answerCacheStore.put(db, entry({ at }));
    const options = { ttlMs: 1000, maxEntriesPerIndex: 10 };
    expect(await answerCacheStore.get(db, answerKey(BASE), options, at + 500)).toBeDefined();
    expect(await answerCacheStore.get(db, answerKey(BASE), options, at + 5000)).toBeUndefined();
    // Gone, not merely hidden — a stale entry must not keep occupying the cap.
    expect(await db.get("answerCache", answerKey(BASE))).toBeUndefined();
  });

  it("counts reads, so eviction can keep what people re-ask", async () => {
    const db = await freshDb();
    await answerCacheStore.put(db, entry());
    await answerCacheStore.get(db, answerKey(BASE));
    await answerCacheStore.get(db, answerKey(BASE));
    // The hit counter is written without being awaited, so let it land.
    await new Promise((r) => setTimeout(r, 0));
    expect((await answerCacheStore.stats(db, "i")).hits).toBeGreaterThan(0);
  });

  it("evicts least-recently-read first when over the cap", async () => {
    const db = await freshDb();
    const options = { ttlMs: 60_000, maxEntriesPerIndex: 2 };
    await answerCacheStore.put(db, entry({ key: "old", at: 1 }), options);
    await answerCacheStore.put(db, entry({ key: "mid", at: 2 }), options);
    await answerCacheStore.put(db, entry({ key: "new", at: 3 }), options);
    const remaining = (await db.getAllFromIndex("answerCache", "byIndex", "i")).map((e) => e.key);
    expect(remaining.sort()).toEqual(["mid", "new"]);
  });

  it("clears one index without touching another", async () => {
    const db = await freshDb();
    await answerCacheStore.put(db, entry({ key: "a", indexId: "i" }));
    await answerCacheStore.put(db, entry({ key: "b", indexId: "j" }));
    await answerCacheStore.clearIndex(db, "i");
    expect(await db.get("answerCache", "a")).toBeUndefined();
    expect(await db.get("answerCache", "b")).toBeDefined();
  });

  it("reports stats for the options page", async () => {
    const db = await freshDb();
    await answerCacheStore.put(db, entry({ key: "a", hits: 3 }));
    await answerCacheStore.put(db, entry({ key: "b", hits: 4 }));
    expect(await answerCacheStore.stats(db, "i")).toEqual({ entries: 2, hits: 7 });
  });

  it("degrades to no cache rather than throwing when the store is unusable", async () => {
    // The whole feature is an optimisation; a broken cache must never turn a
    // question into an error.
    const broken = {
      get: () => Promise.reject(new Error("store gone")),
      getAllFromIndex: () => Promise.reject(new Error("store gone")),
    } as unknown as Awaited<ReturnType<typeof openSherpaDb>>;
    expect(await answerCacheStore.get(broken, "k")).toBeUndefined();
    expect(await answerCacheStore.stats(broken, "i")).toEqual({ entries: 0, hits: 0 });
    await expect(answerCacheStore.put(broken, entry())).resolves.toBeUndefined();
  });
});
