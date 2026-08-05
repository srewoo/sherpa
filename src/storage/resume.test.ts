import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { openSherpaDb, closeSherpaDb, type SherpaDatabase } from "@/storage/db.js";
import { metaRepo } from "./metaRepo.js";
import { pageStore } from "./pages.js";
import { chunkStore } from "./chunks.js";
import { vectorStore } from "./vectors.js";
import { indexRepo } from "./indexRepo.js";
import { bm25Store } from "./bm25Store.js";
import { frontier } from "@/crawl/frontier.js";
import { parseCrawlConfig } from "@/domain/config.js";
import { SCHEMA_VERSION, type StoredPage } from "@/domain/records.js";

let seq = 0;
const freshDb = (): Promise<SherpaDatabase> => openSherpaDb(`resume-test-${seq++}`);

const config = parseCrawlConfig({ root: "https://docs.x.com/" });

function page(url: string, htmlHash: string): StoredPage {
  return {
    indexId: "i",
    url,
    htmlHash,
    etag: undefined,
    lastmod: undefined,
    title: "T",
    breadcrumb: [],
    fetchedAt: 1,
  };
}

async function registerIndex(db: SherpaDatabase): Promise<void> {
  await indexRepo.upsert(db, {
    id: "i",
    root: config.root,
    host: "docs.x.com",
    title: "docs.x.com",
    pageCount: 0,
    chunkCount: 0,
    sizeBytes: 0,
    createdAt: 1,
    lastIndexedAt: 1,
    schemaVersion: SCHEMA_VERSION,
    config,
  });
}

describe("active-crawl pointer (PRD 5.2.2)", () => {
  it("round-trips the crawl in flight", async () => {
    const db = await freshDb();
    await metaRepo.setActiveCrawl(db, {
      indexId: "i",
      incremental: false,
      paused: true,
      startedAt: 42,
    });
    const active = await metaRepo.activeCrawl(db);
    expect(active).toEqual({ indexId: "i", incremental: false, paused: true, startedAt: 42 });
  });

  it("is absent once cleared, so a finished crawl isn't resumed", async () => {
    const db = await freshDb();
    await metaRepo.setActiveCrawl(db, { indexId: "i", incremental: false, paused: false, startedAt: 1 });
    await metaRepo.clearActiveCrawl(db);
    expect(await metaRepo.activeCrawl(db)).toBeUndefined();
  });

  it("keeps the config on the index, so a restart can rebuild the crawl", async () => {
    const db = await freshDb();
    await registerIndex(db);
    const meta = await indexRepo.get(db, "i");
    expect(meta?.config.root).toBe("https://docs.x.com/");
    expect(meta?.config.maxPages).toBe(config.maxPages);
  });

  it("preserves the frontier across a reopen, with progress intact", async () => {
    const name = `resume-persist-${seq++}`;
    const first = await openSherpaDb(name);
    await frontier.seed(first, "i", [
      { url: "https://docs.x.com/a", depth: 0 },
      { url: "https://docs.x.com/b", depth: 0 },
    ]);
    await frontier.mark(first, "i", "https://docs.x.com/a", "done");
    // Release the cached handle the way "delete everything" does, so the
    // reopen below is a genuine fresh connection.
    await closeSherpaDb();

    const reopened = await openSherpaDb(name);
    const counts = await frontier.counts(reopened, "i");
    expect(counts).toMatchObject({ done: 1, queued: 1 });
  });
});

describe("content-hash dedupe (PRD 5.2.7)", () => {
  it("finds the same content already stored under another URL", async () => {
    const db = await freshDb();
    await pageStore.put(db, page("https://docs.x.com/a", "hash-1"));

    const duplicate = await pageStore.findDuplicate(db, "i", "hash-1", "https://docs.x.com/a-copy");
    expect(duplicate?.url).toBe("https://docs.x.com/a");
  });

  it("does not treat a page as its own duplicate", async () => {
    const db = await freshDb();
    await pageStore.put(db, page("https://docs.x.com/a", "hash-1"));
    expect(await pageStore.findDuplicate(db, "i", "hash-1", "https://docs.x.com/a")).toBeUndefined();
  });

  it("ignores different content and other indexes", async () => {
    const db = await freshDb();
    await pageStore.put(db, page("https://docs.x.com/a", "hash-1"));
    expect(await pageStore.findDuplicate(db, "i", "hash-2", "https://docs.x.com/b")).toBeUndefined();
    expect(await pageStore.findDuplicate(db, "other", "hash-1", "https://docs.x.com/b")).toBeUndefined();
  });
});

describe("measured index size (PRD 5.6.1)", () => {
  it("reports real bytes for vectors and chunk text", async () => {
    const db = await freshDb();
    const dim = 4;
    await vectorStore.append(db, "i", new Float32Array(dim * 3), dim);
    await chunkStore.putBatch(db, [
      {
        indexId: "i",
        vectorId: 0,
        text: "a".repeat(100),
        body: "b".repeat(50),
        url: "https://docs.x.com/a",
        anchor: undefined,
        headingPath: "A",
        position: 0,
        title: "A",
        contentHash: "h",
      },
    ]);

    // 3 vectors × 4 dims × 4 bytes.
    expect(await vectorStore.byteSize(db, "i")).toBe(48);
    expect(await chunkStore.byteSize(db, "i")).toBeGreaterThanOrEqual(150);
  });
});

describe("full re-crawl (PRD 5.6.4)", () => {
  it("clears crawled content but keeps the registry entry and its config", async () => {
    const db = await freshDb();
    await registerIndex(db);
    await pageStore.put(db, page("https://docs.x.com/a", "hash-1"));
    await vectorStore.append(db, "i", new Float32Array(4), 4);
    await chunkStore.putBatch(db, [
      {
        indexId: "i",
        vectorId: 0,
        text: "t",
        body: "b",
        url: "https://docs.x.com/a",
        anchor: undefined,
        headingPath: "A",
        position: 0,
        title: "A",
        contentHash: "h",
      },
    ]);
    await bm25Store.build(db, "i", [{ id: 0, title: "T", section: "S", content: "t" }]);
    await frontier.seed(db, "i", [{ url: "https://docs.x.com/a", depth: 0 }]);

    await indexRepo.clearContent(db, "i");

    expect(await pageStore.countByIndex(db, "i")).toBe(0);
    expect(await chunkStore.countByIndex(db, "i")).toBe(0);
    expect(await vectorStore.count(db, "i")).toBe(0);
    expect(await bm25Store.load(db, "i")).toBeUndefined();
    expect((await frontier.counts(db, "i")).queued).toBe(0);
    // The index itself survives, so the user's active selection isn't lost.
    expect((await indexRepo.get(db, "i"))?.config.root).toBe("https://docs.x.com/");
  });

  it("delete removes the registry entry too", async () => {
    const db = await freshDb();
    await registerIndex(db);
    await indexRepo.delete(db, "i");
    expect(await indexRepo.get(db, "i")).toBeUndefined();
  });
});
