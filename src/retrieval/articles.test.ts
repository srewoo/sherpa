import { describe, it, expect } from "vitest";
import type { StoredChunk } from "@/domain/records.js";
import {
  assembleArticles,
  shouldExpandFullPage,
  DEFAULT_ASSEMBLE,
  type ScoredChunk,
} from "./articles.js";

function chunk(vectorId: number, url: string, position: number, body: string): StoredChunk {
  return {
    indexId: "i",
    vectorId,
    text: body,
    body,
    url,
    anchor: position === 0 ? "top" : undefined,
    headingPath: "Admin > SSO",
    position,
    title: "SSO Setup",
    contentHash: `h${vectorId}`,
  };
}

function scored(c: StoredChunk, rankScore: number, similarity = 0.5): ScoredChunk {
  return { chunk: c, rankScore, similarity, denseRank: 0, sparseRank: undefined };
}

const PAGE_A = [
  chunk(0, "https://d/a", 0, "step one"),
  chunk(1, "https://d/a", 1, "step two"),
  chunk(2, "https://d/a", 2, "step three"),
];
const PAGE_B = [chunk(3, "https://d/b", 0, "other page")];

const pages = new Map<string, readonly StoredChunk[]>([
  ["https://d/a", PAGE_A],
  ["https://d/b", PAGE_B],
]);

describe("assembleArticles", () => {
  it("returns one article per page, ordered by its best chunk", () => {
    const articles = assembleArticles(
      [scored(PAGE_B[0]!, 0.9), scored(PAGE_A[1]!, 0.95)],
      pages,
    );
    expect(articles.map((a) => a.url)).toEqual(["https://d/b", "https://d/a"]);
  });

  it("pulls in neighbours so a procedure stays contiguous (5.7.5)", () => {
    const [article] = assembleArticles([scored(PAGE_A[1]!, 0.9)], pages);
    expect(article?.chunks.map((c) => c.position)).toEqual([0, 1, 2]);
    expect(article?.body).toBe("step one\n\nstep two\n\nstep three");
  });

  it("marks which chunks matched and which came along", () => {
    const [article] = assembleArticles([scored(PAGE_A[1]!, 0.9)], pages);
    const byId = new Map(article!.chunks.map((c) => [c.vectorId, c.viaNeighbour]));
    expect(byId.get(1)).toBe(false);
    expect(byId.get(0)).toBe(true);
    expect(byId.get(2)).toBe(true);
  });

  it("collapses several matches on one page into a single article", () => {
    // This is what replaced the per-page cap: the page appears once, and every
    // matched chunk informs the answer instead of being discarded.
    const articles = assembleArticles(
      [scored(PAGE_A[0]!, 0.9), scored(PAGE_A[1]!, 0.85), scored(PAGE_A[2]!, 0.8)],
      pages,
    );
    expect(articles).toHaveLength(1);
    expect(articles[0]?.chunks.filter((c) => !c.viaNeighbour)).toHaveLength(3);
  });

  it("takes its score, anchor and title from the best chunk", () => {
    const [article] = assembleArticles(
      [scored(PAGE_A[0]!, 0.95, 0.8), scored(PAGE_A[2]!, 0.4, 0.3)],
      pages,
    );
    expect(article?.rankScore).toBe(0.95);
    expect(article?.anchor).toBe("top");
    expect(article?.title).toBe("SSO Setup");
    // Similarity is the best across its chunks, for display and the floor.
    expect(article?.similarity).toBe(0.8);
  });

  it("caps the number of articles", () => {
    const articles = assembleArticles(
      [scored(PAGE_A[0]!, 0.9), scored(PAGE_B[0]!, 0.8)],
      pages,
      { ...DEFAULT_ASSEMBLE, maxArticles: 1 },
    );
    expect(articles).toHaveLength(1);
  });

  it("truncates a huge article at a paragraph boundary", () => {
    const long = Array.from({ length: 40 }, (_, i) =>
      chunk(100 + i, "https://d/long", i, "x".repeat(400)),
    );
    const [article] = assembleArticles([scored(long[0]!, 0.9)], new Map([["https://d/long", long]]), {
      ...DEFAULT_ASSEMBLE,
      neighbourSpan: 40,
      maxBodyChars: 1000,
    });
    expect(article!.body.length).toBeLessThanOrEqual(1000);
    // Cut between paragraphs, never mid-sentence.
    expect(article!.body.endsWith("x")).toBe(true);
  });

  it("copes with a page whose chunks aren't in the map", () => {
    const orphan = chunk(99, "https://d/orphan", 0, "lone chunk");
    const [article] = assembleArticles([scored(orphan, 0.5)], new Map());
    expect(article?.body).toBe("lone chunk");
  });

  it("returns nothing for no input", () => {
    expect(assembleArticles([], pages)).toEqual([]);
  });
});

/**
 * The failure this guards: a question matches the chunk holding steps 1–2 of a
 * procedure, the window stops there, and the model answers "…2. Click Create
 * mission" as though that were the end. Nothing in the context hints that steps
 * 3 onward existed, so the answer looks complete and is not.
 */
describe("full-page assembly for the top article", () => {
  const LONG = [
    chunk(10, "https://d/long", 0, "intro"),
    chunk(11, "https://d/long", 1, "step one"),
    chunk(12, "https://d/long", 2, "step two"),
    chunk(13, "https://d/long", 3, "step three"),
    chunk(14, "https://d/long", 4, "step four"),
    chunk(15, "https://d/long", 5, "step five"),
    chunk(16, "https://d/long", 6, "evaluation parameters"),
  ];
  const longPages = new Map<string, readonly StoredChunk[]>([
    ["https://d/long", LONG],
    ["https://d/b", PAGE_B],
  ]);

  it("gives the best article its whole page, not a window round the match", () => {
    // Matches early in the page; the rest of the procedure is far outside span.
    const [article] = assembleArticles([scored(LONG[1]!, 0.9)], longPages);
    expect(article?.chunks.map((c) => c.position)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(article?.body).toContain("evaluation parameters");
  });

  it("still only windows the articles below the top one", () => {
    const articles = assembleArticles(
      [scored(PAGE_B[0]!, 0.99), scored(LONG[1]!, 0.5)],
      longPages,
    );
    const second = articles[1];
    expect(second?.url).toBe("https://d/long");
    // neighbourSpan 2 around position 1 → 0..3, not the whole page.
    expect(second?.chunks.map((c) => c.position)).toEqual([0, 1, 2, 3]);
  });

  it("can be turned off, and then windows the top article too", () => {
    const [article] = assembleArticles([scored(LONG[1]!, 0.9)], longPages, {
      ...DEFAULT_ASSEMBLE,
      fullPageForTop: false,
    });
    expect(article?.chunks.map((c) => c.position)).toEqual([0, 1, 2, 3]);
  });

  it("still respects the body cap, so one huge page cannot fill the context", () => {
    const [article] = assembleArticles([scored(LONG[1]!, 0.9)], longPages, {
      ...DEFAULT_ASSEMBLE,
      maxBodyChars: 20,
    });
    expect(article!.body.length).toBeLessThanOrEqual(20);
  });

  it("keeps matched/neighbour marking honest across the whole page", () => {
    const [article] = assembleArticles([scored(LONG[1]!, 0.9)], longPages);
    const byId = new Map(article!.chunks.map((c) => [c.vectorId, c.viaNeighbour]));
    expect(byId.get(11)).toBe(false); // the actual match
    expect(byId.get(16)).toBe(true); // dragged in by full-page assembly
  });
});

/**
 * Full-page assembly has two failure directions and both have been observed:
 * too eager and one long page eats the context budget, starving the other
 * sources; too shy and the answer stops halfway through a procedure.
 */
describe("shouldExpandFullPage", () => {
  const opts = DEFAULT_ASSEMBLE;

  it("expands a clear winner", () => {
    expect(shouldExpandFullPage(1.0, 0.5, 2_000, opts)).toBe(true);
  });

  it("declines when the field is close — breadth beats depth there", () => {
    expect(shouldExpandFullPage(1.0, 0.97, 2_000, opts)).toBe(false);
  });

  it("declines a page too long to be an article", () => {
    expect(shouldExpandFullPage(1.0, 0.1, 50_000, opts)).toBe(false);
  });

  it("expands when there is nothing to compete with", () => {
    expect(shouldExpandFullPage(1.0, undefined, 2_000, opts)).toBe(true);
  });

  it("respects the master switch", () => {
    expect(shouldExpandFullPage(1.0, 0.1, 100, { ...opts, fullPageForTop: false })).toBe(false);
  });

  it("does not divide by a zero top score", () => {
    expect(shouldExpandFullPage(0, 0, 100, opts)).toBe(false);
  });

  it("treats the gap as relative, not absolute", () => {
    // Same 0.1 absolute gap; only the first is 10% of the leader's score.
    expect(shouldExpandFullPage(1.0, 0.9, 100, opts)).toBe(true);
    expect(shouldExpandFullPage(10.0, 9.9, 100, opts)).toBe(false);
  });
});
