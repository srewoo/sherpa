/**
 * Query understanding, in one place and one model call.
 *
 * The pieces existed — `followUp.ts` resolves references, `rewrite.ts` makes a
 * standalone query, `hyde.ts` writes a passage to embed — but the order they
 * run in, and the rules about which may override which, lived as inline logic
 * in an offscreen message handler. That is a poor home for the part of the
 * system that decides what gets searched: it cannot be unit-tested, and one of
 * its inputs (`recentQuestions`) was silently dropped in transit for the life
 * of the feature without a single test noticing.
 *
 * Two properties this module is responsible for:
 *
 *  - **Cheapest first.** `resolveFollowUp` is pure text and fixes the class of
 *    question users ask second, so it runs before any model is consulted and
 *    its output is what a model gets asked to improve on.
 *  - **One round trip.** Rewriting and HyDE were two sequential awaits in front
 *    of retrieval, which on BYOK meant two network round trips before the first
 *    byte. They want the same context and produce independent outputs, so they
 *    are one call that returns both.
 *
 * Nothing here is trusted. Each half is validated separately and each falls
 * back on its own, so a mangled passage cannot cost a good rewrite and a
 * rejected rewrite cannot cost a usable passage. The floor is always the user's
 * own words.
 */

import { resolveFollowUp } from "./followUp.js";
import {
  cleanRewrite,
  rejectionReason,
  rewritePrompt,
  DEFAULT_REWRITE,
  type Completer,
  type RewriteOptions,
} from "./rewrite.js";
import { hydeText, DEFAULT_HYDE, type HydeOptions } from "./hyde.js";
import { log } from "@/lib/log.js";

export interface QueryPlan {
  /** The text retrieval searches with. Never empty. */
  readonly search: string;
  /**
   * The text the *dense* half embeds, when HyDE produced something usable.
   * Absent means "embed `search`", which is the pre-HyDE behaviour.
   */
  readonly denseText?: string;
  /** Where `search` came from — for logging and tests, not for control flow. */
  readonly source: "raw" | "followup" | "model";
}

export interface UnderstandOptions {
  readonly rewrite: RewriteOptions;
  readonly hyde: HydeOptions;
}

export const DEFAULT_UNDERSTAND: UnderstandOptions = {
  rewrite: DEFAULT_REWRITE,
  hyde: DEFAULT_HYDE,
};

export interface UnderstandDeps {
  /** The selected tier's model. Absent on Extractive — everything degrades. */
  readonly complete?: Completer;
  /** User opted into query rewriting. */
  readonly rewriteQueries: boolean;
  /** User opted into HyDE. */
  readonly hyde: boolean;
}

/**
 * Ask for the rewrite and the hypothetical passage together.
 *
 * Built on `rewritePrompt` rather than beside it: its rules about protected
 * terms and its prompt-injection stance are the hard-won part, and duplicating
 * them here would let the two drift.
 */
export function combinedPrompt(query: string, recent: readonly string[]): string {
  return [
    // Strip both the trailing "QUERY:" cue *and* the single-line instruction.
    // Left in, the prompt would tell a model to return one bare line and then
    // ask it for two labelled ones — and Gemini Nano, the tier this is designed
    // around, follows the first instruction it is given.
    rewritePrompt(query, recent)
      .replace(/\n\nQUERY:$/, "")
      .replace(
        /Return ONLY the query text on one line — no JSON, no quotes,\nno explanation, no prefix\./,
        "Do not explain your answer.",
      ),
    "",
    "Then write a short passage from a product help centre that would answer",
    "the query — the same wording, UI labels and product nouns a help article",
    "would use. Three sentences. Do not hedge and do not mention that it is",
    "hypothetical; it is never shown to anyone, only used to find real pages.",
    "",
    "Reply in exactly this format and nothing else:",
    "QUERY: <the standalone search query>",
    "PASSAGE: <the passage>",
    "",
    "ANSWER:",
  ].join("\n");
}

/**
 * Split a combined reply. Either half may be missing; both are optional.
 *
 * The fallback is the important part. A small model asked for two labelled
 * sections will sometimes return a bare rewritten query and nothing else, and
 * requiring the `QUERY:` label would then discard *both* halves — turning HyDE
 * on would silently break rewriting, which worked fine on its own. An unlabelled
 * reply is treated as the query, which is what it is.
 */
export function parseCombined(raw: string): { query: string; passage: string } {
  const text = raw.trim();
  // The passage runs to the end of the reply, so match across newlines.
  const passage = /PASSAGE:\s*([\s\S]+)/i.exec(text)?.[1]?.trim() ?? "";

  const labelled = /QUERY:\s*(.+)/i.exec(text)?.[1]?.trim();
  if (labelled) return { query: labelled, passage };

  // No label anywhere: take the first line, which `cleanRewrite` then validates
  // exactly as it does a plain rewrite.
  if (passage === "") return { query: text, passage };

  // A PASSAGE label but no QUERY label — use whatever preceded it.
  const before = text.slice(0, text.search(/PASSAGE:/i)).trim();
  return { query: before, passage };
}

/**
 * What to search with. Never throws, and never returns an empty `search`.
 */
export async function understand(
  query: string,
  recent: readonly string[],
  deps: UnderstandDeps,
  options: UnderstandOptions = DEFAULT_UNDERSTAND,
): Promise<QueryPlan> {
  const resolved = resolveFollowUp(query, recent);
  const base: QueryPlan = {
    search: resolved,
    source: resolved === query ? "raw" : "followup",
  };

  // No model, or nothing asked of it: the resolved text stands. This is the
  // Extractive tier's normal path, not a failure.
  if (!deps.complete || (!deps.rewriteQueries && !deps.hyde)) return base;

  try {
    const wantsPassage = deps.hyde;
    const raw = await deps.complete(
      wantsPassage ? combinedPrompt(resolved, recent) : rewritePrompt(resolved, recent),
    );

    // Without a PASSAGE section the reply is a bare rewrite, which is exactly
    // what `cleanRewrite` already expects.
    const { query: rawQuery, passage } = wantsPassage
      ? parseCombined(raw)
      : { query: raw, passage: "" };

    let search = resolved;
    let source: QueryPlan["source"] = base.source;
    if (deps.rewriteQueries) {
      const cleaned = cleanRewrite(rawQuery);
      const reason = rejectionReason(resolved, cleaned, options.rewrite);
      if (reason) {
        log.warn("query_rewrite_discarded", { reason, query: resolved, cleaned });
      } else {
        search = cleaned;
        source = "model";
      }
    }

    // `hydeText` returns the query unchanged for an empty passage, so an
    // absent or unusable half costs the dense side nothing.
    const denseText = deps.hyde ? hydeText(search, passage, options.hyde) : search;

    return {
      search,
      source,
      ...(denseText !== search ? { denseText } : {}),
    };
  } catch {
    return base;
  }
}
