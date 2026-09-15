/**
 * The real eval (PRD §7.1). Run with `npm run eval`, not in CI.
 *
 *   SHERPA_CORPUS=eval/corpus.json \
 *   SHERPA_QUESTIONS=eval/questions.jsonl \
 *   npm run eval
 *
 * This loads the actual bge weights from `public/models`, embeds a real crawled
 * corpus, and drives the same `retrieve()` the extension calls. It is a script
 * wearing a test's clothes: vitest is here only because it already resolves the
 * `@/` aliases and TypeScript, not because this belongs in a test suite. It
 * takes minutes and needs data no repository should carry, so it skips itself
 * when the inputs are absent.
 *
 * Set SHERPA_API_KEY (and optionally SHERPA_PROVIDER/SHERPA_MODEL) to measure
 * generation as well as retrieval. Without it the run reports what retrieval
 * *made possible*, which is the faster loop while tuning chunking or fusion.
 */

import "fake-indexeddb/auto";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it, expect } from "vitest";

import { openSherpaDb } from "@/storage/db.js";
import { chunkStore } from "@/storage/chunks.js";
import { vectorStore } from "@/storage/vectors.js";
import { bm25Store } from "@/storage/bm25Store.js";
import { retrieve } from "@/retrieval/retrieve.js";
import { invalidateSession } from "@/retrieval/session.js";
import { createEmbedder, type Embedder } from "@/embed/embedder.js";
import { findModel, DEFAULT_EMBEDDING_MODEL_ID } from "@/embed/models.js";
import { DEFAULT_REFUSAL_FLOOR } from "@/settings/settings.js";
import { ByokGenerator } from "@/generator/byok.js";
import { isRefusal } from "@/generator/answerService.js";
import type { StoredChunk } from "@/domain/records.js";
import type { ByokProvider } from "@/domain/generator.js";

import { parseCorpusExport } from "@/storage/corpusExport.js";
import { parseQuestionSet } from "./questionSet.js";
import { runCase, summarize, formatReport, type EvalCaseResult } from "./realHarness.js";
import { sweepFloors, recommendFloor, formatFloorSweep, type FloorCase } from "./floorSweep.js";

const CORPUS_PATH = process.env["SHERPA_CORPUS"] ?? "eval/corpus.json";
const QUESTIONS_PATH = process.env["SHERPA_QUESTIONS"] ?? "eval/questions.jsonl";
const MODEL_ID = process.env["SHERPA_MODEL_ID"] ?? DEFAULT_EMBEDDING_MODEL_ID;
const FLOOR = Number(process.env["SHERPA_FLOOR"] ?? DEFAULT_REFUSAL_FLOOR);
const API_KEY = process.env["SHERPA_API_KEY"];
const PROVIDER = (process.env["SHERPA_PROVIDER"] ?? "anthropic") as ByokProvider;
const ANSWER_MODEL = process.env["SHERPA_ANSWER_MODEL"] ?? "claude-sonnet-5";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const INDEX = "eval";

const haveInputs = existsSync(CORPUS_PATH) && existsSync(QUESTIONS_PATH);

/**
 * Embedding a few thousand chunks takes minutes, and the whole point of this
 * harness is a loop you'll actually re-run after a change. Vectors are cached
 * by (model, content hash) so only genuinely new text is recomputed.
 */
function cachePath(): string {
  return join(ROOT, ".eval-cache", `${MODEL_ID.replace(/\//g, "_")}.json`);
}

function loadCache(): Map<string, number[]> {
  const path = cachePath();
  if (!existsSync(path)) return new Map();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, number[]>;
    return new Map(Object.entries(raw));
  } catch {
    return new Map(); // a corrupt cache is a slow run, not a failed one
  }
}

function saveCache(cache: ReadonlyMap<string, number[]>): void {
  const path = cachePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(Object.fromEntries(cache)));
}

async function embedCorpus(
  embedder: Embedder,
  chunks: readonly StoredChunk[],
): Promise<Float32Array> {
  const cache = loadCache();
  const out = new Float32Array(chunks.length * embedder.dim);
  const todo: number[] = [];

  chunks.forEach((chunk, i) => {
    const hit = cache.get(chunk.contentHash);
    if (hit && hit.length === embedder.dim) out.set(hit, i * embedder.dim);
    else todo.push(i);
  });

  if (todo.length > 0) {
    process.stdout.write(`embedding ${todo.length} of ${chunks.length} chunks…\n`);
    const BATCH = 32;
    for (let start = 0; start < todo.length; start += BATCH) {
      const slice = todo.slice(start, start + BATCH);
      const flat = await embedder.embed(slice.map((i) => chunks[i]!.text));
      slice.forEach((chunkIndex, j) => {
        const vector = flat.subarray(j * embedder.dim, (j + 1) * embedder.dim);
        out.set(vector, chunkIndex * embedder.dim);
        cache.set(chunks[chunkIndex]!.contentHash, [...vector]);
      });
      if (start % (BATCH * 10) === 0) {
        process.stdout.write(`  ${Math.min(start + BATCH, todo.length)}/${todo.length}\n`);
      }
    }
    saveCache(cache);
  }

  return out;
}

describe.skipIf(!haveInputs)("real eval", () => {
  it(
    "reports retrieval, completeness and refusal behaviour on the real corpus",
    async () => {
      const corpus = parseCorpusExport(JSON.parse(readFileSync(CORPUS_PATH, "utf8")));
      const { questions, errors } = parseQuestionSet(readFileSync(QUESTIONS_PATH, "utf8"));

      for (const err of errors) process.stdout.write(`question set — ${err}\n`);
      expect(questions.length, "no usable questions in the set").toBeGreaterThan(0);

      /**
       * A label pointing at a URL the crawl never captured produces a silent
       * zero — indistinguishable from a retrieval failure, and far more likely
       * early on. Say so instead.
       */
      const known = new Set(corpus.chunks.map((c) => c.url));
      const orphans = questions
        .flatMap((q) => q.answerUrls)
        .filter((url) => !known.has(url));
      if (orphans.length > 0) {
        process.stdout.write(
          `\n${orphans.length} labelled URL(s) are not in this corpus — they will score 0:\n` +
            [...new Set(orphans)].map((u) => `  ${u}`).join("\n") +
            "\n",
        );
      }

      const embedder = await createEmbedder(findModel(MODEL_ID), {
        models: join(ROOT, "public/models/"),
        ort: join(ROOT, "public/ort/"),
      });

      const chunks: StoredChunk[] = corpus.chunks.map((c) => ({
        indexId: INDEX,
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

      const db = await openSherpaDb("eval-real");
      invalidateSession();
      await vectorStore.append(db, INDEX, await embedCorpus(embedder, chunks), embedder.dim);
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

      const generator = API_KEY
        ? new ByokGenerator({ provider: PROVIDER, model: ANSWER_MODEL, apiKey: API_KEY })
        : null;

      const results: EvalCaseResult[] = [];
      for (const question of questions) {
        results.push(
          await runCase(
            {
              retrieve: (q) => retrieve({ db, indexId: INDEX, embedder }, q),
              ...(generator
                ? {
                    answer: async (q, articles) => {
                      let text = "";
                      for await (const piece of generator.answer({ query: q, context: articles })) {
                        text += piece.delta;
                      }
                      return { text, refused: isRefusal(text) };
                    },
                  }
                : {}),
              floor: FLOOR,
            },
            question,
          ),
        );
        process.stdout.write(".");
      }

      const byQuestion = new Map(results.map((r) => [r.question, r]));
      const report = summarize(questions, results);
      process.stdout.write(
        [
          "\n\n=== Sherpa eval ===",
          `corpus     ${corpus.host} · ${corpus.pageCount} pages · ${corpus.chunks.length} chunks`,
          `embedding  ${MODEL_ID}`,
          `answering  ${generator ? `${PROVIDER}/${ANSWER_MODEL}` : "retrieval only"}`,
          `floor      ${FLOOR}`,
          "",
          formatReport(report),
          "",
        ].join("\n"),
      );

      /**
       * Recalibrate the refusal floor against these scores. The shipped default
       * was swept on a hashed fixture embedder, whose cosine distribution has
       * nothing to do with the real model's — so the number is a placeholder
       * until it is re-derived here.
       */
      const floorCases: FloorCase[] = questions.map((q) => {
        const result = byQuestion.get(q.question);
        return {
          topScore: result?.topScore ?? 0,
          answerable: q.answerUrls.length > 0,
          retrieved: result?.firstHitRank !== undefined,
        };
      });
      const sweep = sweepFloors(floorCases);
      const recommended = recommendFloor(sweep, 0.03); // M3
      process.stdout.write(
        [
          "\nREFUSAL FLOOR SWEEP",
          formatFloorSweep(sweep),
          "",
          recommended
            ? `  lowest floor meeting M3 (false-answer ≤ 3%): ${recommended.floor.toFixed(2)} ` +
              `(misses ${(recommended.missedAnswerRate * 100).toFixed(1)}% of answerable questions)`
            : "  no floor in the sweep meets M3 — retrieval, not the threshold, is the problem",
          `  currently shipping: ${FLOOR}`,
          "",
        ].join("\n"),
      );

      // The worst cases, which is where the next fix comes from.
      const misses = results
        .filter((r) => r.expectedUrls.length > 0 && r.firstHitRank === undefined)
        .slice(0, 10);
      if (misses.length > 0) {
        process.stdout.write("\nNOT RETRIEVED AT ALL\n");
        for (const m of misses) process.stdout.write(`  ${m.question}\n`);
      }

      const dropped = results
        .filter((r) => r.contextCoverage.ratio > r.answerCoverage.ratio)
        .slice(0, 10);
      if (dropped.length > 0) {
        process.stdout.write("\nFACTS RETRIEVED BUT DROPPED FROM THE ANSWER\n");
        for (const d of dropped) {
          process.stdout.write(`  ${d.question}\n    missing: ${d.answerCoverage.missing.join(", ")}\n`);
        }
      }

      // Deliberately no thresholds. This run informs a decision; asserting a
      // number here would turn a measurement into a gate that gets tuned away.
      expect(report.answerableCount + report.unanswerableCount).toBe(questions.length);
    },
    30 * 60_000,
  );
});
