/**
 * Query-log repository (PRD 5.11.1). Every query is logged locally with its top
 * retrieval score and whether it was answered, feeding the gap report. Feedback
 * (👍/👎) updates the most recent matching entry.
 */

import type { QueryLogEntry } from "@/storage/schema.js";
import type { SherpaDatabase } from "@/storage/db.js";
import { maskPii } from "@/lib/pii.js";

export const queryLogStore = {
  /**
   * Log a query, with personal data redacted first.
   *
   * This log is kept indefinitely and its clusters are surfaced in a gap report
   * built to be exported as CSV and handed to a docs team — so a question like
   * "why can't sarah.chen@acme.com log in" was on a path out of the machine,
   * in a product whose central promise is that nothing leaves it. Masking at
   * the write is the only place that fixes every reader at once.
   *
   * `pickedFor` is masked too: it is a question the user typed, with exactly
   * the same exposure as `query`, and it feeds the learned prior.
   */
  async log(db: SherpaDatabase, entry: QueryLogEntry): Promise<void> {
    await db.add("queryLog", {
      ...entry,
      query: maskPii(entry.query),
      ...(entry.pickedFor ? { pickedFor: maskPii(entry.pickedFor) } : {}),
    });
  },

  listByIndex(db: SherpaDatabase, indexId: string): Promise<QueryLogEntry[]> {
    return db.getAllFromIndex("queryLog", "byIndex", indexId);
  },

  /**
   * Attach feedback to the latest entry matching this query (PRD 5.9.8).
   *
   * The needle is masked before comparison. The panel holds the question as the
   * user typed it and the log holds it masked, so matching raw against stored
   * silently finds nothing for any question containing an email — and the
   * thumbs-up would appear to work while recording nothing at all.
   */
  async setFeedback(db: SherpaDatabase, indexId: string, query: string, feedback: "up" | "down"): Promise<void> {
    const needle = maskPii(query);
    const entries = await db.getAllFromIndex("queryLog", "byIndex", indexId);
    const latest = entries.filter((e) => e.query === needle).sort((a, b) => b.at - a.at)[0];
    if (latest?.id !== undefined) await db.put("queryLog", { ...latest, feedback });
  },
};
