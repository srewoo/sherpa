import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { openSherpaDb } from "@/storage/db.js";
import { chunkStore } from "@/storage/chunks.js";
import { vectorStore } from "@/storage/vectors.js";
import type { StoredChunk } from "@/domain/records.js";
import { Bm25Index, tokenize } from "./bm25.js";
import { cosineTopK } from "./cosine.js";
import { retrieve, type Embedderish } from "./retrieve.js";

let seq = 0;
const freshDb = () => openSherpaDb(`ret-test-${seq++}`);

describe("bm25", () => {
  const idx = new Bm25Index([
    { id: 0, text: "bulk import failed validation error" },
    { id: 1, text: "rotate api key without downtime" },
    { id: 2, text: "webhook retry backoff schedule" },
  ]);

  it("ranks the doc with the exact query term first", () => {
    expect(idx.search("api key rotation", 3)[0]?.id).toBe(1);
    expect(idx.search("import validation", 3)[0]?.id).toBe(0);
  });

  it("returns nothing for an out-of-vocabulary query", () => {
    expect(idx.search("kubernetes helm chart", 3)).toEqual([]);
  });

  it("tokenizes to lowercase alphanumerics, dropping single chars", () => {
    expect(tokenize("Rotate-API_key v2!")).toEqual(["rotate", "api", "key", "v2"]);
  });
});

describe("cosineTopK", () => {
  it("orders rows by dot product with a normalised query", () => {
    const matrix = new Float32Array([1, 0, 0, 1, 0.7071, 0.7071]);
    const q = new Float32Array([1, 0]);
    const top = cosineTopK(q, matrix, 2, 3, 3);
    expect(top[0]?.id).toBe(0); // exact match
    expect(top[1]?.id).toBe(2); // 45°
    expect(top[2]?.id).toBe(1); // orthogonal
  });
});

describe("retrieve (hybrid)", () => {
  const embedderFor = (vec: number[]): Embedderish => ({
    dim: 4,
    embed: async () => new Float32Array(vec),
  });

  function chunk(id: number, url: string, pos: number, text: string): StoredChunk {
    return {
      indexId: "i", vectorId: id, text, body: text, url, anchor: undefined,
      headingPath: "Docs", position: pos, title: "Docs", contentHash: `h${id}`,
    };
  }

  it("ranks the matching chunk first and pulls its page neighbour", async () => {
    const db = await freshDb();
    // c0,c1 on the same page; c2 elsewhere. Vectors are one-hot (already unit).
    await vectorStore.append(db, "i", new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]), 4);
    await chunkStore.putBatch(db, [
      chunk(0, "https://d/x", 0, "alpha bulk import failed"),
      chunk(1, "https://d/x", 1, "beta rotate api key"),
      chunk(2, "https://d/y", 0, "gamma webhook retry"),
    ]);

    const res = await retrieve(
      { db, indexId: "i", embedder: embedderFor([0, 1, 0, 0]) },
      "rotate api key",
    );

    // The page holding the best chunk ranks first, as one article.
    const top = res.articles[0];
    expect(top?.url).toBe("https://d/x");
    expect(res.topScore).toBeGreaterThan(0);

    // Chunks come back in document order, and the matched one is present.
    expect(top?.chunks.map((c) => c.vectorId)).toEqual([0, 1]);
    expect(top?.chunks.find((c) => c.vectorId === 1)?.viaNeighbour).toBe(false);
    // Its page neighbour is carried along so the passage stays contiguous.
    expect(top?.body).toContain("beta rotate api key");
    expect(top?.body).toContain("alpha bulk import failed");
  });

  it("returns empty for an index with no vectors", async () => {
    const db = await freshDb();
    const res = await retrieve({ db, indexId: "empty", embedder: embedderFor([1, 0, 0, 0]) }, "q");
    expect(res).toEqual({ articles: [], topScore: 0, denseAvailable: true });
  });
});
