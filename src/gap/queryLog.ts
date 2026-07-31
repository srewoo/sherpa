/**
 * Query-log repository (PRD 5.11.1). Every query is logged locally with its top
 * retrieval score and whether it was answered, feeding the gap report. Feedback
 * (👍/👎) updates the most recent matching entry.
 */

import type { QueryLogEntry } from "@/storage/schema.js";
import type { SherpaDatabase } from "@/storage/db.js";

export const queryLogStore = {
  async log(db: SherpaDatabase, entry: QueryLogEntry): Promise<void> {
    await db.add("queryLog", entry);
  },

  listByIndex(db: SherpaDatabase, indexId: string): Promise<QueryLogEntry[]> {
    return db.getAllFromIndex("queryLog", "byIndex", indexId);
  },

  /** Attach feedback to the latest entry matching this query (PRD 5.9.8). */
  async setFeedback(db: SherpaDatabase, indexId: string, query: string, feedback: "up" | "down"): Promise<void> {
    const entries = await db.getAllFromIndex("queryLog", "byIndex", indexId);
    const latest = entries.filter((e) => e.query === query).sort((a, b) => b.at - a.at)[0];
    if (latest?.id !== undefined) await db.put("queryLog", { ...latest, feedback });
  },
};
