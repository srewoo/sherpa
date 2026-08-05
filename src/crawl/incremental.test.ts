import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { shouldReindex, shouldRebuildSparseIndex } from "./incremental.js";
import { frontier } from "./frontier.js";
import { openSherpaDb } from "@/storage/db.js";
import { chunkStore } from "@/storage/chunks.js";
import type { StoredChunk } from "@/domain/records.js";

describe("shouldReindex", () => {
  const base = { etag: undefined, lastmod: undefined, htmlHash: "aaa" };
  it("reindexes an unknown page", () => {
    expect(shouldReindex(undefined, base)).toBe(true);
  });
  it("skips when ETag matches, reindexes when it differs", () => {
    expect(shouldReindex({ ...base, etag: "v1" }, { ...base, etag: "v1", htmlHash: "zzz" })).toBe(false);
    expect(shouldReindex({ ...base, etag: "v1" }, { ...base, etag: "v2" })).toBe(true);
  });
  it("falls back to content hash when no validators", () => {
    expect(shouldReindex(base, { ...base, htmlHash: "aaa" })).toBe(false);
    expect(shouldReindex(base, { ...base, htmlHash: "bbb" })).toBe(true);
  });
});

let seq = 0;
const freshDb = () => openSherpaDb(`inc-test-${seq++}`);
const chunk = (id: number, url: string): StoredChunk => ({
  indexId: "i", vectorId: id, text: "t", body: "b", url, anchor: undefined,
  headingPath: "H", position: id, title: "T", contentHash: `h${id}`,
});

describe("incremental storage ops", () => {
  it("deleteByUrl removes only that page's chunks", async () => {
    const db = await freshDb();
    await chunkStore.putBatch(db, [chunk(0, "https://d/a"), chunk(1, "https://d/a"), chunk(2, "https://d/b")]);
    await chunkStore.deleteByUrl(db, "i", "https://d/a");
    expect(await chunkStore.countByIndex(db, "i")).toBe(1);
    expect((await chunkStore.get(db, "i", 2))?.url).toBe("https://d/b");
  });

  it("requeueAll resets every frontier entry to queued", async () => {
    const db = await freshDb();
    await frontier.seed(db, "i", [{ url: "https://d/a", depth: 0 }, { url: "https://d/b", depth: 0 }]);
    await frontier.mark(db, "i", "https://d/a", "done");
    await frontier.mark(db, "i", "https://d/b", "failed");
    await frontier.requeueAll(db, "i");
    expect((await frontier.counts(db, "i")).queued).toBe(2);
  });
});

describe("shouldRebuildSparseIndex", () => {
  it("rebuilds after a first crawl or a full re-crawl", () => {
    expect(shouldRebuildSparseIndex(false, 0)).toBe(true);
    expect(shouldRebuildSparseIndex(false, 120)).toBe(true);
  });

  it("rebuilds when an incremental pass changed something", () => {
    expect(shouldRebuildSparseIndex(true, 1)).toBe(true);
  });

  it("skips the rebuild when an incremental pass changed nothing", () => {
    // Every page answered 304 or hashed identical, so the stored blob is
    // already byte-for-byte correct; rebuilding re-tokenises the whole index.
    expect(shouldRebuildSparseIndex(true, 0)).toBe(false);
  });
});
