/**
 * Write the built-in fixture corpus out in eval-export form
 * (`npm run eval:fixture`).
 *
 * Not a substitute for a real corpus — twelve invented chunks cannot tell you
 * how Sherpa handles a 1,400-page help centre. Its use is narrower and real:
 * it exercises the whole offline eval against the *actual* bge weights, so the
 * harness is known-good before anyone spends an afternoon labelling questions,
 * and it produces a first look at bge's true score distribution against the
 * shipped refusal floor.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { CORPUS, GOLDEN, ADVERSARIAL, embeddedText } from "./fixtures/corpus.js";
import { CORPUS_EXPORT_VERSION, type CorpusExport } from "@/storage/corpusExport.js";

describe("fixture export", () => {
  it("writes a corpus and question set the real eval can consume", () => {
    const positions = new Map<string, number>();
    const corpus: CorpusExport = {
      version: CORPUS_EXPORT_VERSION,
      indexId: "fixture",
      host: "help.acme.test",
      root: "https://help.acme.test/",
      exportedAt: 0,
      pageCount: new Set(CORPUS.map((c) => c.url)).size,
      chunks: CORPUS.map((c) => {
        const position = positions.get(c.url) ?? 0;
        positions.set(c.url, position + 1);
        return {
          vectorId: c.id,
          text: embeddedText(c),
          body: c.body,
          url: c.url,
          headingPath: c.headingPath,
          title: c.headingPath.split(" > ").pop() ?? "",
          position,
          contentHash: `fixture-${c.id}`,
        };
      }),
    };

    const urlOf = new Map(CORPUS.map((c) => [c.id, c.url]));
    const lines = [
      ...GOLDEN.map((g) =>
        JSON.stringify({
          question: g.query,
          answerUrls: [...new Set(g.relevant.map((id) => urlOf.get(id)!))],
        }),
      ),
      ...ADVERSARIAL.map((q) => JSON.stringify({ question: q, answerUrls: [] })),
    ];

    mkdirSync("eval", { recursive: true });
    writeFileSync("eval/fixture-corpus.json", JSON.stringify(corpus));
    writeFileSync("eval/fixture-questions.jsonl", lines.join("\n") + "\n");

    expect(corpus.chunks.length).toBe(CORPUS.length);
    expect(lines.length).toBe(GOLDEN.length + ADVERSARIAL.length);
  });
});
