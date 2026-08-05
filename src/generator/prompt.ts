/**
 * Grounding prompt + context formatting (PRD 5.8.7). Shared by the Nano and
 * BYOK tiers. The instruction is strict: answer only from context, cite by
 * number, and refuse when the answer isn't present.
 */

import type { RetrievedArticle } from "@/domain/retrieval.js";

export const REFUSAL_TEXT = "I don't have that in this index.";

/**
 * Number each article so the model can cite it as [n]. The numbering matches
 * the source cards exactly, because both now enumerate the same articles —
 * when context was a chunk list, [3] could be the third fragment of the second
 * document.
 */
export function formatContext(articles: readonly RetrievedArticle[]): string {
  return articles
    .map((a, i) => `[${i + 1}] ${a.title}${a.headingPath ? ` — ${a.headingPath}` : ""}\n${a.body}`)
    .join("\n\n");
}

export function buildGroundedPrompt(query: string, articles: readonly RetrievedArticle[]): string {
  return [
    "You answer questions using ONLY the CONTEXT below, which comes from a documentation site.",
    "Rules:",
    "- Use only facts present in the context. Do not use outside knowledge.",
    "- Cite the source of each claim inline as [n], matching the context numbers.",
    "- Preserve procedural structure: if the source lists numbered steps, answer in numbered steps.",
    // Answers that stop halfway through a procedure were the single most common
    // complaint. The model has no way to know the context was assembled from a
    // whole page, so it has to be told that finishing is the job.
    "- Give the COMPLETE procedure. Include every step through to the end, not just the first few.",
    "- Do not summarise a procedure into prose. Steps stay steps.",
    "- If the context covers only part of what was asked, answer that part and say plainly which part is missing.",
    `- If the answer is not in the context, reply exactly: "${REFUSAL_TEXT}"`,
    "",
    "CONTEXT:",
    formatContext(articles),
    "",
    `QUESTION: ${query}`,
    "",
    "ANSWER:",
  ].join("\n");
}
