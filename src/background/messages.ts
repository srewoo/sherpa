/**
 * Typed message contract between the side panel, service worker and offscreen
 * document. A single discriminated union keeps every hop type-safe.
 */

import type { CrawlConfig } from "@/domain/config.js";
import type { PanelEvent } from "@/shared/answer.js";

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
}

export type Message =
  | { readonly type: "crawl/start"; readonly config: CrawlConfig }
  | { readonly type: "crawl/recrawl"; readonly indexId: string }
  | { readonly type: "crawl/pause" }
  | { readonly type: "crawl/resume" }
  | { readonly type: "crawl/progress"; readonly progress: CrawlProgress }
  | { readonly type: "ensure-offscreen" }
  | { readonly type: "panel/open" }
  | { readonly type: "query/ask"; readonly requestId: string; readonly indexId: string; readonly query: string }
  | { readonly type: "query/event"; readonly requestId: string; readonly event: PanelEvent };

/** Narrowing helper so listeners can switch on `msg.type` exhaustively. */
export function isMessage(value: unknown): value is Message {
  return typeof value === "object" && value !== null && "type" in value;
}
