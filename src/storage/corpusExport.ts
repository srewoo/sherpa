/**
 * A crawled index, exported so the eval can run against it outside the browser.
 *
 * The index lives in IndexedDB inside the extension, which is exactly where an
 * offline harness cannot reach it. Rather than reimplement crawling in Node —
 * which would measure a *different* corpus from the one users query, and drift
 * from it — the extension writes its chunks out and the harness reads them in.
 *
 * Vectors are deliberately **not** exported. They are recomputed from the text
 * by whichever model the harness is testing, which is what makes "does bge beat
 * MiniLM on our questions" answerable at all, and keeps the export small enough
 * to commit next to the question set.
 */

/**
 * Moved here from `src/eval/`.
 *
 * It reads as eval infrastructure and is not: three shipping code paths depend
 * on it — the options page's export button, the offscreen import job, and the
 * message handler that starts one. Leaving it under `eval/` meant production
 * imported the eval harness, which pulls fixtures toward the bundle and, worse,
 * lets the thing being measured and the thing doing the measuring share a
 * module. The eval still uses it, from here, which is the right direction.
 */

import { z } from "zod";
import type { IndexMeta, StoredChunk } from "@/domain/records.js";
import { crawlConfigSchema } from "@/domain/config.js";

export const exportedChunkSchema = z.object({
  vectorId: z.number().int(),
  /** The embedded form: breadcrumb + heading prefix + body. */
  text: z.string(),
  /** What a reader sees, and what coverage is measured against. */
  body: z.string(),
  url: z.string(),
  headingPath: z.string(),
  title: z.string(),
  position: z.number().int(),
  contentHash: z.string(),
});

export const corpusExportSchema = z.object({
  /** Schema version of the export itself, so an old file fails loudly. */
  version: z.literal(1),
  indexId: z.string(),
  host: z.string(),
  root: z.string(),
  /** The model that built the index this came from — provenance, not a constraint. */
  embeddingModel: z.string().optional(),
  /**
   * The crawl config, so an imported index can be refreshed later rather than
   * being a dead snapshot. Optional because exports written before this existed
   * are still valid — import synthesises a config from `root` when it's absent.
   */
  config: crawlConfigSchema.optional(),
  exportedAt: z.number(),
  pageCount: z.number().int(),
  chunks: z.array(exportedChunkSchema),
});

export type ExportedChunk = z.infer<typeof exportedChunkSchema>;
export type CorpusExport = z.infer<typeof corpusExportSchema>;

export const CORPUS_EXPORT_VERSION = 1;

/** Parse an export, failing with a message that says what's wrong. */
export function parseCorpusExport(json: unknown): CorpusExport {
  const parsed = corpusExportSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`not a Sherpa corpus export — ${issues}`);
  }
  return parsed.data;
}

/**
 * Build an export from a live index. Pure, so the shape is testable without a
 * browser — the page supplies the rows it read from IndexedDB.
 */
export function buildCorpusExport(
  meta: IndexMeta,
  chunks: readonly StoredChunk[],
  now: number,
): CorpusExport {
  return {
    version: CORPUS_EXPORT_VERSION,
    indexId: meta.id,
    host: meta.host,
    root: meta.root,
    ...(meta.embeddingModel ? { embeddingModel: meta.embeddingModel } : {}),
    ...(meta.config ? { config: meta.config } : {}),
    exportedAt: now,
    pageCount: meta.pageCount,
    // Position order per page, so an export diffs cleanly across re-crawls
    // instead of reshuffling every time chunk ids are reassigned.
    chunks: [...chunks]
      .sort((a, b) => a.url.localeCompare(b.url) || a.position - b.position)
      .map((c) => ({
        vectorId: c.vectorId,
        text: c.text,
        body: c.body,
        url: c.url,
        headingPath: c.headingPath,
        title: c.title,
        position: c.position,
        contentHash: c.contentHash,
      })),
  };
}

/** Every distinct article URL in the corpus, for sanity-checking question labels. */
export function articleUrls(corpus: CorpusExport): string[] {
  return [...new Set(corpus.chunks.map((c) => c.url))];
}
