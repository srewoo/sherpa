/**
 * Multi-corpus calibration against real crawled help sites (`npm run eval:sites`).
 *
 * Why this exists alongside `real.eval.ts`: that harness needs a hand-labelled
 * question set, and labelling is slow. This one derives its labels from the
 * corpora themselves, so a freshly crawled site can be measured the same day it
 * is crawled. It answers one question the project could not previously answer at
 * all — **where does the refusal floor belong for the model users actually run** —
 * and it measures retrieval and latency at real scale on the way.
 *
 * Three question sets per site, all labelled by construction:
 *
 *   known-item    An article's own title, asked against its own index. Labelled
 *                 with that URL. This is the *upper bound* on retrieval, not a
 *                 user-realism test — a title is the docs' own words, and the
 *                 vocabulary mismatch that breaks real help search is exactly
 *                 what it cannot see. Read it as "can the index find a page when
 *                 you name it", and read hand-labelled sets for the rest.
 *
 *   cross-site    Another site's *brand-specific* titles, asked against this
 *                 index. "Gong Call Spotlight" is genuinely not in eGain's docs,
 *                 so these are honest negatives — and they are hard ones, being
 *                 real help-centre prose about a neighbouring product.
 *
 *   off-domain    Questions from nowhere near a help centre. Trivially
 *                 unanswerable; they locate the model's noise floor, which is
 *                 the number that makes a threshold interpretable.
 *
 * The floor sweep then reads the answerable and unanswerable score distributions
 * apart. Everything is per-site: cosine distributions shift with corpus size and
 * subject matter, so one global number is a compromise between three answers.
 *
 *   npm run eval:sites
 *   SHERPA_SAMPLE=150 npm run eval:sites     # questions per set, per site
 */

import "fake-indexeddb/auto";
import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it, expect } from "vitest";

import { openSherpaDb } from "@/storage/db.js";
import { chunkStore } from "@/storage/chunks.js";
import { vectorStore } from "@/storage/vectors.js";
import { bm25Store } from "@/storage/bm25Store.js";
import { retrieve } from "@/retrieval/retrieve.js";
import { invalidateSession, loadSession } from "@/retrieval/session.js";
import { createEmbedder, type Embedder } from "@/embed/embedder.js";
import { findModel, DEFAULT_EMBEDDING_MODEL_ID } from "@/embed/models.js";
import type { StoredChunk } from "@/domain/records.js";

import { parseCorpusExport, type CorpusExport } from "@/storage/corpusExport.js";
import { sweepFloors, recommendFloor, formatFloorSweep, type FloorCase } from "./floorSweep.js";
import { calibrateFloors } from "@/retrieval/calibrate.js";

/** Mirrors CALIBRATION_TITLE_SAMPLES in runCrawlJob, so this measures what ships. */
const CALIBRATION_TITLE_SAMPLES = 20;

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const CORPUS_DIR = join(ROOT, "eval");
const MODEL_ID = process.env["SHERPA_MODEL_ID"] ?? DEFAULT_EMBEDDING_MODEL_ID;
const SAMPLE = Number(process.env["SHERPA_SAMPLE"] ?? 120);

/**
 * Deterministic sampling. `Math.random` would make every run disagree with the
 * last by a couple of points and turn "did my change help" into a coin toss.
 */
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

/** Vectors are cached by (model, content hash) — a re-run costs seconds. */
function cachePath(): string {
  return join(ROOT, ".eval-cache", `${MODEL_ID.replace(/\//g, "_")}.json`);
}

function loadCache(): Map<string, number[]> {
  const path = cachePath();
  if (!existsSync(path)) return new Map();
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(path, "utf8")) as Record<string, number[]>));
  } catch {
    return new Map();
  }
}

async function embedCorpus(
  embedder: Embedder,
  chunks: readonly StoredChunk[],
  cache: Map<string, number[]>,
): Promise<Float32Array> {
  const out = new Float32Array(chunks.length * embedder.dim);
  const todo: number[] = [];

  chunks.forEach((chunk, i) => {
    const hit = cache.get(chunk.contentHash);
    if (hit && hit.length === embedder.dim) out.set(hit, i * embedder.dim);
    else todo.push(i);
  });

  if (todo.length > 0) {
    process.stdout.write(`  embedding ${todo.length} of ${chunks.length} chunks…\n`);
    const BATCH = 32;
    const started = Date.now();
    for (let start = 0; start < todo.length; start += BATCH) {
      const slice = todo.slice(start, start + BATCH);
      const flat = await embedder.embed(slice.map((i) => chunks[i]!.text));
      slice.forEach((chunkIndex, j) => {
        const v = flat.subarray(j * embedder.dim, (j + 1) * embedder.dim);
        out.set(v, chunkIndex * embedder.dim);
        cache.set(chunks[chunkIndex]!.contentHash, [...v]);
      });
      if (start > 0 && start % (BATCH * 25) === 0) {
        const rate = (start / ((Date.now() - started) / 1000)).toFixed(0);
        process.stdout.write(`    ${start}/${todo.length}  (${rate}/s)\n`);
      }
    }
  }
  return out;
}

/**
 * Titles naming something specific to one product.
 *
 * A cross-site negative is only honest if the answer genuinely isn't in the
 * index being asked. "How do I reset my password" is in all three help centres,
 * so using it as a negative would punish a correct answer. Requiring the host's
 * own brand token keeps the set to questions that are unambiguously about
 * somewhere else.
 */
function brandTitles(corpus: CorpusExport, brand: string): string[] {
  const re = new RegExp(`\\b${brand}\\b`, "i");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of corpus.chunks) {
    const t = c.title.trim();
    if (t.length < 12 || t.length > 110 || seen.has(t)) continue;
    if (!re.test(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** One title per article, for the known-item set. */
function articleTitles(corpus: CorpusExport): { title: string; url: string }[] {
  const byUrl = new Map<string, string>();
  for (const c of corpus.chunks) {
    const t = c.title.trim();
    if (t.length < 12 || t.length > 110) continue;
    if (!byUrl.has(c.url)) byUrl.set(c.url, t);
  }
  return [...byUrl].map(([url, title]) => ({ title, url }));
}

/** Nowhere near a help centre — these locate the model's noise floor. */
const OFF_DOMAIN = [
  "what is the boiling point of water at altitude",
  "who won the world cup in 1998",
  "how do I braise short ribs",
  "what is the capital of Mongolia",
  "explain the offside rule in football",
  "when should I prune apple trees",
  "how many strings does a cello have",
  "what causes the northern lights",
  "best way to remove a coffee stain from linen",
  "how long does it take to fly to Tokyo",
  "what is the difference between a crocodile and an alligator",
  "how do noise cancelling headphones work",
  "what year did the Berlin Wall fall",
  "how do I change a bicycle inner tube",
  "what is the tallest mountain in Africa",
];

/**
 * Plausible questions a help centre is unlikely to answer.
 *
 * The off-domain set locates the model's noise floor and nothing else — nobody
 * asks a documentation site about the offside rule. The wrong question users
 * actually ask is *on topic and uncovered*: pricing, contracts, roadmap,
 * procurement. Those live far higher up the score range, and they are what a
 * refusal floor has to clear. Deliberately commercial rather than technical, so
 * a product help centre is unlikely to document them.
 */
const HARD_PROBES = [
  "how much does the enterprise plan cost per user",
  "what is the uptime SLA in our contract",
  "how do I get a refund for unused licences",
  "when will dark mode be released",
  "how does this compare to the competing product",
  "who is the account manager for my company",
  "what is the notice period for cancelling our subscription",
  "can I get a SOC 2 report for procurement",
  "what is on the product roadmap for next quarter",
  "how do I become a reseller partner",
  "what are the payment terms for annual invoicing",
  "is there a discount for non-profit organisations",
  "how many employees does the company have",
  "where are the company offices located",
  "who founded the company and when",
];

const BRANDS: Record<string, string> = {
  "help.egain.com": "eGain",
  "help.gong.io": "Gong",
  "help.mindtickle.com": "Mindtickle",
};

interface SiteResult {
  readonly host: string;
  readonly pages: number;
  readonly chunks: number;
  readonly hit: Record<number, number>;
  readonly mrr: number;
  readonly answerable: number[];
  readonly crossSite: number[];
  readonly offDomain: number[];
  readonly hardProbe: number[];
  readonly latency: { p50: number; p95: number; cold: number };
  readonly recommended: number | null;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function describeDist(label: string, xs: readonly number[]): string {
  const s = [...xs].sort((a, b) => a - b);
  return (
    `  ${label.padEnd(12)} n=${String(s.length).padStart(4)}  ` +
    `min ${quantile(s, 0).toFixed(3)}  p25 ${quantile(s, 0.25).toFixed(3)}  ` +
    `median ${quantile(s, 0.5).toFixed(3)}  p75 ${quantile(s, 0.75).toFixed(3)}  ` +
    `p95 ${quantile(s, 0.95).toFixed(3)}  max ${quantile(s, 1).toFixed(3)}  ` +
    `mean ${mean(s).toFixed(3)}`
  );
}

const files = existsSync(CORPUS_DIR)
  ? readdirSync(CORPUS_DIR).filter((f) => f.startsWith("sherpa-corpus-") && f.endsWith(".json"))
  : [];

describe.skipIf(files.length === 0)("multi-site calibration", () => {
  it(
    "measures retrieval, latency and the refusal floor on every exported corpus",
    async () => {
      // Newest export wins when a host was exported more than once.
      const byHost = new Map<string, CorpusExport>();
      for (const f of files) {
        const corpus = parseCorpusExport(JSON.parse(readFileSync(join(CORPUS_DIR, f), "utf8")));
        const prev = byHost.get(corpus.host);
        if (!prev || corpus.exportedAt > prev.exportedAt) byHost.set(corpus.host, corpus);
      }
      const corpora = [...byHost.values()].sort((a, b) => a.chunks.length - b.chunks.length);
      expect(corpora.length).toBeGreaterThan(0);

      const embedder = await createEmbedder(findModel(MODEL_ID), {
        models: join(ROOT, "public/models/"),
        ort: join(ROOT, "public/ort/"),
      });
      const cache = loadCache();
      const results: SiteResult[] = [];

      for (const corpus of corpora) {
        process.stdout.write(`\n${corpus.host} — ${corpus.pageCount} pages, ${corpus.chunks.length} chunks\n`);

        const indexId = corpus.host;
        const chunks: StoredChunk[] = corpus.chunks.map((c) => ({
          indexId,
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

        const db = await openSherpaDb(`eval-${indexId}`);
        invalidateSession();
        await vectorStore.append(db, indexId, await embedCorpus(embedder, chunks, cache), embedder.dim);
        await chunkStore.putBatch(db, chunks);
        await bm25Store.build(
          db,
          indexId,
          chunks.map((c) => ({ id: c.vectorId, title: c.title, section: c.headingPath, content: c.body })),
        );

        // Cold load is a real user cost: it is paid on the first question after
        // the offscreen document starts, not amortised across a session.
        invalidateSession();
        const coldStart = Date.now();
        const session = await loadSession(db, indexId);
        const cold = Date.now() - coldStart;

        const ask = async (q: string): Promise<{ top: number; urls: string[]; ms: number }> => {
          const t0 = performance.now();
          const r = await retrieve({ db, indexId, embedder, session }, q);
          return { top: r.topScore, urls: r.articles.map((a) => a.url), ms: performance.now() - t0 };
        };

        // --- known-item -----------------------------------------------------
        const known = sample(articleTitles(corpus), SAMPLE, 42);
        const hit: Record<number, number> = { 1: 0, 3: 0, 5: 0 };
        const answerable: number[] = [];
        const latencies: number[] = [];
        let rr = 0;
        const floorCases: FloorCase[] = [];

        for (const { title, url } of known) {
          const { top, urls, ms } = await ask(title);
          latencies.push(ms);
          answerable.push(top);
          const rank = urls.indexOf(url);
          if (rank === 0) hit[1]!++;
          if (rank >= 0 && rank < 3) hit[3]!++;
          if (rank >= 0 && rank < 5) hit[5]!++;
          if (rank >= 0) rr += 1 / (rank + 1);
          floorCases.push({ topScore: top, answerable: true, retrieved: rank >= 0 });
        }

        // --- cross-site negatives ------------------------------------------
        const foreign = corpora
          .filter((c) => c.host !== corpus.host)
          .flatMap((c) => brandTitles(c, BRANDS[c.host] ?? c.host.split(".")[1] ?? ""));
        const crossQ = sample(foreign, SAMPLE, 7);
        const crossSite: number[] = [];
        for (const q of crossQ) {
          const { top, ms } = await ask(q);
          latencies.push(ms);
          crossSite.push(top);
          floorCases.push({ topScore: top, answerable: false, retrieved: false });
        }

        // --- off-domain negatives -------------------------------------------
        const offDomain: number[] = [];
        for (const q of OFF_DOMAIN) {
          const { top, ms } = await ask(q);
          latencies.push(ms);
          offDomain.push(top);
          floorCases.push({ topScore: top, answerable: false, retrieved: false });
        }

        // --- hard negatives: on topic, uncovered ----------------------------
        const hardProbe: number[] = [];
        for (const q of HARD_PROBES) {
          const { top, ms } = await ask(q);
          latencies.push(ms);
          hardProbe.push(top);
          floorCases.push({ topScore: top, answerable: false, retrieved: false });
        }

        const sortedLat = [...latencies].sort((a, b) => a - b);
        const sweep = sweepFloors(floorCases);
        const rec = recommendFloor(sweep, 0.03);

        process.stdout.write(formatFloorSweep(sweep) + "\n");

        results.push({
          host: corpus.host,
          pages: corpus.pageCount,
          chunks: corpus.chunks.length,
          hit: {
            1: hit[1]! / known.length,
            3: hit[3]! / known.length,
            5: hit[5]! / known.length,
          },
          mrr: rr / known.length,
          answerable,
          crossSite,
          offDomain,
          hardProbe,
          latency: { p50: quantile(sortedLat, 0.5), p95: quantile(sortedLat, 0.95), cold },
          recommended: rec?.floor ?? null,
        });
      }

      mkdirSync(join(ROOT, ".eval-cache"), { recursive: true });
      writeFileSync(cachePath(), JSON.stringify(Object.fromEntries(cache)));

      // ---- report ----------------------------------------------------------
      const out: string[] = ["", "=".repeat(78), "SHERPA MULTI-SITE CALIBRATION", "=".repeat(78), ""];
      out.push(`model    ${MODEL_ID}`);
      out.push(`sample   ${SAMPLE} known-item + ${SAMPLE} cross-site + ${OFF_DOMAIN.length} off-domain per site`);
      out.push("");

      out.push("RETRIEVAL (known-item: the article's own title — an upper bound)");
      out.push("  site                    pages  chunks   hit@1   hit@3   hit@5     MRR");
      for (const r of results) {
        out.push(
          `  ${r.host.padEnd(22)}${String(r.pages).padStart(6)}${String(r.chunks).padStart(8)}` +
            `${(r.hit[1]! * 100).toFixed(1).padStart(8)}%${(r.hit[3]! * 100).toFixed(1).padStart(7)}%` +
            `${(r.hit[5]! * 100).toFixed(1).padStart(7)}%${r.mrr.toFixed(3).padStart(8)}`,
        );
      }
      out.push("");

      out.push("LATENCY (per query, warm session)");
      out.push("  site                    chunks      p50       p95   cold load");
      for (const r of results) {
        out.push(
          `  ${r.host.padEnd(22)}${String(r.chunks).padStart(8)}` +
            `${r.latency.p50.toFixed(1).padStart(9)}ms${r.latency.p95.toFixed(1).padStart(8)}ms` +
            `${String(r.latency.cold).padStart(10)}ms`,
        );
      }
      out.push("");

      out.push("SCORE DISTRIBUTIONS (absolute cosine — what the floor compares against)");
      for (const r of results) {
        out.push(`  ${r.host}`);
        out.push(describeDist("answerable", r.answerable));
        out.push(describeDist("cross-site", r.crossSite));
        out.push(describeDist("off-domain", r.offDomain));
        out.push(describeDist("hard-probe", r.hardProbe));
        const negatives = [...r.crossSite, ...r.offDomain, ...r.hardProbe].sort((a, b) => a - b);
        const positives = [...r.answerable].sort((a, b) => a - b);
        out.push(
          `  ${"→ separation".padEnd(12)} answerable p05 ${quantile(positives, 0.05).toFixed(3)} ` +
            `vs negatives p95 ${quantile(negatives, 0.95).toFixed(3)}` +
            (quantile(positives, 0.05) > quantile(negatives, 0.95)
              ? "   (clean gap)"
              : "   (OVERLAP — no threshold separates these perfectly)"),
        );
        out.push("");
      }

      out.push("RECOMMENDED REFUSAL FLOOR (lowest meeting false-answer ≤ 3%)");
      for (const r of results) {
        out.push(`  ${r.host.padEnd(22)} ${r.recommended === null ? "none in sweep range" : r.recommended.toFixed(2)}`);
      }
      out.push("");

      /**
       * What the shipped calibration would actually choose.
       *
       * The sweep above is the *oracle*: it sees every label and picks the best
       * threshold in hindsight. The extension has no labels — it has fifteen
       * probe questions and its own titles, at the end of a crawl. This section
       * runs that real policy on the same scores and puts the two side by side,
       * because a calibration that cannot approximate its own oracle is not
       * worth shipping, and the only way to know is to print both.
       *
       * The probe set here *is* `PROBE_QUESTIONS`, so the negatives column is
       * the same measurement the browser will make.
       */
      out.push("SHIPPED CALIBRATION vs THE ORACLE");
      out.push("  site                   calibrated   confident   oracle   verdict");
      for (const r of results) {
        const c = calibrateFloors(
          {
            negativeScores: [...r.offDomain, ...r.hardProbe],
            positiveScores: r.answerable.slice(0, CALIBRATION_TITLE_SAMPLES),
          },
          Date.now(),
        );
        // Judged against the negatives it has to clear, not against the oracle:
        // matching the oracle exactly is luck, clearing the noise is the job.
        const negatives = [...r.crossSite, ...r.offDomain, ...r.hardProbe];
        const falseAnswers = negatives.filter((s) => s >= c.refuse).length;
        const verdict =
          falseAnswers / negatives.length <= 0.03
            ? "ok"
            : `${((falseAnswers / negatives.length) * 100).toFixed(0)}% false answers`;
        out.push(
          `  ${r.host.padEnd(22)} ${c.refuse.toFixed(3).padStart(10)}  ${c.confident
            .toFixed(3)
            .padStart(10)}  ${(r.recommended ?? 0).toFixed(2).padStart(7)}   ${verdict}`,
        );
      }
      out.push("");
      out.push("=".repeat(78));

      const report = out.join("\n");
      process.stdout.write(report + "\n");
      writeFileSync(join(ROOT, "eval", "calibration-report.txt"), report, "utf8");
    },
    30 * 60_000,
  );
});
