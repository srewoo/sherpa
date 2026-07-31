import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { openSherpaDb } from "./db.js";
import { indexRepo } from "./indexRepo.js";
import { vectorStore } from "./vectors.js";
import { chunkStore } from "./chunks.js";
import { pageStore } from "./pages.js";
import { SCHEMA_VERSION, type IndexMeta, type StoredChunk, type StoredPage } from "@/domain/records.js";

let seq = 0;
const freshDb = () => openSherpaDb(`sherpa-test-${seq++}`);

function meta(id: string): IndexMeta {
  return {
    id,
    root: "https://docs.northwind.com/",
    host: "docs.northwind.com",
    title: "Northwind Help",
    pageCount: 0,
    chunkCount: 0,
    sizeBytes: 0,
    createdAt: 1,
    lastIndexedAt: 1,
    schemaVersion: SCHEMA_VERSION,
    config: {
      root: "https://docs.northwind.com/",
      scope: { include: [], exclude: [] },
      maxPages: 5000,
      maxDepth: 10,
      requestsPerSecond: 1,
      concurrency: 3,
      failureCeiling: 20,
    },
  };
}

function chunk(indexId: string, vectorId: number, url: string, position: number): StoredChunk {
  return {
    indexId,
    vectorId,
    text: `t${vectorId}`,
    body: `b${vectorId}`,
    url,
    anchor: undefined,
    headingPath: "Admin > SSO",
    position,
    title: "SSO",
    contentHash: `h${vectorId}`,
  };
}

describe("db migration", () => {
  it("creates every object store at the current schema version", async () => {
    const db = await freshDb();
    expect([...db.objectStoreNames].sort()).toEqual(
      ["bm25", "chunks", "frontier", "indexRegistry", "meta", "pages", "queryLog", "vectors"],
    );
  });

  it("creates the indexes retrieval and dedupe depend on", async () => {
    const db = await freshDb();
    const tx = db.transaction(["pages", "chunks"], "readonly");
    expect([...tx.objectStore("pages").indexNames].sort()).toEqual(["byHash", "byIndex"]);
    expect([...tx.objectStore("chunks").indexNames].sort()).toEqual(["byIndex", "byUrl"]);
    await tx.done;
  });
});

describe("indexRepo", () => {
  it("upserts, lists newest-first and gets", async () => {
    const db = await freshDb();
    await indexRepo.upsert(db, { ...meta("a"), lastIndexedAt: 10 });
    await indexRepo.upsert(db, { ...meta("b"), lastIndexedAt: 20 });
    const list = await indexRepo.list(db);
    expect(list.map((m) => m.id)).toEqual(["b", "a"]);
    expect((await indexRepo.get(db, "a"))?.host).toBe("docs.northwind.com");
  });

  it("cascade-deletes rows across every store", async () => {
    const db = await freshDb();
    await indexRepo.upsert(db, meta("x"));
    await pageStore.put(db, pageRec("x", "https://docs.northwind.com/a"));
    await chunkStore.putBatch(db, [chunk("x", 0, "https://docs.northwind.com/a", 0)]);
    await vectorStore.append(db, "x", new Float32Array([1, 2]), 2);
    await db.put("bm25", { indexId: "x", data: new ArrayBuffer(8) });

    await indexRepo.delete(db, "x");

    expect(await indexRepo.get(db, "x")).toBeUndefined();
    expect(await chunkStore.countByIndex(db, "x")).toBe(0);
    expect(await vectorStore.count(db, "x")).toBe(0);
    expect(await db.get("bm25", "x")).toBeUndefined();
  });
});

describe("vectorStore sharding", () => {
  it("returns the starting vectorId and appends contiguously", async () => {
    const db = await freshDb();
    const first = await vectorStore.append(db, "i", new Float32Array([1, 1, 2, 2, 3, 3]), 2);
    const second = await vectorStore.append(db, "i", new Float32Array([4, 4]), 2);
    expect(first).toBe(0);
    expect(second).toBe(3);
    expect(await vectorStore.count(db, "i")).toBe(4);
  });

  it("crosses a shard boundary and reloads in order", async () => {
    const db = await freshDb();
    const n = 5001; // one past SHARD_VECTORS
    const batch = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      batch[i * 2] = i;
      batch[i * 2 + 1] = -i;
    }
    await vectorStore.append(db, "i", batch, 2);
    const loaded = await vectorStore.load(db, "i");
    expect(loaded.count).toBe(n);
    expect(loaded.dim).toBe(2);
    expect(loaded.data[0]).toBe(0);
    expect(loaded.data[5000 * 2]).toBe(5000); // first value of the 2nd shard
    expect(loaded.data[5000 * 2 + 1]).toBe(-5000);
  });

  it("rejects a batch whose length isn't a multiple of dim", async () => {
    const db = await freshDb();
    await expect(vectorStore.append(db, "i", new Float32Array([1, 2, 3]), 2)).rejects.toThrow();
  });
});

describe("chunkStore", () => {
  it("gets neighbours on the same page by position", async () => {
    const db = await freshDb();
    const url = "https://docs.northwind.com/guide";
    const other = "https://docs.northwind.com/other";
    await chunkStore.putBatch(db, [
      chunk("i", 0, url, 0),
      chunk("i", 1, url, 1),
      chunk("i", 2, url, 2),
      chunk("i", 3, other, 0),
    ]);
    const mid = await chunkStore.get(db, "i", 1);
    const nbrs = await chunkStore.neighbours(db, mid!, 1);
    expect(nbrs.map((c) => c.position)).toEqual([0, 2]);
    expect(nbrs.every((c) => c.url === url)).toBe(true);
  });

  it("getMany skips missing ids", async () => {
    const db = await freshDb();
    await chunkStore.putBatch(db, [chunk("i", 5, "u", 0)]);
    expect((await chunkStore.getMany(db, "i", [5, 999])).map((c) => c.vectorId)).toEqual([5]);
  });
});

function pageRec(indexId: string, url: string): StoredPage {
  return {
    indexId,
    url,
    htmlHash: "hash",
    etag: undefined,
    lastmod: undefined,
    title: "A",
    breadcrumb: ["Admin"],
    fetchedAt: 1,
  };
}
