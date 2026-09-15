import { describe, it, expect } from "vitest";
import { isMessage, type Message } from "./messages.js";
import { parseMessage, MESSAGE_TYPES } from "./messages.schema.js";

/**
 * One well-formed example of every message on the seam.
 *
 * Typed as `Message[]`, which is what makes this a contract rather than a
 * fixture list: a variant that changes shape stops compiling here, and a
 * variant that is added shows up as a gap in the coverage test below.
 */
const VALID: readonly Message[] = [
  // Nested payloads are cast: their own shape is tested where it is defined,
  // and re-specifying a CrawlConfig here would make this a second source of
  // truth that drifts from the first.
  { type: "crawl/start", config: { root: "https://d/" } as never },
  { type: "crawl/preview", requestId: "p-1", config: {} as never },
  { type: "crawl/preview-result", requestId: "p-1", preview: null },
  { type: "crawl/recrawl", indexId: "i" },
  { type: "crawl/recrawl", indexId: "i", background: true },
  { type: "crawl/yield" },
  { type: "crawl/unyield" },
  { type: "crawl/recrawl-full", indexId: "i" },
  { type: "index/import", url: "blob:https://x/y" },
  { type: "index/import-progress", progress: { phase: "done", done: 1, total: 1, host: "d" } as never },
  { type: "crawl/pause" },
  { type: "crawl/resume" },
  { type: "crawl/progress", progress: { fetched: 1, queued: 0, failed: 0, skipped: 0, embedded: 1, currentUrl: null, phase: "done" } },
  { type: "ensure-offscreen" },
  { type: "db/close" },
  { type: "render/page", url: "https://d/a" },
  { type: "panel/open" },
  { type: "query/warm", indexId: "i" },
  { type: "query/ask", requestId: "q-1", indexId: "i", query: "how do I reset" },
  { type: "query/cancel", requestId: "q-1" },
  { type: "query/event", requestId: "q-1", event: { kind: "done" } },
];

describe("the message contract", () => {
  it("accepts a well-formed example of every message", () => {
    for (const message of VALID) {
      const result = parseMessage(message);
      expect(result.ok, `${message.type}: ${result.ok ? "" : result.reason}`).toBe(true);
    }
  });

  /**
   * The guard against the failure this file exists for: a variant added to the
   * union, validated nowhere, and only discovered when a real message is
   * silently rejected in production.
   */
  it("has an example for every type the schema knows about", () => {
    const covered = new Set(VALID.map((m) => m.type));
    const missing = MESSAGE_TYPES.filter((t) => !covered.has(t));
    expect(missing).toEqual([]);
  });

  describe("rejects what the old `\"type\" in value` check waved through", () => {
    it("a query/ask with no requestId, indexId or query", () => {
      // This is the one that mattered: the handler destructured all three into
      // undefined and ran a query against index `undefined`, several hops from
      // the message that caused it.
      const result = parseMessage({ type: "query/ask" });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toContain("requestId");
    });

    it("an empty-string id, which is a bug and not an id", () => {
      expect(parseMessage({ type: "query/cancel", requestId: "" }).ok).toBe(false);
    });

    it("a field of the wrong type", () => {
      expect(parseMessage({ type: "query/warm", indexId: 42 }).ok).toBe(false);
      expect(
        parseMessage({ type: "query/ask", requestId: "q", indexId: "i", query: "x", recentQuestions: "not an array" }).ok,
      ).toBe(false);
    });

    it("a missing nested payload", () => {
      expect(parseMessage({ type: "crawl/start" }).ok).toBe(false);
      expect(parseMessage({ type: "crawl/start", config: "a string" }).ok).toBe(false);
    });

    it("an event with no kind to switch on", () => {
      expect(parseMessage({ type: "query/event", requestId: "q-1", event: {} }).ok).toBe(false);
    });
  });

  describe("stays quiet about traffic that isn't ours", () => {
    it("reports an unknown type without throwing", () => {
      // A listener sees every message broadcast in the extension, including
      // ones addressed elsewhere; throwing on those would make routine traffic
      // an error.
      const result = parseMessage({ type: "some-other-extension/ping" });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toBe("unknown message type");
    });

    it("handles non-objects and nulls", () => {
      for (const value of [null, undefined, 42, "hello", []]) {
        expect(parseMessage(value).ok).toBe(false);
      }
    });
  });

  it("keeps `isMessage` usable as the cheap pre-filter it is", () => {
    // Still exported and still used for narrowing; the point of the schema is
    // that it catches what this one cannot.
    expect(isMessage({ type: "query/ask" })).toBe(true);
    expect(parseMessage({ type: "query/ask" }).ok).toBe(false);
  });
});
