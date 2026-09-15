/**
 * A gate in front of retrieval, for the turns that are not questions.
 *
 * "thanks" currently costs a query embedding, two BM25 passes for
 * pseudo-relevance feedback, a scan of the full vector matrix, possibly a
 * cross-encoder forward pass per candidate, and — with BYOK configured — a
 * network round trip to rewrite it. It then answers out of whatever pages
 * happened to score highest against the word "thanks", which is nothing a user
 * asked for. Echo puts an LLM classifier in this position and routes small talk
 * to a graph with no retrieval in it at all; the routing is the good idea, the
 * LLM is not available here.
 *
 * So this is deliberately not a classifier. Sherpa's cheapest tier has no model
 * at all, the gate has to run before the embedder loads, and a model call in
 * front of every question is the latency this is supposed to save. It is a
 * whitelist, and it is built to be wrong in one direction only: a greeting
 * mistaken for a question wastes 25 ms, while a question mistaken for a
 * greeting loses the answer entirely and tells the user their docs were
 * searched when they were not. Every rule below exists to make the second
 * failure impossible rather than unlikely.
 */

/** What kind of turn this is. Anything not provably small talk is a question. */
export type Intent = "small-talk" | "question";

export interface IntentResult {
  readonly intent: Intent;
  /** The reply to send for small talk. Absent for a question. */
  readonly reply?: string;
}

/**
 * Whole utterances, not substrings.
 *
 * Substring matching is the trap: "thanks, where do assets live?" contains
 * "thanks", and "hi" is inside "hierarchy". Every entry here is matched against
 * the *entire* normalised query, so a greeting with a question attached is a
 * question — which is the common case and the one that must not break.
 */
const GREETINGS = new Set([
  "hi", "hii", "hiya", "hello", "hey", "heya", "yo", "howdy",
  "good morning", "good afternoon", "good evening", "morning", "evening",
  "hi there", "hello there", "hey there", "hi sherpa", "hello sherpa", "hey sherpa",
  "anyone there", "you there", "are you there",
]);

const THANKS = new Set([
  "thanks", "thank you", "thankyou", "thx", "ty", "tysm", "cheers", "ta",
  "thanks a lot", "thanks so much", "thank you so much", "many thanks",
  "appreciate it", "much appreciated", "perfect thanks", "great thanks",
  "got it thanks", "that helped", "that helps", "brilliant", "perfect",
  "great", "nice", "awesome", "cool", "ok thanks", "okay thanks",
]);

const FAREWELLS = new Set([
  "bye", "goodbye", "bye bye", "see you", "see ya", "cya", "later",
  "good night", "goodnight", "night", "that's all", "thats all", "that is all",
  "nothing else", "no thanks", "im done", "i'm done", "all done",
]);

const ACKS = new Set([
  "ok", "okay", "k", "kk", "sure", "right", "yeah", "yep", "yes", "no", "nope",
  "mhm", "uh huh", "i see", "makes sense", "understood", "noted", "fine",
]);

/**
 * The longest an utterance can be and still be dismissed without searching.
 *
 * Words, not characters. Every phrase in the tables above is four words or
 * fewer, so the cap costs nothing except as a second line of defence: if a
 * table ever gains a long entry by mistake, the cap stops it from swallowing a
 * real question.
 */
const MAX_WORDS = 4;

/**
 * Normalise for lookup, without normalising away the evidence.
 *
 * Trailing punctuation goes — "thanks!" and "thanks" are the same utterance.
 * A question mark does *not* go, and is checked before this runs: "hi?" is odd
 * but "great?" is somebody asking something, and the cost of getting that wrong
 * is an unanswered question.
 */
function normalise(query: string): string {
  return query
    .toLowerCase()
    .replace(/[!.,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const REPLIES = {
  greeting: (site: string | undefined): string =>
    site
      ? `Hello. Ask me anything about ${site} and I'll answer from the pages I've indexed.`
      : "Hello. Index a documentation site and I'll answer questions from it.",
  thanks: "Glad that helped. Ask me anything else.",
  farewell: "Any time. I'll be here when you need the docs again.",
  ack: "Ask away whenever you're ready.",
} as const;

/**
 * Decide whether this turn needs the index at all.
 *
 * `site` is the label of the active index, used only to make the greeting worth
 * reading. Absent is fine and changes nothing about the decision.
 */
export function classifyIntent(query: string, site?: string): IntentResult {
  const raw = query.trim();

  /**
   * A question mark settles it, always.
   *
   * Anything a user bothered to punctuate as a question gets searched, even if
   * the words match a table exactly. This is the single most important line in
   * the file: it means no phrasing that a person would recognise as a question
   * can be answered without looking at their documentation.
   */
  if (raw.includes("?")) return { intent: "question" };

  const text = normalise(raw);
  if (text === "") return { intent: "question" };
  if (text.split(" ").length > MAX_WORDS) return { intent: "question" };

  if (GREETINGS.has(text)) return { intent: "small-talk", reply: REPLIES.greeting(site) };
  if (THANKS.has(text)) return { intent: "small-talk", reply: REPLIES.thanks };
  if (FAREWELLS.has(text)) return { intent: "small-talk", reply: REPLIES.farewell };
  if (ACKS.has(text)) return { intent: "small-talk", reply: REPLIES.ack };

  return { intent: "question" };
}
