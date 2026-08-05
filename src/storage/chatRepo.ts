/**
 * Chat history repository (PRD 5.9.9).
 *
 * Conversations are saved as they happen so a user can come back to an answer
 * they found yesterday — the support-agent case in §2, where the same question
 * recurs across tickets. History is capped at MAX_CHAT_SESSIONS and evicted
 * oldest-first, and never leaves the device (5.10.1).
 *
 * Not to be confused with `retrieval/session.ts`, which caches an index's
 * vectors in memory. This is the user's conversation history.
 */

import type { ChatSession, StoredTurn } from "@/domain/records.js";
import type { SherpaDatabase } from "./db.js";
import { MAX_CHAT_SESSIONS } from "./schema.js";

/** Label a conversation by its opening question, trimmed for the list. */
function titleFrom(turns: readonly StoredTurn[]): string {
  const first = turns[0]?.question.trim() ?? "New conversation";
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

export const chatRepo = {
  /**
   * Create or update a conversation. Called after each completed turn, so a
   * session that's abandoned mid-answer still keeps everything before it.
   */
  async save(
    db: SherpaDatabase,
    session: { id: string; indexId: string; turns: readonly StoredTurn[]; createdAt: number },
    now = Date.now(),
  ): Promise<void> {
    // An empty conversation isn't worth a history entry.
    if (session.turns.length === 0) return;

    await db.put("chatSessions", {
      id: session.id,
      indexId: session.indexId,
      title: titleFrom(session.turns),
      turns: session.turns,
      createdAt: session.createdAt,
      updatedAt: now,
    });
    await this.evict(db);
  },

  get(db: SherpaDatabase, id: string): Promise<ChatSession | undefined> {
    return db.get("chatSessions", id);
  },

  /** Most recent first — the order the history list shows. */
  async listByIndex(db: SherpaDatabase, indexId: string): Promise<ChatSession[]> {
    const rows = await db.getAllFromIndex("chatSessions", "byIndex", indexId);
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  },

  async listAll(db: SherpaDatabase): Promise<ChatSession[]> {
    const rows = await db.getAll("chatSessions");
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  },

  async remove(db: SherpaDatabase, id: string): Promise<void> {
    await db.delete("chatSessions", id);
  },

  async clearIndex(db: SherpaDatabase, indexId: string): Promise<void> {
    const tx = db.transaction("chatSessions", "readwrite");
    for (const row of await tx.store.index("byIndex").getAll(indexId)) {
      await tx.store.delete(row.id);
    }
    await tx.done;
  },

  async clearAll(db: SherpaDatabase): Promise<void> {
    await db.clear("chatSessions");
  },

  /** Trim to the cap, dropping the least recently used first. */
  async evict(db: SherpaDatabase, limit = MAX_CHAT_SESSIONS): Promise<number> {
    const count = await db.count("chatSessions");
    if (count <= limit) return 0;

    const tx = db.transaction("chatSessions", "readwrite");
    // byUpdated is ascending, so the oldest come first.
    const ordered = await tx.store.index("byUpdated").getAll();
    const excess = ordered.slice(0, count - limit);
    for (const row of excess) await tx.store.delete(row.id);
    await tx.done;
    return excess.length;
  },
};
