/**
 * What the panel needs to know about the indexes on this device: which sites
 * are available (5.6.6), how fresh the active one is (5.6.2), and a few starter
 * questions derived from its own headings (5.9.7).
 *
 * The panel reads IndexedDB directly — it's the same origin as the offscreen
 * document, and these are cheap metadata reads that don't need a round trip.
 */

import type { IndexMeta } from "@/domain/records.js";
import { openSherpaDb } from "@/storage/db.js";
import { indexRepo } from "@/storage/indexRepo.js";
import { chunkStore } from "@/storage/chunks.js";
import { loadSettings, saveSettings } from "@/settings/settings.js";
import { buildStarters, type StarterSource } from "./starters.js";
import { DEFAULT_EMBEDDING_MODEL_ID } from "@/embed/models.js";

export interface IndexOption {
  readonly id: string;
  readonly label: string;
  readonly host: string;
  readonly pageCount: number;
  readonly lastIndexedAt: number;
  /**
   * True when this index's vectors came from a different embedding model.
   * Querying it would compare incomparable vectors, so the UI asks for a
   * rebuild rather than returning confident nonsense.
   */
  readonly needsRebuild: boolean;
}

export interface PanelIndexes {
  readonly options: readonly IndexOption[];
  readonly activeId: string | null;
}

function toOption(meta: IndexMeta, selectedModel: string): IndexOption {
  return {
    id: meta.id,
    label: meta.title || meta.host,
    host: meta.host,
    pageCount: meta.pageCount,
    lastIndexedAt: meta.lastIndexedAt,
    needsRebuild: (meta.embeddingModel ?? "") !== selectedModel,
  };
}

/** Every index, plus which one is active — defaulting to the newest. */
export async function loadIndexes(): Promise<PanelIndexes> {
  const db = await openSherpaDb();
  const metas = await indexRepo.list(db);
  const settings = await loadSettings();
  const selectedModel = settings.embeddingModel ?? DEFAULT_EMBEDDING_MODEL_ID;
  const options = metas.map((m) => toOption(m, selectedModel));

  const active =
    (settings.activeIndexId && options.some((o) => o.id === settings.activeIndexId)
      ? settings.activeIndexId
      : options[0]?.id) ?? null;

  return { options, activeId: active };
}

export async function setActiveIndex(indexId: string): Promise<void> {
  await saveSettings({ activeIndexId: indexId });
}

/** "indexed 12 days ago" (PRD 5.6.2). */
export function freshnessLabel(lastIndexedAt: number, now = Date.now()): string {
  const days = Math.floor((now - lastIndexedAt) / 86_400_000);
  if (days <= 0) return "indexed today";
  if (days === 1) return "indexed yesterday";
  return `indexed ${days} days ago`;
}

/** An index older than a week gets the amber treatment and a refresh nudge. */
export function isStale(lastIndexedAt: number, now = Date.now()): boolean {
  return now - lastIndexedAt > 7 * 86_400_000;
}

/**
 * Starter questions from the index's own content (PRD 5.9.7).
 *
 * One entry per page, weighted by how much text it holds, so substantial
 * guides win over stubs. Phrasing and filtering live in starters.ts.
 */
export async function starterQuestions(indexId: string, limit = 3): Promise<string[]> {
  const db = await openSherpaDb();
  const chunks = await chunkStore.listByIndex(db, indexId);
  if (chunks.length === 0) return [];

  const pages = new Map<string, StarterSource>();
  for (const chunk of chunks) {
    const existing = pages.get(chunk.url);
    if (existing) {
      pages.set(chunk.url, { ...existing, weight: existing.weight + chunk.body.length });
      continue;
    }
    pages.set(chunk.url, {
      title: chunk.title,
      headingPath: chunk.headingPath,
      weight: chunk.body.length,
    });
  }

  // A sample is enough to tell whether the corpus covers a generic topic, and
  // avoids concatenating an entire 15k-chunk index on every panel open.
  const sample = chunks
    .slice(0, 400)
    .map((c) => `${c.title} ${c.headingPath} ${c.body}`)
    .join(" ");

  return buildStarters([...pages.values()], sample, limit);
}
