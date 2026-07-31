/**
 * Wire shapes shared between the offscreen answer service and the side panel.
 * Kept React-free so both contexts can import it. RetrievedChunks are mapped to
 * these light source cards before crossing the message boundary.
 */

import type { AnswerTier } from "@/domain/generator.js";
import type { RetrievedChunk } from "@/domain/retrieval.js";

export interface WireSource {
  readonly index: number;
  readonly title: string;
  readonly breadcrumb: string;
  readonly snippet: string;
  readonly relevance: number;
  readonly url: string;
  readonly displayUrl: string;
}

export type PanelEvent =
  | { readonly kind: "sources"; readonly tier: AnswerTier; readonly sources: readonly WireSource[] }
  | { readonly kind: "delta"; readonly delta: string }
  | { readonly kind: "refusal"; readonly nearest: readonly WireSource[] }
  | { readonly kind: "done" };

function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname).replace(/\/$/, "");
  } catch {
    return url;
  }
}

/** A text-fragment URL (#:~:text=) so the browser scrolls to and highlights the
 * passage in-page natively — no content script needed (PRD 5.9.5). */
function highlightUrl(chunk: RetrievedChunk): string {
  const words = chunk.body.replace(/\s+/g, " ").trim().split(" ").slice(0, 8).join(" ");
  if (!words) return chunk.anchor ? `${chunk.url}#${chunk.anchor}` : chunk.url;
  return `${chunk.url}#:~:text=${encodeURIComponent(words)}`;
}

/** Map a retrieved chunk to a source card. */
export function chunkToSource(chunk: RetrievedChunk, index: number): WireSource {
  return {
    index,
    title: chunk.title || chunk.headingPath || "Untitled",
    breadcrumb: chunk.headingPath.replace(/ > /g, " › "),
    snippet: chunk.body.slice(0, 200).trim() + (chunk.body.length > 200 ? "…" : ""),
    relevance: Math.max(1, Math.min(100, Math.round(chunk.score * 100))),
    url: highlightUrl(chunk),
    displayUrl: displayUrl(chunk.url),
  };
}
