/**
 * HyDE — Hypothetical Document Embeddings.
 *
 * A question and its answer don't look alike. "How do I create a two way role
 * play" is a short interrogative; the passage that answers it is a procedure
 * full of UI labels and product nouns. Embedding the question puts it in
 * question-space and then asks for the nearest passage, which is a comparison
 * across a gap the embedding model was never trained to close.
 *
 * HyDE closes it from the other side: have the model write what an answer
 * *would* look like, and embed that instead. The hypothetical is usually wrong
 * on the facts — it is inventing, not retrieving — but it is wrong in the right
 * vocabulary, and vocabulary is what the nearest-neighbour search is matching
 * on. It never reaches the user; only its embedding is used.
 *
 * Complements `expansion.ts` rather than duplicating it: RM3 borrows vocabulary
 * from the corpus for the *sparse* half of retrieval, HyDE supplies it from the
 * model for the *dense* half.
 */

/** Writes a plausible answer. Any generator will do; quality matters less than idiom. */
export type Hypothesizer = (query: string) => Promise<string>;

export interface HydeOptions {
  /**
   * Cap on the hypothetical's length. Embedding models truncate at their
   * context limit anyway, and a rambling hypothetical dilutes the query's own
   * terms — the aim is a passage-shaped paragraph, not an essay.
   */
  readonly maxChars: number;
  /**
   * Keep the real question in the embedded text alongside the hypothetical.
   *
   * Load-bearing: a hypothetical that wanders off-topic would otherwise carry
   * the search away from what was asked with nothing to anchor it. Concatenating
   * bounds the damage — the worst case degrades toward a plain query embedding
   * rather than retrieving something unrelated.
   */
  readonly keepQuery: boolean;
}

export const DEFAULT_HYDE: HydeOptions = { maxChars: 600, keepQuery: true };

/** The prompt that asks for a passage rather than an answer. */
export function hydePrompt(query: string): string {
  return [
    "Write a short passage from a product help centre that would answer the",
    "question below. Write it as documentation — the same wording, UI labels and",
    "product nouns a help article would use. Do not hedge, do not say you are",
    "unsure, and do not mention that this is hypothetical. Three sentences.",
    "",
    `QUESTION: ${query}`,
    "",
    "PASSAGE:",
  ].join("\n");
}

/**
 * Build the text to embed.
 *
 * Pure, so the fallback behaviour is testable without a model: an empty or
 * failed hypothetical yields the plain query, which is exactly the behaviour
 * that makes this safe to enable by default.
 */
export function hydeText(
  query: string,
  hypothetical: string,
  options: HydeOptions = DEFAULT_HYDE,
): string {
  const trimmed = hypothetical.trim().slice(0, options.maxChars).trim();
  if (trimmed === "") return query;
  return options.keepQuery ? `${query}\n\n${trimmed}` : trimmed;
}

/**
 * Generate and assemble. Never throws: a model that is unavailable, slow, or
 * refuses degrades to plain query embedding rather than failing the search.
 */
export async function hydeQuery(
  query: string,
  hypothesize: Hypothesizer,
  options: HydeOptions = DEFAULT_HYDE,
): Promise<string> {
  try {
    return hydeText(query, await hypothesize(query), options);
  } catch {
    return query;
  }
}
