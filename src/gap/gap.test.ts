import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { isFailed, jaccard, clusterFailures, buildGapReport, toCSV, toMarkdown, type QueryStat } from "./gap.js";
import { queryLogStore } from "./queryLog.js";
import { openSherpaDb } from "@/storage/db.js";

describe("gap logic", () => {
  it("flags failures below the floor, unanswered, or 👎", () => {
    expect(isFailed({ query: "x", topScore: 0.2, answered: true }, 0.45)).toBe(true);
    expect(isFailed({ query: "x", topScore: 0.9, answered: false }, 0.45)).toBe(true);
    expect(isFailed({ query: "x", topScore: 0.9, answered: true, feedback: "down" }, 0.45)).toBe(true);
    expect(isFailed({ query: "x", topScore: 0.9, answered: true }, 0.45)).toBe(false);
  });

  it("jaccard measures token overlap", () => {
    expect(jaccard("reset my password", "reset the password")).toBeGreaterThan(0.3);
    expect(jaccard("reset password", "delete webhook")).toBe(0);
  });

  it("clusters similar failed queries and ranks by volume", () => {
    const failed: QueryStat[] = [
      { query: "how to reset password", topScore: 0.1, answered: false },
      { query: "reset password steps", topScore: 0.2, answered: false },
      { query: "reset the password now", topScore: 0.15, answered: false },
      { query: "configure webhook retries", topScore: 0.2, answered: false },
    ];
    const report = buildGapReport(clusterFailures(failed));
    expect(report[0]?.count).toBe(3); // the password cluster dominates
    expect(report[0]?.topic).toContain("password");
    expect(report).toHaveLength(2);
  });

  it("exports CSV and Markdown", () => {
    const rows = buildGapReport(clusterFailures([{ query: "reset password", topScore: 0.1, answered: false }]));
    expect(toCSV(rows)).toContain("topic,count,avg_score,examples");
    expect(toMarkdown(rows)).toContain("| Topic | Asks | Avg score |");
  });
});

describe("queryLogStore", () => {
  let seq = 0;
  it("logs, lists, and attaches feedback", async () => {
    const db = await openSherpaDb(`gap-test-${seq++}`);
    await queryLogStore.log(db, { indexId: "i", query: "reset password", topScore: 0.1, answered: false, at: 1 });
    await queryLogStore.log(db, { indexId: "i", query: "reset password", topScore: 0.1, answered: false, at: 2 });
    expect(await queryLogStore.listByIndex(db, "i")).toHaveLength(2);
    await queryLogStore.setFeedback(db, "i", "reset password", "down");
    const latest = (await queryLogStore.listByIndex(db, "i")).find((e) => e.at === 2);
    expect(latest?.feedback).toBe("down");
  });
});
