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

export interface IndexOption {
  readonly id: string;
  readonly label: string;
  readonly host: string;
  readonly pageCount: number;
  readonly lastIndexedAt: number;
}

export interface PanelIndexes {
  readonly options: readonly IndexOption[];
  readonly activeId: string | null;
}

function toOption(meta: IndexMeta): IndexOption {
  return {
    id: meta.id,
    label: meta.title || meta.host,
    host: meta.host,
    pageCount: meta.pageCount,
    lastIndexedAt: meta.lastIndexedAt,
  };
}

/** Every index, plus which one is active — defaulting to the newest. */
export async function loadIndexes(): Promise<PanelIndexes> {
  const db = await openSherpaDb();
  const metas = await indexRepo.list(db);
  const options = metas.map(toOption);
  const settings = await loadSettings();

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
 * Starter questions from the index's own top-level headings (PRD 5.9.7) — a
 * real empty state beats three invented questions about a site the user may
 * not have indexed.
 */
export async function starterQuestions(indexId: string, limit = 3): Promise<string[]> {
  const db = await openSherpaDb();
  const chunks = await chunkStore.listByIndex(db, indexId);

  const seen = new Set<string>();
  const topics: string[] = [];
  for (const chunk of chunks) {
    // Last segment of the heading path is the most specific label.
    const topic = chunk.headingPath.split(" > ").pop()?.trim();
    if (!topic || topic.length < 4 || topic.length > 60) continue;
    const key = topic.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    topics.push(topic);
    if (topics.length >= limit) break;
  }
  return topics.map((t) => `How do I ${t.charAt(0).toLowerCase()}${t.slice(1)}?`);
}
