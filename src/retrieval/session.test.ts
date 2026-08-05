import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { openSherpaDb, type SherpaDatabase } from "@/storage/db.js";
import { chunkStore } from "@/storage/chunks.js";
import { vectorStore } from "@/storage/vectors.js";
import { bm25Store } from "@/storage/bm25Store.js";
import type { StoredChunk } from "@/domain/records.js";
import { FieldedBm25Index } from "./fieldedBm25.js";
import { loadSession, invalidateSession } from "./session.js";
import { retrieve } from "./retrieve.js";

let seq = 0;
const freshDb = (): Promise<SherpaDatabase> => openSherpaDb(`session-test-${seq++}`);

const DIM = 4;

function chunk(vectorId: number, url: string, position: number, text: string): StoredChunk {
  return {
    indexId: "i",
    vectorId,
    text,
    body: text,
    url,
    anchor: undefined,
    headingPath: "Admin > SSO",
    position,
    title: "SSO",
    contentHash: `h${vectorId}`,
  };
}

/** Unit vectors so cosine is predictable. */
function vec(hot: number): Float32Array {
  const v = new Float32Array(DIM);
  v[hot] = 1;
  return v;
}

const embedder = {
  dim: DIM,
  embed: async (texts: readonly string[]): Promise<Float32Array> => {
    // "sandbox" queries point at row 1, everything else at row 0.
    const out = new Float32Array(texts.length * DIM);
    texts.forEach((t, i) => out.set(vec(t.includes("sandbox") ? 1 : 0), i * DIM));
    return out;
  },
};

async function seedIndex(db: SherpaDatabase): Promise<void> {
  const flat = new Float32Array(3 * DIM);
  flat.set(vec(0), 0);
  flat.set(vec(1), DIM);
  flat.set(vec(2), 2 * DIM);
  await vectorStore.append(db, "i", flat, DIM);
  await chunkStore.putBatch(db, [
    chunk(0, "https://d/keys", 0, "rotate an api key without downtime"),
    chunk(1, "https://d/sso", 0, "configure sso for a sandbox tenant"),
    chunk(2, "https://d/sso", 1, "then verify the audience url"),
  ]);
}

beforeEach(() => invalidateSession());

describe("bm25 persistence (5.5.4)", () => {
  it("round-trips a built index through storage", async () => {
    const db = await freshDb();
    await seedIndex(db);
    const docs = [
      { id: 0, title: "API keys", section: "Admin", content: "rotate an api key" },
      { id: 1, title: "SSO", section: "Admin", content: "configure sso sandbox" },
    ];
    await bm25Store.build(db, "i", docs);

    const loaded = await bm25Store.load(db, "i");
    expect(loaded).toBeDefined();
    // Same ranking as an index built fresh from the same documents.
    expect(loaded!.search("sandbox", 5)).toEqual(FieldedBm25Index.build(docs).search("sandbox", 5));
  });

  it("returns undefined when nothing was ever built", async () => {
    const db = await freshDb();
    expect(await bm25Store.load(db, "never")).toBeUndefined();
  });

  it("survives a corrupt blob rather than breaking search", async () => {
    const db = await freshDb();
    await db.put("bm25", { indexId: "i", data: new Uint8Array([1, 2, 3]).buffer });
    expect(await bm25Store.load(db, "i")).toBeUndefined();
  });
});

describe("index session cache (5.7.3)", () => {
  it("loads vectors, chunks and the sparse index once", async () => {
    const db = await freshDb();
    await seedIndex(db);
    const session = await loadSession(db, "i");
    expect(session.vectors.count).toBe(3);
    expect(session.byId.size).toBe(3);
    // Chunks grouped by page, in document order.
    expect(session.byUrl.get("https://d/sso")?.map((c) => c.position)).toEqual([0, 1]);
  });

  it("hands back the identical object on the second call", async () => {
    const db = await freshDb();
    await seedIndex(db);
    expect(await loadSession(db, "i")).toBe(await loadSession(db, "i"));
  });

  it("rebuilds after invalidation, so a recrawl is visible", async () => {
    const db = await freshDb();
    await seedIndex(db);
    const before = await loadSession(db, "i");
    invalidateSession("i");
    expect(await loadSession(db, "i")).not.toBe(before);
  });

  it("falls back to an in-memory sparse index when the crawl never finished", async () => {
    const db = await freshDb();
    await seedIndex(db); // no bm25Store.build
    const session = await loadSession(db, "i");
    expect(session.bm25.search("sandbox", 5).length).toBeGreaterThan(0);
  });
});

describe("retrieve over a session", () => {
  it("ranks the right chunk first and expands its page neighbour (5.7.5)", async () => {
    const db = await freshDb();
    await seedIndex(db);
    const result = await retrieve({ db, indexId: "i", embedder }, "sso for a sandbox tenant");

    const top = result.articles[0];
    expect(top?.url).toBe("https://d/sso");
    // The chunk that matched is the one the query was aimed at.
    expect(top?.chunks.find((c) => c.vectorId === 1)?.viaNeighbour).toBe(false);
    expect(result.topScore).toBeCloseTo(1, 5);
    // Its sibling on the same page comes along so the procedure stays whole.
    expect(top?.chunks.map((c) => c.vectorId)).toContain(2);
    expect(top?.body).toContain("then verify the audience url");
  });

  it("returns one article per page however many of its chunks matched (5.7.4)", async () => {
    const db = await freshDb();
    const flat = new Float32Array(4 * DIM);
    for (let i = 0; i < 4; i++) flat.set(vec(1), i * DIM); // all equally relevant
    await vectorStore.append(db, "i", flat, DIM);
    await chunkStore.putBatch(db, [
      chunk(0, "https://d/long", 0, "sandbox one"),
      chunk(1, "https://d/long", 1, "sandbox two"),
      chunk(2, "https://d/long", 2, "sandbox three"),
      chunk(3, "https://d/other", 0, "sandbox elsewhere"),
    ]);

    const result = await retrieve({ db, indexId: "i", embedder }, "sandbox");
    // Grouping replaces the old per-page cap: the long page appears once, and
    // all three of its matched chunks inform the answer.
    const urls = result.articles.map((a) => a.url);
    expect(urls).toEqual([...new Set(urls)]);
    const long = result.articles.find((a) => a.url === "https://d/long");
    expect(long?.chunks.filter((c) => !c.viaNeighbour).length).toBe(3);
  });

  it("returns empty for an index with no vectors", async () => {
    const db = await freshDb();
    const result = await retrieve({ db, indexId: "empty", embedder }, "anything");
    expect(result.articles).toEqual([]);
    expect(result.topScore).toBe(0);
  });
});
