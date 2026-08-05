/**
 * Does the cross-encoder earn its latency? (`npm run eval:rerank`)
 *
 * The reranker ships switched off and its weights are an opt-in fetch, so the
 * honest position until now was "we don't know". This measures the same
 * known-item set with the second stage off and on, on one corpus, and reports
 * both the ranking change and what it costs per query.
 *
 * eGain is the interesting corpus to run it against. Its help centre is built
 * from dozens of near-synonymous sibling articles — "Restricting Application
 * Consoles Access" beside "Restricting Access to Customer Consoles" — which is
 * precisely the case a bi-encoder cannot resolve: the two passages are similar
 * to each other, and the question of which one *answers* the query is not a
 * question about similarity at all. If reranking doesn't help here it doesn't
 * help anywhere.
 *
 *   SHERPA_ABLATION_HOST=help.egain.com SHERPA_SAMPLE=80 npm run eval:rerank
 */

import "fake-indexeddb/auto";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it, expect } from "vitest";

import { openSherpaDb } from "@/storage/db.js";
import { chunkStore } from "@/storage/chunks.js";
import { vectorStore } from "@/storage/vectors.js";
import { bm25Store } from "@/storage/bm25Store.js";
import { retrieve } from "@/retrieval/retrieve.js";
import { invalidateSession, loadSession } from "@/retrieval/session.js";
import { createEmbedder } from "@/embed/embedder.js";
import { createReranker } from "@/retrieval/rerank.js";
import { findModel, DEFAULT_EMBEDDING_MODEL_ID } from "@/embed/models.js";
import type { StoredChunk } from "@/domain/records.js";

import { parseCorpusExport, type CorpusExport } from "./corpusExport.js";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const CORPUS_DIR = join(ROOT, "eval");
const MODEL_ID = process.env["SHERPA_MODEL_ID"] ?? DEFAULT_EMBEDDING_MODEL_ID;
const SAMPLE = Number(process.env["SHERPA_SAMPLE"] ?? 80);
const HOST = process.env["SHERPA_ABLATION_HOST"] ?? "help.egain.com";

function mulberry(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sample<T>(items: readonly T[], n: number, seed: number): T[] {
  const rand = mulberry(seed);
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, n);
}

function loadCache(): Map<string, number[]> {
  const path = join(ROOT, ".eval-cache", `${MODEL_ID.replace(/\//g, "_")}.json`);
  if (!existsSync(path)) return new Map();
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(path, "utf8")) as Record<string, number[]>));
  } catch {
    return new Map();
  }
}

const files = existsSync(CORPUS_DIR)
  ? readdirSync(CORPUS_DIR).filter((f) => f.startsWith("sherpa-corpus-") && f.endsWith(".json"))
  : [];

describe.skipIf(files.length === 0)("rerank ablation", () => {
  it(
    "compares first-stage ranking against cross-encoder reranking",
    async () => {
      let corpus: CorpusExport | undefined;
      for (const f of files) {
        const c = parseCorpusExport(JSON.parse(readFileSync(join(CORPUS_DIR, f), "utf8")));
        if (c.host !== HOST) continue;
        if (!corpus || c.exportedAt > corpus.exportedAt) corpus = c;
      }
      expect(corpus, `no corpus for ${HOST}`).toBeDefined();
      const cx = corpus!;

      const embedder = await createEmbedder(findModel(MODEL_ID), {
        models: join(ROOT, "public/models/"),
        ort: join(ROOT, "public/ort/"),
      });

      const cache = loadCache();
      const chunks: StoredChunk[] = cx.chunks.map((c) => ({
        indexId: HOST,
        vectorId: c.vectorId,
        text: c.text,
        body: c.body,
        url: c.url,
        anchor: undefined,
        headingPath: c.headingPath,
        position: c.position,
        title: c.title,
        contentHash: c.contentHash,
      }));

      const flat = new Float32Array(chunks.length * embedder.dim);
      const todo: number[] = [];
      chunks.forEach((c, i) => {
        const hit = cache.get(c.contentHash);
        if (hit && hit.length === embedder.dim) flat.set(hit, i * embedder.dim);
        else todo.push(i);
      });
      if (todo.length > 0) {
        process.stdout.write(`embedding ${todo.length} uncached chunks…\n`);
        for (let s = 0; s < todo.length; s += 32) {
          const slice = todo.slice(s, s + 32);
          const out = await embedder.embed(slice.map((i) => chunks[i]!.text));
          slice.forEach((ci, j) =>
            flat.set(out.subarray(j * embedder.dim, (j + 1) * embedder.dim), ci * embedder.dim),
          );
        }
      }

      const db = await openSherpaDb(`ablation-${HOST}`);
      invalidateSession();
      await vectorStore.append(db, HOST, flat, embedder.dim);
      await chunkStore.putBatch(db, chunks);
      await bm25Store.build(
        db,
        HOST,
        chunks.map((c) => ({ id: c.vectorId, title: c.title, section: c.headingPath, content: c.body })),
      );
      const session = await loadSession(db, HOST);

      const byUrl = new Map<string, string>();
      for (const c of cx.chunks) {
        const t = c.title.trim();
        if (t.length < 12 || t.length > 110) continue;
        if (!byUrl.has(c.url)) byUrl.set(c.url, t);
      }
      const known = sample([...byUrl].map(([url, title]) => ({ url, title })), SAMPLE, 42);

      const reranker = await createReranker({
        models: join(ROOT, "public/models/"),
        ort: join(ROOT, "public/ort/"),
      });

      const measure = async (useRerank: boolean) => {
        const hit = { 1: 0, 3: 0, 5: 0 };
        let rr = 0;
        const times: number[] = [];
        for (const { title, url } of known) {
          const t0 = performance.now();
          const r = await retrieve({
            db,
            indexId: HOST,
            embedder,
            session,
            ...(useRerank ? { rerank: reranker } : {}),
          }, title);
          times.push(performance.now() - t0);
          const rank = r.articles.map((a) => a.url).indexOf(url);
          if (rank === 0) hit[1]++;
          if (rank >= 0 && rank < 3) hit[3]++;
          if (rank >= 0 && rank < 5) hit[5]++;
          if (rank >= 0) rr += 1 / (rank + 1);
        }
        const sorted = times.sort((a, b) => a - b);
        return {
          hit1: hit[1] / known.length,
          hit3: hit[3] / known.length,
          hit5: hit[5] / known.length,
          mrr: rr / known.length,
          p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
          p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
        };
      };

      process.stdout.write(`\nrerank ablation — ${HOST}, ${known.length} known-item queries\n\n`);
      const off = await measure(false);
      const on = await measure(true);

      const pct = (x: number): string => `${(x * 100).toFixed(1)}%`.padStart(8);
      const ms = (x: number): string => `${x.toFixed(0)}ms`.padStart(9);
      const rows = [
        "  stage            hit@1    hit@3    hit@5      MRR        p50        p95",
        `  first-stage  ${pct(off.hit1)} ${pct(off.hit3)} ${pct(off.hit5)}  ${off.mrr.toFixed(3)} ${ms(off.p50)} ${ms(off.p95)}`,
        `  + rerank     ${pct(on.hit1)} ${pct(on.hit3)} ${pct(on.hit5)}  ${on.mrr.toFixed(3)} ${ms(on.p50)} ${ms(on.p95)}`,
        "",
        `  hit@1 ${on.hit1 >= off.hit1 ? "+" : ""}${((on.hit1 - off.hit1) * 100).toFixed(1)} points   ` +
          `MRR ${on.mrr >= off.mrr ? "+" : ""}${(on.mrr - off.mrr).toFixed(3)}   ` +
          `latency ×${(on.p50 / Math.max(off.p50, 0.001)).toFixed(1)}`,
      ];
      process.stdout.write(rows.join("\n") + "\n");
    },
    30 * 60_000,
  );
});
