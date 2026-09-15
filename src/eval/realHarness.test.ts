import { describe, it, expect } from "vitest";
import type { RetrievedArticle } from "@/domain/retrieval.js";
import { parseQuestionSet, answerable, unanswerable } from "./questionSet.js";
import { coverageOf, meanCoverage, mostMissed, normalizeForMatch } from "./coverage.js";
import { runCase, summarize, sameArticle, type RealEvalDeps } from "./realHarness.js";
import { buildCorpusExport, parseCorpusExport } from "@/storage/corpusExport.js";
import { parseCrawlConfig } from "@/domain/config.js";
import type { StoredChunk } from "@/domain/records.js";

function article(url: string, body: string): RetrievedArticle {
  return {
    url,
    title: "T",
    headingPath: "H",
    rankScore: 1,
    similarity: 0.8,
    anchor: undefined,
    chunks: [],
    body,
  };
}

const deps = (
  articles: readonly RetrievedArticle[],
  topScore = 0.8,
  answer?: RealEvalDeps["answer"],
): RealEvalDeps => ({
  retrieve: async () => ({ articles, topScore }),
  ...(answer ? { answer } : {}),
  floor: 0.4,
});

describe("parseQuestionSet", () => {
  it("reads one question per line", () => {
    const { questions, errors } = parseQuestionSet(
      [
        '{"question":"how do I do X","answerUrls":["https://h.test/x"]}',
        '{"question":"what about Y","answerUrls":["https://h.test/y"],"mustInclude":["step two"]}',
      ].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(questions).toHaveLength(2);
    expect(questions[1]?.mustInclude).toEqual(["step two"]);
  });

  /**
   * A hand-maintained file of a hundred questions will contain a typo, and
   * failing the whole run over line 47 teaches people to stop adding questions.
   */
  it("reports a bad line by number and keeps the good ones", () => {
    const { questions, errors } = parseQuestionSet(
      ['{"question":"fine","answerUrls":[]}', "{not json", '{"question":"also fine"}'].join("\n"),
    );
    expect(questions).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("line 2");
  });

  it("rejects a URL that isn't one, naming the field", () => {
    const { errors } = parseQuestionSet('{"question":"q","answerUrls":["not-a-url"]}');
    expect(errors[0]).toContain("answerUrls");
  });

  it("skips blanks and comments so the file can be organised", () => {
    const { questions, errors } = parseQuestionSet(
      ["// SSO questions", "", '{"question":"q"}'].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(questions).toHaveLength(1);
  });

  it("treats an empty answer list as a question the index must refuse", () => {
    const { questions } = parseQuestionSet(
      ['{"question":"answerable","answerUrls":["https://h.test/a"]}', '{"question":"not"}'].join(
        "\n",
      ),
    );
    expect(answerable(questions).map((q) => q.question)).toEqual(["answerable"]);
    expect(unanswerable(questions).map((q) => q.question)).toEqual(["not"]);
  });
});

describe("coverage", () => {
  it("finds required phrases regardless of case and spacing", () => {
    expect(coverageOf("First,  Click   Create Mission.", ["click create mission"]).ratio).toBe(1);
  });

  it("sees through markdown emphasis", () => {
    // Models bold the UI labels that labellers write plainly.
    expect(coverageOf("Click **Create mission**", ["Create mission"]).ratio).toBe(1);
  });

  it("names what was missing, not just how much", () => {
    const c = coverageOf("only the first step", ["first step", "second step"]);
    expect(c.found).toEqual(["first step"]);
    expect(c.missing).toEqual(["second step"]);
    expect(c.ratio).toBe(0.5);
  });

  /** Absence of a label is not evidence of incompleteness. */
  it("scores an unlabelled question 1 rather than 0", () => {
    expect(coverageOf("anything", []).ratio).toBe(1);
  });

  it("normalises smart quotes, which models emit and labellers don't type", () => {
    expect(normalizeForMatch("don’t")).toBe(normalizeForMatch("don't"));
  });

  it("ranks the phrases missed most often, the most actionable output", () => {
    const cases = [
      coverageOf("", ["end conditions", "avatar persona"]),
      coverageOf("avatar persona", ["end conditions", "avatar persona"]),
    ];
    expect(mostMissed(cases)[0]).toEqual({ phrase: "end conditions", misses: 2 });
    expect(meanCoverage(cases)).toBe(0.25);
  });
});

describe("sameArticle", () => {
  it("ignores scheme and trailing slash, which labellers vary on", () => {
    expect(sameArticle("http://h.test/a/", "https://h.test/a")).toBe(true);
  });

  it("still separates genuinely different pages", () => {
    expect(sameArticle("https://h.test/a", "https://h.test/b")).toBe(false);
  });
});

describe("runCase", () => {
  const q = {
    question: "how do I create a mission",
    answerUrls: ["https://h.test/create"],
    mustInclude: ["click create mission", "end conditions"],
  };

  it("records the rank at which the right article was found", async () => {
    const result = await runCase(
      deps([article("https://h.test/other", "x"), article("https://h.test/create", "y")]),
      q,
    );
    expect(result.firstHitRank).toBe(2);
  });

  it("leaves the rank undefined when the article was never retrieved", async () => {
    const result = await runCase(deps([article("https://h.test/other", "x")]), q);
    expect(result.firstHitRank).toBeUndefined();
  });

  it("counts a below-floor result as unanswered", async () => {
    const result = await runCase(deps([article("https://h.test/create", "y")], 0.2), q);
    expect(result.answered).toBe(false);
  });

  /**
   * The split that matters. Retrieval handed over everything required and the
   * answer dropped half of it — the exact "answer stops mid-procedure" bug.
   * One combined score would have read 75% and pointed nowhere.
   */
  it("separates what retrieval supplied from what the answer kept", async () => {
    const result = await runCase(
      deps(
        [article("https://h.test/create", "Click Create mission. Then set end conditions.")],
        0.8,
        async () => ({ text: "Click Create mission.", refused: false }),
      ),
      q,
    );
    expect(result.contextCoverage.ratio).toBe(1);
    expect(result.answerCoverage.ratio).toBe(0.5);
    expect(result.answerCoverage.missing).toEqual(["end conditions"]);
  });

  it("measures the context alone when no generator is supplied", async () => {
    const result = await runCase(
      deps([article("https://h.test/create", "Click Create mission. Then set end conditions.")]),
      q,
    );
    expect(result.answerCoverage.ratio).toBe(1);
  });

  it("treats a model refusal as unanswered even above the floor", async () => {
    const result = await runCase(
      deps([article("https://h.test/create", "text")], 0.9, async () => ({
        text: "I don't have that in this index.",
        refused: true,
      })),
      q,
    );
    expect(result.answered).toBe(false);
  });
});

describe("summarize", () => {
  const questions = parseQuestionSet(
    [
      '{"question":"a","answerUrls":["https://h.test/a"]}',
      '{"question":"b","answerUrls":["https://h.test/b"]}',
      '{"question":"impossible"}',
    ].join("\n"),
  ).questions;

  it("measures hit rate over answerable questions only", async () => {
    const results = [
      await runCase(deps([article("https://h.test/a", "")]), questions[0]!),
      await runCase(deps([article("https://h.test/zzz", "")]), questions[1]!),
      await runCase(deps([]), questions[2]!),
    ];
    const report = summarize(questions, results);
    expect(report.answerableCount).toBe(2);
    expect(report.unanswerableCount).toBe(1);
    expect(report.hitAt[1]).toBe(0.5);
  });

  it("counts answering an unanswerable question as a false answer", async () => {
    const results = [
      await runCase(deps([article("https://h.test/x", "")], 0.9), questions[2]!),
    ];
    expect(summarize(questions, results).falseAnswerRate).toBe(1);
  });

  /**
   * The metric this project never had. Refusing a question whose article was
   * right there is the cost of a high floor, and it has to be visible next to
   * the false-answer rate or the threshold gets tuned blind.
   */
  it("counts refusing a question whose article was found as a missed answer", async () => {
    const results = [
      await runCase(deps([article("https://h.test/a", "")], 0.1), questions[0]!),
      await runCase(deps([article("https://h.test/b", "")], 0.9), questions[1]!),
    ];
    expect(summarize(questions, results).missedAnswerRate).toBe(0.5);
  });

  it("rewards a better rank through MRR, which hit@k cannot see", async () => {
    const first = summarize(questions, [
      await runCase(deps([article("https://h.test/a", "")]), questions[0]!),
    ]);
    const third = summarize(questions, [
      await runCase(
        deps([
          article("https://h.test/x", ""),
          article("https://h.test/y", ""),
          article("https://h.test/a", ""),
        ]),
        questions[0]!,
      ),
    ]);
    expect(first.mrr).toBeGreaterThan(third.mrr);
  });
});

describe("buildCorpusExport", () => {
  const meta = {
    id: "i",
    root: "https://h.test/",
    host: "h.test",
    title: "H",
    pageCount: 2,
    chunkCount: 3,
    sizeBytes: 1,
    createdAt: 1,
    lastIndexedAt: 2,
    schemaVersion: 4,
    embeddingModel: "Xenova/bge-small-en-v1.5",
    config: parseCrawlConfig({ root: "https://h.test/" }),
  };
  const stored = (url: string, position: number): StoredChunk => ({
    indexId: "i",
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

  it("round-trips through the parser it will be read back with", () => {
    const exported = buildCorpusExport(meta, [stored("https://h.test/a", 0)], 123);
    expect(() => parseCorpusExport(JSON.parse(JSON.stringify(exported)))).not.toThrow();
  });

  /** An export that reshuffles every re-crawl is unreviewable in a diff. */
  it("orders by url then position, so re-exports diff cleanly", () => {
    const exported = buildCorpusExport(
      meta,
      [stored("https://h.test/b", 1), stored("https://h.test/a", 2), stored("https://h.test/a", 0)],
      123,
    );
    expect(exported.chunks.map((c) => `${c.url}#${c.position}`)).toEqual([
      "https://h.test/a#0",
      "https://h.test/a#2",
      "https://h.test/b#1",
    ]);
  });

  /** Vectors are recomputed per model — exporting them would fix the corpus to one. */
  it("carries no vectors", () => {
    const exported = buildCorpusExport(meta, [stored("https://h.test/a", 0)], 123);
    expect(JSON.stringify(exported)).not.toContain("vector\"");
    expect(Object.keys(exported.chunks[0]!)).not.toContain("embedding");
  });

  it("rejects a file that isn't an export, saying why", () => {
    expect(() => parseCorpusExport({ version: 99 })).toThrow(/corpus export/);
  });
});
