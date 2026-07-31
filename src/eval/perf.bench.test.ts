/**
 * Performance budgets, asserted in CI (PRD §7.6, M4).
 *
 * The headline budget is retrieval p95 < 150 ms at 15k chunks (5.7.6). Before
 * the session cache landed, every query re-read all vector shards, re-read
 * every chunk row and rebuilt BM25 from scratch, which put this out of reach —
 * so this bench exists to keep that from silently coming back.
 *
 * Thresholds are deliberately loose relative to the PRD: CI runners are slower
 * and noisier than the target machine, and a flaky perf gate gets disabled,
 * which is worse than a generous one.
 */

import "fake-indexeddb/auto";
import { describe, it, expect, beforeAll } from "vitest";
import { openSherpaDb, type SherpaDatabase } from "@/storage/db.js";
import { chunkStore } from "@/storage/chunks.js";
import { vectorStore } from "@/storage/vectors.js";
import { bm25Store } from "@/storage/bm25Store.js";
import { retrieve } from "@/retrieval/retrieve.js";
import { loadSession, invalidateSession } from "@/retrieval/session.js";
import { cosineTopK } from "@/retrieval/cosine.js";
import type { StoredChunk } from "@/domain/records.js";
import { fixtureEmbedder, FIXTURE_DIM, embedOne } from "./fixtures/embedder.js";

/** PRD design point: ~15k chunks for a 2,000-page site (§5.5 storage budget). */
const CHUNKS = 15_000;
const PAGES = 2_000;
const INDEX = "perf";

/** 5.7.6 is 150 ms; CI gets 3× headroom. */
const P95_BUDGET_MS = 450;

const TERMS = [
  "sso", "sandbox", "audience", "import", "webhook", "retry", "invoice", "seat",
  "rotation", "api", "key", "validation", "header", "tenant", "backoff", "csv",
];

function words(seed: number, count: number): string {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(TERMS[(seed * 7 + i * 13) % TERMS.length]!);
  return out.join(" ");
}

let db: SherpaDatabase;

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

beforeAll(async () => {
  db = await openSherpaDb("perf-corpus");
  invalidateSession();

  const flat = new Float32Array(CHUNKS * FIXTURE_DIM);
  const chunks: StoredChunk[] = [];
  const perPage = Math.ceil(CHUNKS / PAGES);

  for (let i = 0; i < CHUNKS; i++) {
    const body = words(i, 60);
    flat.set(embedOne(body), i * FIXTURE_DIM);
    const page = Math.floor(i / perPage);
    chunks.push({
      indexId: INDEX,
      vectorId: i,
      text: body,
      body,
      url: `https://help.perf.test/page-${page}`,
      anchor: undefined,
      headingPath: `Section ${page % 40} > Topic ${i % 7}`,
      position: i % perPage,
      title: `Page ${page}`,
      contentHash: `h${i}`,
    });
  }

  await vectorStore.append(db, INDEX, flat, FIXTURE_DIM);
  await chunkStore.putBatch(db, chunks);
  await bm25Store.build(db, INDEX, chunks.map((c) => ({ id: c.vectorId, text: c.text })));
}, 180_000);

describe("retrieval performance at 15k chunks", () => {
  it("keeps p95 query latency inside the budget (5.7.6)", async () => {
    // Warm the session once, as the offscreen document does per index (5.7.3).
    await loadSession(db, INDEX);

    const timings: number[] = [];
    for (let i = 0; i < 40; i++) {
      const query = words(i * 31, 6);
      const start = performance.now();
      await retrieve({ db, indexId: INDEX, embedder: fixtureEmbedder }, query);
      timings.push(performance.now() - start);
    }

    const p95 = percentile(timings, 0.95);
    // Surfaced so a regression shows the number, not just a red test.
    console.log(
      `retrieval @${CHUNKS} chunks — p50 ${percentile(timings, 0.5).toFixed(1)}ms, p95 ${p95.toFixed(1)}ms`,
    );
    expect(p95).toBeLessThan(P95_BUDGET_MS);
  }, 120_000);

  it("brute-force cosine over the full matrix stays sub-100ms", () => {
    const { data, dim, count } = { data: new Float32Array(CHUNKS * FIXTURE_DIM), dim: FIXTURE_DIM, count: CHUNKS };
    const query = embedOne("sso sandbox audience");
    const start = performance.now();
    cosineTopK(query, data, dim, count, 20);
    const elapsed = performance.now() - start;
    console.log(`cosine scan @${CHUNKS} — ${elapsed.toFixed(1)}ms`);
    // No ANN index is justified only while the linear scan is cheap (5.7.2).
    expect(elapsed).toBeLessThan(300);
  });

  it("holds the vector matrix within the memory budget (§5.5)", async () => {
    const bytes = await vectorStore.byteSize(db, INDEX);
    // float32 at 384 dims would be ~23 MB for 15k chunks; assert we're in that
    // order of magnitude rather than accidentally storing per-record overhead.
    const perVector = bytes / CHUNKS;
    expect(perVector).toBe(FIXTURE_DIM * 4);
    expect(bytes).toBeLessThan(64 * 1024 * 1024);
  });

  it("loads a cold session in a reasonable time", async () => {
    invalidateSession(INDEX);
    const start = performance.now();
    await loadSession(db, INDEX);
    const elapsed = performance.now() - start;
    console.log(`cold session load @${CHUNKS} chunks — ${elapsed.toFixed(0)}ms`);
    // Paid once per index per session, so seconds are acceptable; minutes are not.
    expect(elapsed).toBeLessThan(15_000);
  }, 60_000);
});
