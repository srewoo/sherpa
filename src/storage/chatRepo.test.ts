import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { openSherpaDb, type SherpaDatabase } from "./db.js";
import { chatRepo } from "./chatRepo.js";
import { MAX_CHAT_SESSIONS } from "./schema.js";
import type { StoredTurn } from "@/domain/records.js";

let seq = 0;
const freshDb = (): Promise<SherpaDatabase> => openSherpaDb(`chat-test-${seq++}`);

function turn(question: string, at = 1): StoredTurn {
  return {
    question,
    markdown: `Answer to ${question}`,
    tier: "nano",
    refused: false,
    sources: [],
    at,
  };
}

/** Ids are namespaced by index so seeding two indexes can't collide. */
function sessionId(indexId: string, i: number): string {
  return indexId === "i" ? `s${i}` : `${indexId}-s${i}`;
}

async function seedSessions(db: SherpaDatabase, count: number, indexId = "i"): Promise<void> {
  for (let i = 0; i < count; i++) {
    // updatedAt ascending, so session 0 is the oldest.
    await chatRepo.save(
      db,
      { id: sessionId(indexId, i), indexId, turns: [turn(`question ${i}`)], createdAt: i },
      1000 + i,
    );
  }
}

describe("chatRepo", () => {
  it("saves a conversation titled by its opening question", async () => {
    const db = await freshDb();
    await chatRepo.save(
      db,
      { id: "s1", indexId: "i", turns: [turn("how do I rotate a key"), turn("and for sandbox")], createdAt: 1 },
      5,
    );

    const saved = await chatRepo.get(db, "s1");
    expect(saved?.title).toBe("how do I rotate a key");
    expect(saved?.turns).toHaveLength(2);
    expect(saved?.updatedAt).toBe(5);
  });

  it("truncates a very long opening question for the list", async () => {
    const db = await freshDb();
    const long = "a".repeat(200);
    await chatRepo.save(db, { id: "s1", indexId: "i", turns: [turn(long)], createdAt: 1 });
    expect((await chatRepo.get(db, "s1"))?.title).toHaveLength(80);
  });

  it("does not persist an empty conversation", async () => {
    const db = await freshDb();
    await chatRepo.save(db, { id: "s1", indexId: "i", turns: [], createdAt: 1 });
    expect(await chatRepo.get(db, "s1")).toBeUndefined();
  });

  it("lists most recently updated first", async () => {
    const db = await freshDb();
    await seedSessions(db, 3);
    const list = await chatRepo.listByIndex(db, "i");
    expect(list.map((s) => s.id)).toEqual(["s2", "s1", "s0"]);
  });

  it("scopes history to its own index", async () => {
    const db = await freshDb();
    await seedSessions(db, 2, "alpha");
    await seedSessions(db, 3, "beta");
    expect(await chatRepo.listByIndex(db, "alpha")).toHaveLength(2);
    expect(await chatRepo.listByIndex(db, "beta")).toHaveLength(3);
  });

  it(`keeps at most ${MAX_CHAT_SESSIONS} conversations, evicting the oldest`, async () => {
    const db = await freshDb();
    await seedSessions(db, MAX_CHAT_SESSIONS + 5);

    const all = await chatRepo.listAll(db);
    expect(all).toHaveLength(MAX_CHAT_SESSIONS);
    // The five oldest are gone; the newest survive.
    expect(await chatRepo.get(db, "s0")).toBeUndefined();
    expect(await chatRepo.get(db, "s4")).toBeUndefined();
    expect(await chatRepo.get(db, "s5")).toBeDefined();
    expect(await chatRepo.get(db, `s${MAX_CHAT_SESSIONS + 4}`)).toBeDefined();
  });

  it("re-saving a conversation updates it rather than adding one", async () => {
    const db = await freshDb();
    await chatRepo.save(db, { id: "s1", indexId: "i", turns: [turn("first")], createdAt: 1 }, 10);
    await chatRepo.save(
      db,
      { id: "s1", indexId: "i", turns: [turn("first"), turn("second")], createdAt: 1 },
      20,
    );

    const all = await chatRepo.listAll(db);
    expect(all).toHaveLength(1);
    expect(all[0]?.turns).toHaveLength(2);
    expect(all[0]?.updatedAt).toBe(20);
  });

  it("deletes one conversation, and clears a whole index", async () => {
    const db = await freshDb();
    await seedSessions(db, 3, "alpha");
    await seedSessions(db, 2, "beta");

    await chatRepo.remove(db, sessionId("alpha", 1));
    expect(await chatRepo.get(db, sessionId("alpha", 1))).toBeUndefined();

    await chatRepo.clearIndex(db, "alpha");
    expect(await chatRepo.listByIndex(db, "alpha")).toHaveLength(0);
    // Another site's history is untouched.
    expect(await chatRepo.listByIndex(db, "beta")).toHaveLength(2);
  });

  it("keeps a refused turn, so history reflects what happened", async () => {
    const db = await freshDb();
    const refused: StoredTurn = {
      question: "how do I self-host",
      markdown: "",
      tier: "nano",
      refused: true,
      sources: [],
      at: 1,
    };
    await chatRepo.save(db, { id: "s1", indexId: "i", turns: [refused], createdAt: 1 });
    expect((await chatRepo.get(db, "s1"))?.turns[0]?.refused).toBe(true);
  });
});
