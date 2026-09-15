/**
 * Rebuild an index from an exported corpus, without crawling (PRD 5.6.x).
 *
 * A crawl of an authenticated help centre is expensive and, on a big site,
 * slow: 1,400 pages at one request a second is most of half an hour, and it can
 * only run in a browser signed in to that site. An export captures the result;
 * this puts it back.
 *
 * What it does *not* import is the vectors. The export carries text only, and
 * embeddings are recomputed here with whatever model is currently selected —
 * which is the point rather than an omission: vectors from different models
 * aren't comparable, so importing them would either pin the index to the
 * exporting machine's model or produce an index that silently returns nonsense
 * (5.5.1). Re-embedding is also the only slow part, so progress is reported.
 *
 * Uses: restoring an index after a wipe or a failed re-crawl, moving one to
 * another machine, and putting the same corpus in front of several people
 * without each of them crawling the site.
 */

import type { SherpaDatabase } from "@/storage/db.js";
import type { StoredChunk, IndexMeta } from "@/domain/records.js";
import { SCHEMA_VERSION } from "@/domain/records.js";
import { parseCrawlConfig } from "@/domain/config.js";
import { indexRepo } from "@/storage/indexRepo.js";
import { chunkStore } from "@/storage/chunks.js";
import { vectorStore } from "@/storage/vectors.js";
import { bm25Store } from "@/storage/bm25Store.js";
import { estimateIndexBytes } from "@/storage/quota.js";
import { getEmbedder } from "@/embed/embedder.js";
import type { CorpusExport } from "@/storage/corpusExport.js";

export interface ImportProgress {
  readonly phase: "reading" | "embedding" | "indexing" | "done" | "error";
  readonly done: number;
  readonly total: number;
  readonly host: string;
  readonly error?: string;
}

/**
 * Chunks embedded per batch.
 *
 * Small enough that progress moves visibly and a failure loses little, large
 * enough that per-call overhead doesn't dominate. The crawl path embeds a page
 * at a time for the same reason.
 */
const EMBED_BATCH = 32;

/**
 * The index id to import into.
 *
 * Reuses the exported id when nothing else holds it, so exporting and
 * re-importing the same site round-trips to the same index rather than
 * accumulating duplicates. When the id *is* taken, the import replaces that
 * index's content — matching what "restore this backup" means, and what a full
 * re-crawl already does with the same id.
 */
export function importIndexId(corpus: CorpusExport): string {
  return corpus.indexId || `${corpus.host}-import`;
}

export async function importCorpus(
  db: SherpaDatabase,
  corpus: CorpusExport,
  post: (progress: ImportProgress) => void,
  now: () => number = () => Date.now(),
): Promise<void> {
  const host = corpus.host;
  const indexId = importIndexId(corpus);
  const total = corpus.chunks.length;

  try {
    post({ phase: "reading", done: 0, total, host });

    const embedder = await getEmbedder();

    // Replace rather than merge: an import is a restore, and merging would
    // leave orphaned chunks from whatever was there before with no way to tell
    // which vectors belonged to which.
    await indexRepo.clearContent(db, indexId);

    const chunks: StoredChunk[] = corpus.chunks.map((c, i) => ({
      indexId,
      // Renumbered from zero: vector ids are positions in this index's shard
      // array, so they must be dense and start at 0 regardless of what the
      // exporting index happened to use.
      vectorId: i,
      text: c.text,
      body: c.body,
      url: c.url,
      anchor: undefined,
      headingPath: c.headingPath,
      position: c.position,
      title: c.title,
      contentHash: c.contentHash,
    }));

    for (let start = 0; start < chunks.length; start += EMBED_BATCH) {
      const batch = chunks.slice(start, start + EMBED_BATCH);
      const flat = await embedder.embed(batch.map((c) => c.text));
      await vectorStore.append(db, indexId, flat, embedder.dim);
      post({ phase: "embedding", done: Math.min(start + batch.length, total), total, host });
    }

    post({ phase: "indexing", done: total, total, host });
    await chunkStore.putBatch(db, chunks);
    await bm25Store.build(
      db,
      indexId,
      chunks.map((c) => ({
        id: c.vectorId,
        title: c.title,
        section: c.headingPath,
        content: c.body,
      })),
    );

    const pageCount = new Set(chunks.map((c) => c.url)).size;
    const existing = await indexRepo.get(db, indexId);
    const meta: IndexMeta = {
      id: indexId,
      root: corpus.root,
      host,
      title: existing?.title || host,
      pageCount,
      chunkCount: chunks.length,
      sizeBytes: estimateIndexBytes(pageCount),
      createdAt: existing?.createdAt ?? now(),
      lastIndexedAt: now(),
      schemaVersion: SCHEMA_VERSION,
      // Stamped with the model that just ran, not the one that exported —
      // these are the vectors actually in the store.
      embeddingModel: embedder.modelId,
      // A config keeps Refresh working on an imported index. Exports written
      // before the config was carried fall back to a plain crawl of the root.
      config: corpus.config ?? existing?.config ?? parseCrawlConfig({ root: corpus.root }),
    };
    await indexRepo.upsert(db, meta);

    post({ phase: "done", done: total, total, host });
  } catch (error) {
    post({
      phase: "error",
      done: 0,
      total,
      host,
      error: error instanceof Error ? error.message : "import failed",
    });
    throw error;
  }
}
