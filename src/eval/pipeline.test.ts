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
import {
  runRetrievalEval,
  runAdversarialEval,
  runRefinementEval,
  passesGate,
  type TurnOutcome,
} from "./harness.js";
import { chooseRefinements } from "@/retrieval/refine.js";
import { answerQuery } from "@/generator/answerService.js";
import type { AnswerGenerator } from "@/domain/generator.js";
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

/**
 * Drive the *real* orchestration — the same `answerQuery` the offscreen job
 * runs — and report where the turn ended up. Retrieval scores alone cannot see
 * this: the failure being gated against was a turn that retrieved perfectly
 * well and then produced nothing.
 *
 * The generator is a stub. What is under test is control flow, not prose.
 */
const STUB_GENERATOR: AnswerGenerator = {
  tier: "extractive",
  pack: { maxArticles: 8, tokenBudget: 100000 },
  availability: async () => ({ tier: "extractive" as const, state: "available" as const }),
  async *answer() {
    yield { delta: "answer text" };
  },
};

async function outcomeOf(
  query: string,
): Promise<{ outcome: TurnOutcome; refinements: number }> {
  const deps = {
    retrieve: (q: string) => retrieve({ db, indexId: INDEX, embedder: fixtureEmbedder }, q),
    generator: STUB_GENERATOR,
    floors: { refuse: FLOOR, confident: 0.65 },
  };

  let outcome: TurnOutcome = "blocked";
  let refinements = 0;
  for await (const event of answerQuery(deps, query)) {
    // A refusal is a real outcome and outranks the sources that preceded it —
    // "model-declined" arrives after them and is what the user actually sees.
    if (event.kind === "refusal") outcome = "refusal";
    else if (event.kind === "sources" && outcome === "blocked") outcome = "answer";
    else if (event.kind === "refine") refinements = event.options.length;
  }
  return { outcome, refinements };
}

describe("refinement eval (M4)", () => {
  /**
   * The regression, as a gate.
   *
   * Not "did it answer?" — a refusal is a legitimate, visible outcome, and with
   * the fixture embedder's hashed cosines plenty of golden questions land under
   * the floor for reasons that say nothing about the pipeline. The failure is a
   * turn that produced *neither*: the old flow yielded a question back and then
   * `done`, leaving the user with no answer, no refusal, and nowhere to go.
   */
  it("never leaves a question without an answer or a refusal", async () => {
    const report = await runRefinementEval(GOLDEN, outcomeOf);
    expect(report.n).toBe(GOLDEN.length);
    expect(report.blockedRate).toBe(0);
  });

  /** Same guarantee for questions the corpus genuinely cannot answer. */
  it("declines unanswerable questions rather than stalling on them", async () => {
    const adversarial = ADVERSARIAL.map((query) => ({ query, relevant: [] }));
    const report = await runRefinementEval(adversarial, outcomeOf);
    expect(report.blockedRate).toBe(0);
  });

  /**
   * Refinement is advisory now, so a high rate is clutter rather than a dead
   * end — but on a well-formed golden set it still signals a miscalibrated
   * scatter threshold. Held loosely on purpose: the fixture embedder's score
   * *distribution* is a hashing stand-in, not bge's, so only `floorSweep`
   * against a real corpus can calibrate the constant itself.
   */
  it("keeps unsolicited refinement rare on well-formed questions", async () => {
    const report = await runRefinementEval(GOLDEN, outcomeOf);
    expect(report.refineRate).toBeLessThanOrEqual(0.2);
  });

  /**
   * The loop, as an assertion.
   *
   * Picking a chip used to re-ask the chosen *title* as a fresh query, which
   * retrieves that page plus its near-identical siblings at near-identical
   * scores — the most reliably "ambiguous" input the corpus can produce — so
   * the same chips came back unchanged, forever. Scoping to the URL makes a
   * pick terminal: one page survives, and one page cannot scatter.
   */
  it("resolves a picked option to that page and offers nothing further", async () => {
    const first = await retrieve({ db, indexId: INDEX, embedder: fixtureEmbedder }, "roleplay");
    const target = first.articles[0];
    expect(target).toBeDefined();

    const picked = await retrieve(
      { db, indexId: INDEX, embedder: fixtureEmbedder, focusUrl: target!.url },
      target!.title,
    );

    expect(picked.articles.length).toBeGreaterThan(0);
    expect(picked.articles.every((a) => a.url === target!.url)).toBe(true);
    // The terminal property: no further question can be generated from one page.
    expect(chooseRefinements(picked.articles)).toEqual([]);
  });

  /** A stale URL should cost the scoping, never the answer. */
  it("falls back to unscoped results when the focused page is gone", async () => {
    const result = await retrieve(
      { db, indexId: INDEX, embedder: fixtureEmbedder, focusUrl: "https://gone.example/404" },
      "roleplay",
    );
    expect(result.articles.length).toBeGreaterThan(0);
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
    const refinement = await runRefinementEval(GOLDEN, outcomeOf);
    expect(passesGate(retrieval, adversarial, refinement)).toBe(true);
  });
});

/**
 * The pick path, end to end.
 *
 * Everything here guards a way the *fix* could reintroduce the dead end it was
 * written to remove — a chip Sherpa itself offered that leads nowhere useful.
 */
describe("refinement picks", () => {
  async function firstArticle(query: string) {
    const r = await retrieve({ db, indexId: INDEX, embedder: fixtureEmbedder }, query);
    const a = r.articles[0];
    expect(a).toBeDefined();
    return a!;
  }

  /**
   * Scoping reads the page out of the index, not out of the fused candidate
   * list. Filtering the candidates looks equivalent and isn't: a page whose
   * chunks miss the top-k would silently fall back to unscoped results, and the
   * user would be answered from a different document than the one they picked.
   */
  it("returns the picked page even when the pick's wording does not retrieve it", async () => {
    const target = await firstArticle("roleplay");
    const scoped = await retrieve(
      { db, indexId: INDEX, embedder: fixtureEmbedder, focusUrl: target.url },
      // Wording with nothing to do with the page — the URL must still win.
      "zzzz unrelated gibberish",
    );
    expect(scoped.articles.length).toBeGreaterThan(0);
    expect(scoped.articles.every((a) => a.url === target.url)).toBe(true);
  });

  /** Chunks the retrievers never surfaced still get a measured cosine. */
  it("measures similarity for chunks pulled in by scoping", async () => {
    const target = await firstArticle("roleplay");
    const scoped = await retrieve(
      { db, indexId: INDEX, embedder: fixtureEmbedder, focusUrl: target.url },
      "zzzz unrelated gibberish",
    );
    expect(scoped.topScore).toBeGreaterThan(0);
  });

  /**
   * The subtlest way to rebuild the dead end: offer a chip, then refuse it.
   *
   * A picked page is scored against the question, and nothing guarantees that
   * page clears the index's floor — facet options in particular are grounded
   * over the top articles rather than only the tightly-clustered ones. Refusing
   * there would have Sherpa declining its own suggestion, and M4 could not see
   * it, because a refusal is a legitimate outcome everywhere else.
   */
  it("answers a picked page rather than refusing it, however it scores", async () => {
    const target = await firstArticle("roleplay");
    const deps = {
      retrieve: () =>
        retrieve(
          { db, indexId: INDEX, embedder: fixtureEmbedder, focusUrl: target.url },
          "zzzz unrelated gibberish",
        ),
      generator: STUB_GENERATOR,
      // A floor nothing could clear, standing in for a badly-scoring pick.
      floors: { refuse: 0.99, confident: 0.995 },
      focused: true,
    };

    const kinds: string[] = [];
    for await (const event of answerQuery(deps, "how do I record a call?")) kinds.push(event.kind);
    expect(kinds).toContain("sources");
    expect(kinds).not.toContain("refusal");
  });

  /** The override is the floor only — an empty result set still refuses. */
  it("still refuses when there is genuinely nothing to answer from", async () => {
    const deps = {
      retrieve: async () => ({ articles: [], topScore: 0, denseAvailable: true }),
      generator: STUB_GENERATOR,
      floors: { refuse: 0.4, confident: 0.65 },
      focused: true,
    };
    const kinds: string[] = [];
    for await (const event of answerQuery(deps, "q")) kinds.push(event.kind);
    expect(kinds).toContain("refusal");
  });
});
