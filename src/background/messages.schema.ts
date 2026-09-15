/**
 * Runtime validation for the message seam.
 *
 * `messages.ts` describes the contract in types, and types evaporate at the
 * boundary. `isMessage` checked `typeof value === "object" && "type" in value`,
 * which accepts `{ type: "query/ask" }` with nothing else in it — and the
 * handler then destructures `requestId`, `indexId` and `query` into `undefined`
 * and proceeds. The failure surfaces much later as a query against index
 * `undefined`, several hops from the message that caused it.
 *
 * This is a drift guard, not a security boundary. Every sender is our own code
 * in the same extension, so the threat is not a hostile message — it is a
 * `query/ask` gaining a required field in one context and being sent from
 * another that was not updated, which typechecks in both files and fails only
 * at runtime. Echo has the same seam between its Python service and its Go KB
 * and pins it with a cross-language contract test; this is the browser-shaped
 * version of that.
 *
 * Nested payloads that already have their own validation elsewhere — a crawl
 * config, a settings object, a panel event — are checked for *shape* rather
 * than re-specified here. Two descriptions of the same structure drift apart,
 * and the seam's job is to catch a malformed envelope, not to become a second
 * source of truth about what a `CrawlConfig` is.
 */

import { z } from "zod";
import type { Message } from "./messages.js";

/** A non-empty string. Almost every id on this seam is one, and `""` is a bug. */
const id = z.string().min(1);

/**
 * An object payload, unspecified beyond being one.
 *
 * `passthrough` rather than a mirrored schema: the sender's type already
 * describes it, and duplicating a 40-field `CrawlConfig` here would guarantee
 * the two drift. What this catches is the case that actually happens — the
 * field missing altogether, or arriving as a string.
 */
const objectPayload = z.object({}).passthrough();

const schemas = {
  "crawl/start": z.object({ type: z.literal("crawl/start"), config: objectPayload }),
  "crawl/preview": z.object({
    type: z.literal("crawl/preview"),
    requestId: id,
    config: objectPayload,
  }),
  "crawl/preview-result": z.object({
    type: z.literal("crawl/preview-result"),
    requestId: id,
    preview: objectPayload.nullable(),
    error: z.string().optional(),
  }),
  "crawl/recrawl": z.object({
    type: z.literal("crawl/recrawl"),
    indexId: id,
    background: z.boolean().optional(),
  }),
  "crawl/yield": z.object({ type: z.literal("crawl/yield") }),
  "crawl/unyield": z.object({ type: z.literal("crawl/unyield") }),
  "crawl/recrawl-full": z.object({
    type: z.literal("crawl/recrawl-full"),
    indexId: id,
    config: objectPayload.optional(),
  }),
  "index/import": z.object({ type: z.literal("index/import"), url: id }),
  "index/import-progress": z.object({
    type: z.literal("index/import-progress"),
    progress: objectPayload,
  }),
  "crawl/pause": z.object({ type: z.literal("crawl/pause") }),
  "crawl/resume": z.object({ type: z.literal("crawl/resume") }),
  "crawl/progress": z.object({ type: z.literal("crawl/progress"), progress: objectPayload }),
  "ensure-offscreen": z.object({ type: z.literal("ensure-offscreen") }),
  "db/close": z.object({ type: z.literal("db/close") }),
  "render/page": z.object({ type: z.literal("render/page"), url: id }),
  "panel/open": z.object({ type: z.literal("panel/open") }),
  "query/warm": z.object({ type: z.literal("query/warm"), indexId: id }),
  "query/ask": z.object({
    type: z.literal("query/ask"),
    requestId: id,
    indexId: id,
    // Not `.min(1)`: the panel already refuses an empty question, and rejecting
    // it here would turn a guard into a second, silent place that decides what
    // counts as a question.
    query: z.string(),
    currentUrl: z.string().optional(),
    recentQuestions: z.array(z.string()).optional(),
    focusUrl: z.string().optional(),
    pickedFor: z.string().optional(),
    settings: objectPayload.optional(),
  }),
  "query/cancel": z.object({ type: z.literal("query/cancel"), requestId: id }),
  "query/event": z.object({
    type: z.literal("query/event"),
    requestId: id,
    // The discriminant is checked; the rest of the event is the panel's own
    // contract, tested in `shared/answer.ts`'s consumers.
    event: z.object({ kind: z.string().min(1) }).passthrough(),
  }),
} as const;

/**
 * Every `Message["type"]`, as runtime data.
 *
 * The `satisfies` is the load-bearing part: adding a variant to the `Message`
 * union without adding a schema here stops compiling, so validation cannot
 * silently fall behind the contract it validates. That is the entire failure
 * mode this file exists for.
 */
export const MESSAGE_TYPES = Object.keys(schemas) as readonly Message["type"][];

type SchemaMap = Record<Message["type"], z.ZodTypeAny>;
const _exhaustive = schemas satisfies SchemaMap;
void _exhaustive;

export interface ParseFailure {
  readonly ok: false;
  /** Present when the envelope named a type we know; absent when it did not. */
  readonly type?: string;
  readonly reason: string;
}

export type ParseResult = { readonly ok: true; readonly message: Message } | ParseFailure;

/**
 * Validate a message off the wire.
 *
 * Returns a result rather than throwing: a listener receives every message
 * broadcast in the extension, including ones addressed to a different context,
 * and throwing on those would turn routine traffic into errors.
 */
export function parseMessage(value: unknown): ParseResult {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return { ok: false, reason: "not a message envelope" };
  }
  const type = (value as { type: unknown }).type;
  if (typeof type !== "string") return { ok: false, reason: "type is not a string" };
  const schema = (schemas as Record<string, z.ZodTypeAny | undefined>)[type];
  if (!schema) return { ok: false, type, reason: "unknown message type" };
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      type,
      reason: parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; "),
    };
  }
  return { ok: true, message: parsed.data as Message };
}
