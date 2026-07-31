/**
 * Grounding prompt + context formatting (PRD 5.8.7). Shared by the Nano and
 * BYOK tiers. The instruction is strict: answer only from context, cite by
 * number, and refuse when the answer isn't present.
 */

import type { RetrievedChunk } from "@/domain/retrieval.js";

export const REFUSAL_TEXT = "I don't have that in this index.";

/** Number each context chunk so the model can cite it as [n]. */
export function formatContext(chunks: readonly RetrievedChunk[]): string {
  return chunks
    .map((c, i) => `[${i + 1}] ${c.headingPath || c.title}\n${c.body}`)
    .join("\n\n");
}

export function buildGroundedPrompt(query: string, chunks: readonly RetrievedChunk[]): string {
  return [
    "You answer questions using ONLY the CONTEXT below, which comes from a documentation site.",
    "Rules:",
    "- Use only facts present in the context. Do not use outside knowledge.",
    "- Cite the source of each claim inline as [n], matching the context numbers.",
    "- Preserve procedural structure: if the source lists numbered steps, answer in numbered steps.",
    `- If the answer is not in the context, reply exactly: "${REFUSAL_TEXT}"`,
    "",
    "CONTEXT:",
    formatContext(chunks),
    "",
    `QUESTION: ${query}`,
    "",
    "ANSWER:",
  ].join("\n");
}
