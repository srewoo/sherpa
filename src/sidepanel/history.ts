/**
 * Chat history for the side panel (PRD 5.9.9): saving the running conversation
 * and reloading an earlier one.
 *
 * Translates between the panel's view models and the persisted shape. A turn is
 * only saved once its answer has finished streaming, so history never holds a
 * half-written answer.
 */

import type { ChatSession, StoredTurn } from "@/domain/records.js";
import { openSherpaDb } from "@/storage/db.js";
import { chatRepo } from "@/storage/chatRepo.js";
import { hasExtension } from "./client.js";
import type { SourceView, Turn } from "./types.js";
import type { RefusalReason } from "@/generator/answerService.js";

export interface HistoryEntry {
  readonly id: string;
  readonly title: string;
  readonly turnCount: number;
  readonly updatedAt: number;
}

/** A conversation the panel can persist. */
export interface LiveSession {
  readonly id: string;
  readonly indexId: string;
  readonly createdAt: number;
}

export function newSession(indexId: string, now = Date.now()): LiveSession {
  // Random suffix so two panels opened in the same millisecond can't collide.
  return { id: `s-${now}-${Math.random().toString(36).slice(2, 8)}`, indexId, createdAt: now };
}

function toStored(turn: Turn, at: number): StoredTurn | null {
  const { answer } = turn;
  if (answer.kind === "refusal") {
    return {
      question: turn.question,
      markdown: "",
      tier: "extractive",
      refused: true,
      // Persist why, so reopening a conversation doesn't invent a reason.
      refusalReason: answer.reason,
      sources: answer.nearest.map((s) => ({ ...s })),
      at,
    };
  }
  // A disambiguation is a question back to the user, not an answer — there is
  // nothing to replay, and saving it would restore chips whose options came
  // from a search that is no longer running.
  if (answer.kind === "disambiguation") return null;
  // Still streaming — wait for it to settle.
  if (answer.pending) return null;
  return {
    question: turn.question,
    markdown: answer.markdown,
    tier: answer.tier,
    refused: false,
    sources: answer.sources.map((s) => ({ ...s })),
    at,
  };
}

/** Persist the finished turns of the running conversation. */
export async function saveSession(
  session: LiveSession,
  turns: readonly Turn[],
  now = Date.now(),
): Promise<void> {
  if (!hasExtension) return;
  const stored = turns.map((t) => toStored(t, now)).filter((t): t is StoredTurn => t !== null);
  if (stored.length === 0) return;

  const db = await openSherpaDb();
  await chatRepo.save(db, { ...session, turns: stored }, now);
}

export async function listHistory(indexId: string): Promise<HistoryEntry[]> {
  if (!hasExtension) return [];
  const db = await openSherpaDb();
  const sessions = await chatRepo.listByIndex(db, indexId);
  return sessions.map((s) => ({
    id: s.id,
    title: s.title,
    turnCount: s.turns.length,
    updatedAt: s.updatedAt,
  }));
}

/** Rebuild panel turns from a saved conversation. */
export function toTurns(session: ChatSession): Turn[] {
  return session.turns.map((t, i) => ({
    id: `${session.id}-${i}`,
    question: t.question,
    answer: t.refused
      ? {
          kind: "refusal" as const,
          nearest: t.sources as readonly SourceView[],
          // Conversations saved before the reason was recorded can't claim one.
          reason: (t.refusalReason ?? "unknown") as RefusalReason,
        }
      : {
          kind: "answer" as const,
          tier: t.tier,
          markdown: t.markdown,
          html: "", // re-rendered by the caller, which owns the markdown renderer
          sources: t.sources as readonly SourceView[],
        },
  }));
}

export async function loadSession(id: string): Promise<ChatSession | undefined> {
  if (!hasExtension) return undefined;
  const db = await openSherpaDb();
  return chatRepo.get(db, id);
}

export async function deleteSession(id: string): Promise<void> {
  if (!hasExtension) return;
  const db = await openSherpaDb();
  await chatRepo.remove(db, id);
}

export async function clearHistory(indexId: string): Promise<void> {
  if (!hasExtension) return;
  const db = await openSherpaDb();
  await chatRepo.clearIndex(db, indexId);
}

/** "2 hours ago" / "yesterday" — compact enough for a 400px panel. */
export function relativeTime(ts: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}
