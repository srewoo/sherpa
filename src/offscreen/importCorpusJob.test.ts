import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { openSherpaDb, type SherpaDatabase } from "@/storage/db.js";
import { indexRepo } from "@/storage/indexRepo.js";
import { chunkStore } from "@/storage/chunks.js";
import { parseCrawlConfig } from "@/domain/config.js";
import { importIndexId } from "./importCorpusJob.js";
import { buildCorpusExport, parseCorpusExport } from "@/storage/corpusExport.js";
import type { IndexMeta, StoredChunk } from "@/domain/records.js";

const meta: IndexMeta = {
  id: "help.acme.test-1",
  root: "https://help.acme.test/",
  host: "help.acme.test",
  title: "Acme Help",
  pageCount: 2,
  chunkCount: 3,
  sizeBytes: 46_000,
  createdAt: 1,
  lastIndexedAt: 2,
  schemaVersion: 4,
  embeddingModel: "Xenova/bge-small-en-v1.5",
  config: parseCrawlConfig({ root: "https://help.acme.test/", maxPages: 1234 }),
};

const chunk = (url: string, position: number): StoredChunk => ({
  indexId: meta.id,
  vectorId: position,
  text: `t${position}`,
  body: `b${position}`,
  url,
  anchor: undefined,
  headingPath: "H",
  position,
  title: "T",
  contentHash: `h${position}`,
});

describe("corpus export → import round trip", () => {
  /**
   * The property that makes import a *restore*: everything needed to rebuild
   * has to survive the file, or the imported index is a lesser copy.
   */
  it("carries the crawl config, so an imported index can still be refreshed", () => {
    const exported = buildCorpusExport(meta, [chunk("https://help.acme.test/a", 0)], 99);
    const reparsed = parseCorpusExport(JSON.parse(JSON.stringify(exported)));
    expect(reparsed.config?.maxPages).toBe(1234);
    expect(reparsed.config?.root).toBe("https://help.acme.test/");
  });

  /** Older exports predate the config and must still import. */
  it("accepts an export written before the config was carried", () => {
    const exported = buildCorpusExport(meta, [chunk("https://help.acme.test/a", 0)], 99);
    const { config: _dropped, ...older } = exported;
    expect(() => parseCorpusExport(older)).not.toThrow();
  });

  it("round-trips every chunk", () => {
    const exported = buildCorpusExport(
      meta,
      [chunk("https://help.acme.test/a", 0), chunk("https://help.acme.test/b", 1)],
      99,
    );
    expect(parseCorpusExport(JSON.parse(JSON.stringify(exported))).chunks).toHaveLength(2);
  });
});

describe("importIndexId", () => {
  /** Export → import of the same site should land back on the same index. */
  it("reuses the exported id so a round trip doesn't duplicate the index", () => {
    const exported = buildCorpusExport(meta, [chunk("https://help.acme.test/a", 0)], 99);
    expect(importIndexId(exported)).toBe(meta.id);
  });

  it("falls back to a host-derived id when the export has none", () => {
    const exported = buildCorpusExport(meta, [chunk("https://help.acme.test/a", 0)], 99);
    expect(importIndexId({ ...exported, indexId: "" })).toBe("help.acme.test-import");
  });
});

describe("import replaces rather than merges", () => {
  let db: SherpaDatabase;

  beforeEach(async () => {
    db = await openSherpaDb(`import-test-${Math.floor(performance.now() * 1000)}`);
  });

  /**
   * An import is a restore. Merging would leave chunks from the previous index
   * with vector ids that no longer address anything in the new shard array —
   * retrieval would return text for the wrong passage rather than fail.
   */
  it("clears prior content for the index it imports into", async () => {
    await indexRepo.upsert(db, meta);
    await chunkStore.putBatch(db, [chunk("https://help.acme.test/old", 0)]);
    expect(await chunkStore.listByIndex(db, meta.id)).toHaveLength(1);

    await indexRepo.clearContent(db, meta.id);

    expect(await chunkStore.listByIndex(db, meta.id)).toHaveLength(0);
    // The registry entry survives, so the row doesn't vanish mid-import.
    expect(await indexRepo.get(db, meta.id)).toBeDefined();
  });
});
