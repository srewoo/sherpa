/**
 * Tier 0 — Extractive answers (PRD 5.8.1). No model: it surfaces the best
 * passages with their heading path and highlights the sentences that best match
 * the query. Works on every machine, always, and is the honest floor when Nano
 * is unavailable (8.1). Streams like the model tiers so the UI is identical.
 */

import type { AnswerChunk, AnswerGenerator, AnswerRequest, TierAvailability } from "@/domain/generator.js";
import { tokenize } from "@/retrieval/bm25.js";

function splitSentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) ?? [text]).map((s) => s.trim()).filter(Boolean);
}

/** The sentences of `body` that best overlap the query terms. */
function bestSentences(body: string, queryTerms: ReadonlySet<string>, limit: number): string[] {
  return splitSentences(body)
    .map((sentence) => {
      const terms = tokenize(sentence);
      const hits = terms.filter((t) => queryTerms.has(t)).length;
      return { sentence, hits };
    })
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit)
    .map((s) => s.sentence);
}

export class ExtractiveGenerator implements AnswerGenerator {
  readonly tier = "extractive" as const;

  availability(): Promise<TierAvailability> {
    return Promise.resolve({ tier: this.tier, state: "available" });
  }

  async *answer(req: AnswerRequest): AsyncIterable<AnswerChunk> {
    const direct = req.context.filter((c) => !c.viaNeighbour).slice(0, 4);
    if (direct.length === 0) {
      yield { delta: "I don't have that in this index." };
      return;
    }
    const terms = new Set(tokenize(req.query));
    yield { delta: "Here are the most relevant passages from your indexed pages:\n\n" };
    for (let i = 0; i < direct.length; i++) {
      const chunk = direct[i]!;
      const picks = bestSentences(chunk.body, terms, 2);
      const excerpt = picks.length > 0 ? picks.join(" ") : chunk.body.slice(0, 240);
      yield { delta: `**${chunk.headingPath || chunk.title}** [${i + 1}]\n${excerpt}\n\n` };
    }
  }
}
