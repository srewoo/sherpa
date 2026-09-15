/**
 * Heading-aware chunking (PRD 5.4).
 *
 * Invariants this module guarantees:
 *  - boundaries respect H2/H3 — a chunk never straddles a section heading;
 *  - code blocks, tables and lists are atomic — never split across chunks;
 *  - every chunk's embedded text is prefixed with breadcrumb + heading path;
 *  - a page under `mergeBelow` tokens becomes a single chunk, not a fragment;
 *  - prose flushes carry ~`overlapRatio` of trailing sentences into the next
 *    chunk so procedures aren't severed mid-step.
 */

import type { Block, ChunkDraft, PageContext } from "@/domain/content.js";

export interface ChunkOptions {
  readonly targetTokens: number;
  readonly maxTokens: number;
  readonly mergeBelow: number;
  readonly overlapRatio: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  targetTokens: 350,
  maxTokens: 400,
  mergeBelow: 120,
  overlapRatio: 0.15,
};

const ATOMIC: ReadonlySet<Block["type"]> = new Set(["code", "table", "list"]);

/**
 * Rough token estimate: ~0.75 words per token, with a floor on characters.
 *
 * The word count alone is defeated by anything that does not use spaces. A
 * 100 KB unbroken string — minified script that escaped extraction, a base64
 * blob, a long hash, CJK text — counts as *one word*, so this returned 2 and
 * every size check downstream waved it through: `toUnits` saw no oversized
 * paragraph, the splitter never ran, and the chunk went to the embedder to be
 * silently truncated. Found by `extract/fuzz.test.ts`.
 *
 * The floor is inert for ordinary prose. English averages about 5.5 characters
 * per word including the space, so the word estimate already works out near
 * `chars / 4.1` — comfortably above `chars / 6`, which therefore never binds.
 * It only takes over when the whitespace the word count depends on is missing,
 * which is exactly the case the word count cannot see.
 */
export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  return Math.max(Math.ceil(words / 0.75), Math.ceil(trimmed.length / 6));
}

interface HeadingFrame {
  readonly level: number;
  readonly text: string;
  readonly anchor: string | undefined;
}

/** Maintain a heading stack and return the "A > B > C" path string. */
function pushHeading(stack: HeadingFrame[], block: Block): void {
  const level = block.level ?? 2;
  while (stack.length && (stack[stack.length - 1]?.level ?? 0) >= level) {
    stack.pop();
  }
  stack.push({ level, text: block.text.trim(), anchor: block.anchor });
}

/**
 * The breadcrumb + heading path prefixed to every chunk's embedded text
 * (PRD 5.4.4).
 *
 * Consecutive repeats are collapsed, and for good reason: a site whose
 * breadcrumb markup double-counts its crumbs, or whose breadcrumb ends with the
 * same word the first heading starts with, prefixes *every chunk in the index*
 * with the same run of boilerplate — "Help & Support > Help & Support > Help
 * Center Home > Help Center Home > …". Mean-pooled into a 384-dim vector that
 * boilerplate dilutes the content signal and pulls every chunk toward the same
 * point, which flattens the score range and buries the article that actually
 * answers the question.
 */
function pathString(ctx: PageContext, stack: readonly HeadingFrame[]): string {
  const parts = [...ctx.breadcrumb, ...stack.map((h) => h.text)]
    .map((p) => p.trim())
    .filter(Boolean);

  const deduped: string[] = [];
  for (const part of parts) {
    if (deduped[deduped.length - 1]?.toLowerCase() === part.toLowerCase()) continue;
    deduped.push(part);
  }
  return deduped.join(" > ");
}

/**
 * Sentence terminators, Latin and otherwise.
 *
 * `.!?` alone treats a page of Chinese or Japanese documentation as a single
 * sentence — those scripts end sentences with `\u3002`, and `\uFF01` / `\uFF1F`
 * are the full-width exclamation and question marks. Without them the splitter
 * returns one piece, the packer cannot break it, and every paragraph on the
 * page becomes one oversized chunk. Arabic's `\u061F` is here for the same
 * reason.
 */
const TERMINATORS = ".!?\u3002\uFF01\uFF1F\u061F\u06D4";

function splitSentences(text: string): string[] {
  const re = new RegExp(`[^${TERMINATORS}]+[${TERMINATORS}]+|\\S[^${TERMINATORS}]*$`, "g");
  const matched = text.match(re);
  const trimmed = (matched ?? [text]).map((s) => s.trim()).filter(Boolean);
  return trimmed.length ? trimmed : [text.trim()];
}

/**
 * Break a single over-long "sentence" on word boundaries.
 *
 * Found by fuzzing, and it is not the exotic case it looks like. `packSentences`
 * only ever splits *between* sentences, so any run of text the splitter returns
 * whole — a paragraph with no terminating punctuation at all — passed through
 * however large it was. Real sources do this constantly: flattened tables, log
 * output pasted into a page, machine-generated reference lists, and any script
 * whose terminators were missing from the pattern above.
 *
 * The consequence was silent and expensive. An oversized chunk is truncated by
 * the embedder, so its vector describes the first few hundred tokens while the
 * stored text describes the whole passage — the page ranks badly for content it
 * visibly contains, and nothing anywhere reports a problem.
 *
 * Falls back to a hard character slice when there are no spaces either (a
 * minified blob, or a script that does not use them), because a piece that
 * cannot be split is the one case where returning it unchanged reintroduces
 * exactly the bug.
 */
function sliceOnCharacters(text: string, target: number): string[] {
  // ~0.75 words per token at roughly 5 characters a word, matching what
  // `estimateTokens` assumes, so the pieces land near the target rather than
  // at some unrelated size.
  const size = Math.max(1, Math.floor(target * 0.75 * 5));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function splitLongRun(text: string, target: number): string[] {
  if (estimateTokens(text) <= target) return [text];
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur: string[] = [];
  let tokens = 0;
  const flushCur = (): void => {
    if (cur.length) out.push(cur.join(" "));
    cur = [];
    tokens = 0;
  };

  for (const word of words) {
    const wt = estimateTokens(word);
    /**
     * A single word can be over the ceiling on its own, and packing words can
     * never break one apart.
     *
     * This was the second half of the same bug, and it survived the first fix.
     * A paragraph of "<5000 x's> and four short words" has five words, so the
     * word-packing path ran instead of the character slicer — and then emitted
     * the 5000-character word as one 834-token piece, because every branch in
     * that loop moves whole words. Real pages produce exactly this shape: a
     * minified blob or a base64 payload with a few words of prose beside it.
     */
    if (wt > target) {
      flushCur();
      out.push(...sliceOnCharacters(word, target));
      continue;
    }
    if (tokens > 0 && tokens + wt > target) flushCur();
    cur.push(word);
    tokens += wt;
  }
  flushCur();
  return out;
}

/** Last ~ratio of sentences of a prose string, for overlap. */
function overlapTail(text: string, ratio: number): string {
  const sentences = splitSentences(text);
  if (sentences.length <= 1) return "";
  const keep = Math.max(1, Math.round(sentences.length * ratio));
  return sentences.slice(-keep).join(" ").trim();
}

/** Greedily pack sentences into ~target-sized pieces so no piece busts the ceiling. */
function packSentences(text: string, target: number): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let tokens = 0;
  // `splitLongRun` is applied per sentence, not to the whole string: a
  // paragraph of ordinary sentences still breaks on sentence boundaries, and
  // only a run that is itself too long gets broken mid-sentence.
  for (const sentence of splitSentences(text)) {
    for (const s of splitLongRun(sentence, target)) {
      const st = estimateTokens(s);
      if (tokens > 0 && tokens + st > target) {
        out.push(cur.join(" "));
        cur = [];
        tokens = 0;
      }
      cur.push(s);
      tokens += st;
    }
  }
  if (cur.length) out.push(cur.join(" "));
  return out;
}

/** Pre-split any paragraph larger than the target into target-sized pieces. */
function toUnits(blocks: readonly Block[], target: number): Block[] {
  const units: Block[] = [];
  for (const b of blocks) {
    if (b.type === "paragraph" && estimateTokens(b.text) > target) {
      for (const piece of packSentences(b.text, target)) {
        units.push({ type: "paragraph", text: piece });
      }
    } else {
      units.push(b);
    }
  }
  return units;
}

/** Split a page's blocks into chunk drafts. */
export function chunkPage(
  blocks: readonly Block[],
  ctx: PageContext,
  opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): ChunkDraft[] {
  const drafts: ChunkDraft[] = [];
  const stack: HeadingFrame[] = [];
  let buffer: string[] = [];
  let bufTokens = 0;
  let position = 0;

  const flush = (carry: string): void => {
    const body = buffer.join("\n\n").trim();
    if (body === "") {
      buffer = carry ? [carry] : [];
      bufTokens = carry ? estimateTokens(carry) : 0;
      return;
    }
    const heading = pathString(ctx, stack);
    const prefix = heading ? `${heading}:\n` : "";
    drafts.push({
      text: `${prefix}${body}`,
      body,
      headingPath: heading,
      anchor: stack[stack.length - 1]?.anchor,
      position: position++,
    });
    buffer = carry ? [carry] : [];
    bufTokens = carry ? estimateTokens(carry) : 0;
  };

  for (const block of toUnits(blocks, opts.targetTokens)) {
    if (block.type === "heading") {
      if (bufTokens > 0) flush("");
      pushHeading(stack, block);
      continue;
    }

    const blockTokens = estimateTokens(block.text);
    const atomic = ATOMIC.has(block.type);

    // Flush before an atomic block that would bust the ceiling, so it lands
    // whole in a fresh chunk rather than being split.
    if (bufTokens > 0 && bufTokens + blockTokens > opts.maxTokens) {
      const carry = atomic ? "" : overlapTail(buffer.join(" "), opts.overlapRatio);
      flush(carry);
    }

    buffer.push(block.text);
    bufTokens += blockTokens;

    // Prose can flush at target; atomic blocks already landed whole above.
    if (!atomic && bufTokens >= opts.targetTokens) {
      flush(overlapTail(block.text, opts.overlapRatio));
    }
  }

  if (bufTokens > 0) flush("");

  return mergeSmallPage(drafts, ctx, opts);
}

/**
 * Small-page merge (PRD 5.4.6). Heading boundaries mean a short page — an FAQ
 * entry, a stub, a "see also" — comes out as several tiny fragments, each too
 * thin to retrieve well and each costing a vector. When the whole page fits
 * under `mergeBelow`, collapse it into one chunk that carries the page's own
 * heading path.
 */
function mergeSmallPage(
  drafts: readonly ChunkDraft[],
  ctx: PageContext,
  opts: ChunkOptions,
): ChunkDraft[] {
  if (drafts.length <= 1) return [...drafts];

  const body = drafts.map((d) => d.body).join("\n\n");
  if (estimateTokens(body) >= opts.mergeBelow) return [...drafts];

  // Prefer the page's breadcrumb + title as the path; fall back to the first
  // chunk's heading path when the page has no breadcrumb.
  const path = [...ctx.breadcrumb, ctx.title].filter(Boolean).join(" > ") || (drafts[0]?.headingPath ?? "");
  const prefix = path ? `${path}:\n` : "";

  return [
    {
      text: `${prefix}${body}`,
      body,
      headingPath: path,
      anchor: drafts[0]?.anchor,
      position: 0,
    },
  ];
}
