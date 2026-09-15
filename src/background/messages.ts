/**
 * Typed message contract between the side panel, service worker and offscreen
 * document. A single discriminated union keeps every hop type-safe.
 */

import type { CrawlConfig } from "@/domain/config.js";
import type { CrawlPreview } from "@/crawl/preview.js";
import type { PanelEvent } from "@/shared/answer.js";
import type { ImportProgress } from "@/offscreen/importCorpusJob.js";
import type { Settings } from "@/settings/settings.js";

export interface CrawlProgress {
  readonly fetched: number;
  readonly queued: number;
  readonly failed: number;
  readonly skipped: number;
  readonly embedded: number;
  readonly currentUrl: string | null;
  readonly phase: "idle" | "discovering" | "crawling" | "embedding" | "paused" | "done" | "error";
  /** Set when the crawl is blocked on authentication (PRD 5.2.8). */
  readonly authWall?: { host: string; blocked: number; kind: "session" | "basic" };
  /** Set while a final retry pass over transient failures is running (5.2.5). */
  readonly retrying?: number;
  /** Pages a 304 confirmed unchanged during an incremental recrawl (5.6.5). */
  readonly unchanged?: number;
}

export type Message =
  | { readonly type: "crawl/start"; readonly config: CrawlConfig }
  /** Dry run: discover + count + estimate, fetch nothing (PRD 5.1.4). */
  | { readonly type: "crawl/preview"; readonly requestId: string; readonly config: CrawlConfig }
  | { readonly type: "crawl/preview-result"; readonly requestId: string; readonly preview: CrawlPreview | null; readonly error?: string }
  | {
      readonly type: "crawl/recrawl";
      readonly indexId: string;
      /**
       * A scheduled refresh rather than one the user asked for. Runs throttled,
       * and yields the machine back the moment the user returns (5.6.6).
       */
      readonly background?: boolean;
    }
  /**
   * The user came back to the keyboard: pause the crawl *if* it is a background
   * one. A crawl the user started and is watching must not be touched, which is
   * why this is a distinct message rather than a plain `crawl/pause`.
   */
  | { readonly type: "crawl/yield" }
  /** The machine went idle again: resume a background crawl we previously yielded. */
  | { readonly type: "crawl/unyield" }
  | {
      readonly type: "crawl/recrawl-full";
      readonly indexId: string;
      /** Edited settings for this re-crawl; the stored config is reused when absent. */
      readonly config?: CrawlConfig;
    }
  /**
   * Rebuild an index from an exported corpus instead of crawling.
   *
   * The corpus travels as a blob URL rather than in the message: an export of a
   * 1,400-page site is several megabytes, and extension pages share an origin
   * so the offscreen document can fetch a URL the options page created. The
   * options page must stay open until the import finishes — it owns the blob.
   */
  | { readonly type: "index/import"; readonly url: string }
  | { readonly type: "index/import-progress"; readonly progress: ImportProgress }
  | { readonly type: "crawl/pause" }
  | { readonly type: "crawl/resume" }
  | { readonly type: "crawl/progress"; readonly progress: CrawlProgress }
  | { readonly type: "ensure-offscreen" }
  /** Asks every context to release its database handle so it can be deleted. */
  | { readonly type: "db/close" }
  /** Offscreen → worker: render a JS-heavy page in a tab (PRD 5.2.11). */
  | { readonly type: "render/page"; readonly url: string }
  | { readonly type: "panel/open" }
  /**
   * Load the embedder and the index session before anything is asked.
   *
   * Both are lazy and both are slow — the ONNX weights are 33 MB and a cold
   * session load measures 350–1000 ms at 15k chunks — so the first question of
   * every panel session paid for them while the user watched. Nothing about
   * that work depends on the question, so it can happen the moment the panel
   * knows which index is active.
   */
  | { readonly type: "query/warm"; readonly indexId: string }
  | {
      readonly type: "query/ask";
      readonly requestId: string;
      readonly indexId: string;
      readonly query: string;
      /** The page the user is reading, for the section boost (PRD 5.7). */
      readonly currentUrl?: string;
      /**
       * Earlier questions in this conversation, most recent first. Retrieval
       * uses them to resolve a follow-up ("and for admins?") against the turn
       * it depends on — without them the panel shows the context and the search
       * cannot see it.
       */
      readonly recentQuestions?: readonly string[];
      /**
       * Restrict retrieval to one page. Set when the question came from a
       * refinement chip, where the user named an exact document rather than
       * describing one.
       */
      readonly focusUrl?: string;
      /** The question that pick answered, for the learned prior. */
      readonly pickedFor?: string;
      /**
       * The user's settings, read by the panel and sent with the query.
       *
       * The offscreen document is the only context that read settings for
       * itself, and it is the least ordinary one — a hidden document with a
       * restricted API surface. When its read disagreed with the panel's, the
       * result was a silent, confident, wrong claim: "Answered with Gemini
       * Nano · on-device" beside an Options page showing OpenAI selected with a
       * working key. Nothing errored, because a settings read that quietly
       * returns defaults looks exactly like a user who chose the defaults.
       *
       * The panel reads storage all day for the switcher, starters and index
       * info, so it is the reliable reader. Sending what it read removes the
       * disagreement rather than trying to detect it. The offscreen doc still
       * falls back to its own read when this is absent (a crawl-triggered
       * query, an older panel build).
       *
       * The BYOK key rides along. That is extension-internal messaging, not
       * egress — the key is already in chrome.storage.local and goes nowhere
       * else but the provider the user chose.
       */
      readonly settings?: Settings;
    }
  /**
   * Abandon a question already in flight.
   *
   * The panel had no way to say this, and the absence was load-bearing: with no
   * deadline on the provider fetch (see `byok.ts`) a stalled turn sat in
   * "writing…" with its message listener attached and `done` never emitted, and
   * the only escape was closing the panel. A deadline fixes the hang; this
   * fixes the *wait* — a user who has changed their mind after four seconds
   * should not have to sit out a forty-second timeout to ask something else.
   *
   * Carries the `requestId` rather than cancelling "the current query", because
   * a refinement chip can start a second turn while the first is still
   * streaming, and cancelling the wrong one is worse than cancelling nothing.
   */
  | { readonly type: "query/cancel"; readonly requestId: string }
  | { readonly type: "query/event"; readonly requestId: string; readonly event: PanelEvent };

/** Narrowing helper so listeners can switch on `msg.type` exhaustively. */
export function isMessage(value: unknown): value is Message {
  return typeof value === "object" && value !== null && "type" in value;
}
