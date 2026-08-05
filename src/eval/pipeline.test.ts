/**
 * End-to-end retrieval eval (PRD §7). Runs the golden set and the adversarial
 * set through the *real* retrieval path — sharded vectors, persisted BM25, RRF
 * fusion, page dedupe, neighbour expansion, refusal floor — and asserts the
 * release gate: Recall@5 ≥ 0.85 (M1) and false-answer rate ≤ 0.03 (M3).
 *
 * The embedder is the deterministic fixture one (see fixtures/embedder.ts), so
 * this measures the pipeline rather than the model.
 */

import "fake-indexeddb/auto";
import { describe, it, expect, beforeAll } from "vitest";
import { openSherpaDb, type SherpaDatabase } from "@/storage/db.js";
import { chunkStore } from "@/storage/chunks.js";
import { vectorStore } from "@/storage/vectors.js";
import { bm25Store } from "@/storage/bm25Store.js";
import { retrieve } from "@/retrieval/retrieve.js";
import { invalidateSession } from "@/retrieval/session.js";
import type { StoredChunk } from "@/domain/records.js";
import { CORPUS, GOLDEN, ADVERSARIAL, embeddedText } from "./fixtures/corpus.js";
import { fixtureEmbedder, FIXTURE_DIM } from "./fixtures/embedder.js";
import { runRetrievalEval, runAdversarialEval, passesGate } from "./harness.js";
import { DEFAULT_REFUSAL_FLOOR } from "@/settings/settings.js";

const INDEX = "eval";
// The shipped default, imported so the gate always measures what users get.
const FLOOR = DEFAULT_REFUSAL_FLOOR;

let db: SherpaDatabase;

beforeAll(async () => {
  db = await openSherpaDb("eval-corpus");
  invalidateSession();

  const flat = await fixtureEmbedder.embed(CORPUS.map(embeddedText));
  await vectorStore.append(db, INDEX, flat, FIXTURE_DIM);

  // Position is per page, so neighbour expansion behaves as it does in a crawl.
  const positions = new Map<string, number>();
  const chunks: StoredChunk[] = CORPUS.map((c) => {
    const position = positions.get(c.url) ?? 0;
    positions.set(c.url, position + 1);
    return {
      indexId: INDEX,
      vectorId: c.id,
      text: embeddedText(c),
      body: c.body,
      url: c.url,
      anchor: undefined,
      headingPath: c.headingPath,
      position,
      title: c.headingPath.split(" > ").pop() ?? "",
      contentHash: `h${c.id}`,
    };
  });
  await chunkStore.putBatch(db, chunks);
  await bm25Store.build(
    db,
    INDEX,
    chunks.map((c) => ({
      id: c.vectorId,
      title: c.title,
      section: c.headingPath,
      content: c.body,
    })),
  );
});

/**
 * Retrieval now returns articles; recall is still measured over the chunks that
 * actually matched, so the metric means the same thing it did before.
 */
async function retrieveIds(query: string): Promise<number[]> {
  const result = await retrieve({ db, indexId: INDEX, embedder: fixtureEmbedder }, query);
  return result.articles.flatMap((a) =>
    a.chunks.filter((c) => !c.viaNeighbour).map((c) => c.vectorId),
  );
}

/** The product's own answer/refuse decision (5.8.8). */
async function didAnswer(query: string): Promise<boolean> {
  const result = await retrieve({ db, indexId: INDEX, embedder: fixtureEmbedder }, query);
  return result.articles.length > 0 && result.topScore >= FLOOR;
}

describe("retrieval eval (M1, M2)", () => {
  it("meets the Recall@5 release gate", async () => {
    const report = await runRetrievalEval(GOLDEN, retrieveIds);
    expect(report.n).toBe(GOLDEN.length);
    expect(report.recallAt[5]).toBeGreaterThanOrEqual(0.85);
  });

  it("puts a relevant chunk first for most queries", async () => {
    const report = await runRetrievalEval(GOLDEN, retrieveIds);
    expect(report.hitAt[1]).toBeGreaterThanOrEqual(0.7);
  });

  it("delivers every labelled chunk of a two-part answer to the generator", async () => {
    // "skipped rows vs validation failure" is labelled against two chunks. One
    // is a direct hit and the other arrives through neighbour expansion — what
    // matters for groundedness is that the assembled context holds both, not
    // which retriever surfaced each (PRD 5.7.5).
    const result = await retrieve(
      { db, indexId: INDEX, embedder: fixtureEmbedder },
      "difference between skipped rows and validation failure",
    );
    const delivered = result.articles.flatMap((a) => a.chunks.map((c) => c.vectorId));
    expect(delivered).toContain(5);
    expect(delivered).toContain(6);
  });

  it("retrieves on an exact term that dense similarity alone would miss", async () => {
    // BM25's half of the hybrid is what makes an error code findable (5.7.1).
    expect((await retrieveIds("AUTH-403")).slice(0, 3)).toContain(3);
  });
});

describe("adversarial eval (M3)", () => {
  it("keeps the false-answer rate at or below the gate", async () => {
    const report = await runAdversarialEval(ADVERSARIAL, didAnswer);
    expect(report.n).toBe(ADVERSARIAL.length);
    expect(report.falseAnswerRate).toBeLessThanOrEqual(0.03);
  });
});

describe("release gate", () => {
  it("passes with the current pipeline", async () => {
    const retrieval = await runRetrievalEval(GOLDEN, retrieveIds);
    const adversarial = await runAdversarialEval(ADVERSARIAL, didAnswer);
    expect(passesGate(retrieval, adversarial)).toBe(true);
  });
});
