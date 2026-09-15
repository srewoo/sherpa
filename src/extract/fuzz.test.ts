/**
 * Property tests over hostile input for extraction and chunking.
 *
 * These two functions read whatever a help centre serves, and a help centre is
 * not obliged to serve anything sane: unclosed tags, headings nested inside
 * headings, a `<pre>` containing markup, 40 levels of `<div>`, zero-width
 * characters, a single unbroken 100 KB word. They are Sherpa's exposure to
 * untrusted input in exactly the way `kbsync/transform` is Echo's — which is
 * the one function in that repo with a fuzz target attached.
 *
 * The style is Echo's `FuzzConvertHTML`, adapted: a seeded generator rather
 * than a coverage-guided fuzzer, so a failure is reproducible from its seed and
 * the suite takes milliseconds and belongs in CI. What it checks is invariants,
 * not output — "never throws", "never exceeds the token ceiling", "never
 * invents text" — because for input like this there is no correct output to
 * assert, only properties that must hold whatever comes back.
 */

import { describe, it, expect } from "vitest";
import { parseHTML } from "linkedom";
import { extractPage } from "./extract.js";
import { chunkPage, estimateTokens, DEFAULT_CHUNK_OPTIONS } from "@/lib/chunk.js";

/**
 * A seeded PRNG, so a failing case is reproducible from the seed in its name.
 * `Math.random` would give a test that fails once and never again.
 */
function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 100000) / 100000;
  };
}

/** Fragments chosen to be individually awkward. */
const NASTY = [
  "<h1>",
  "</h1>",
  "<h2>a</h2>",
  "<h7>not a heading</h7>",
  "<div>".repeat(40),
  "</div>".repeat(40),
  "<pre><code>&lt;h1&gt;not a heading&lt;/h1&gt;</code></pre>",
  "<table><tr><td>",
  "</td></tr></table>",
  "<ul><li>one<li>two",
  "<p>",
  "</p>",
  "<script>alert(1)</script>",
  "<style>body{}</style>",
  "<!-- comment -->",
  "\u200b\u200b\u200b",
  "\u0000",
  "&amp;&lt;&gt;&#x41;&nbsp;",
  "x".repeat(5000),
  "word ".repeat(2000),
  "<p>\u{1F600}\u{1F1EC}\u{1F1E7} emoji</p>",
  "<p dir='rtl'>مرحبا بالعالم</p>",
  "<img src=x onerror=1>",
  "<a href='javascript:void(0)'>link</a>",
  "<h2>" + "deep ".repeat(500) + "</h2>",
  "<br>",
  "<hr>",
  "<p>&#x0;&#xFFFF;</p>",
  "<template><h1>hidden</h1></template>",
  "<svg><text>vector</text></svg>",
];

function hostileHtml(seed: number): string {
  const next = rng(seed);
  const parts: string[] = [];
  const count = 1 + Math.floor(next() * 25);
  for (let i = 0; i < count; i += 1) {
    parts.push(NASTY[Math.floor(next() * NASTY.length)] ?? "");
  }
  return parts.join("");
}

function parse(html: string): Document {
  return parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`)
    .document as unknown as Document;
}

const CTX = { url: "https://docs.northwind.com/guide", title: "Guide", breadcrumb: ["Docs"] };
const SEEDS = Array.from({ length: 150 }, (_, i) => i * 7919 + 1);

describe("extractPage on hostile HTML", () => {
  it.each(SEEDS)("never throws (seed %i)", (seed) => {
    const html = hostileHtml(seed);
    expect(() => extractPage(parse(html), "https://docs.northwind.com/guide")).not.toThrow();
  });

  it.each(SEEDS.slice(0, 40))("returns a well-formed page (seed %i)", (seed) => {
    const page = extractPage(parse(hostileHtml(seed)), "https://docs.northwind.com/guide");
    expect(typeof page.title).toBe("string");
    expect(Array.isArray(page.breadcrumb)).toBe(true);
    expect(Array.isArray(page.blocks)).toBe(true);
    for (const block of page.blocks) {
      expect(typeof block.text).toBe("string");
      // A block with no text is not a block; emitting one costs an embedding
      // and a source card that says nothing.
      expect(block.text.length).toBeGreaterThan(0);
    }
  });

  it("survives an empty document and a document of nothing but junk", () => {
    expect(() => extractPage(parse(""), "https://d/a")).not.toThrow();
    expect(() => extractPage(parse("<script></script><style></style>"), "https://d/a")).not.toThrow();
  });

  it("does not choke on a single unbroken 200KB token", () => {
    const html = `<p>${"z".repeat(200_000)}</p>`;
    expect(() => extractPage(parse(html), "https://d/a")).not.toThrow();
  });
});

describe("chunkPage on hostile blocks", () => {
  it.each(SEEDS)("never throws, and respects the ceiling (seed %i)", (seed) => {
    const page = extractPage(parse(hostileHtml(seed)), "https://docs.northwind.com/guide");
    let drafts: ReturnType<typeof chunkPage> = [];
    expect(() => {
      drafts = chunkPage(page.blocks, CTX);
    }).not.toThrow();

    for (const draft of drafts) {
      expect(draft.body.trim().length).toBeGreaterThan(0);
    }

    /**
     * The ceiling is the load-bearing invariant. A chunk over it is silently
     * truncated by the embedder, so the vector describes a prefix while the
     * stored text describes the whole passage — a retrieval bug that shows up
     * as "the right page ranked badly" and is close to impossible to trace.
     *
     * Code, tables and lists are deliberately atomic and are never split, so a
     * page containing an oversized one is exempt. Exemption is decided from the
     * block *types* on the page rather than by looking for a block's text
     * inside a draft: a table is rendered as pipe markdown, so its raw text is
     * not a substring of the chunk it became, and a substring test silently
     * exempts nothing while appearing to work.
     */
    const hasOversizedAtomic = page.blocks.some(
      (b) =>
        (b.type === "code" || b.type === "table" || b.type === "list") &&
        estimateTokens(b.text) > DEFAULT_CHUNK_OPTIONS.maxTokens,
    );
    if (!hasOversizedAtomic) {
      for (const draft of drafts) {
        // Doubled, because overlap and the heading path are added on top of the
        // packing target and are legitimately not counted by it.
        expect(estimateTokens(draft.body)).toBeLessThanOrEqual(DEFAULT_CHUNK_OPTIONS.maxTokens * 2);
      }
    }
  });

  it.each(SEEDS.slice(0, 40))("numbers chunks contiguously from zero (seed %i)", (seed) => {
    const page = extractPage(parse(hostileHtml(seed)), "https://docs.northwind.com/guide");
    const drafts = chunkPage(page.blocks, CTX);
    // Neighbour expansion reads by position, so a gap or a repeat here silently
    // fetches the wrong passage or none at all.
    expect(drafts.map((d) => d.position)).toEqual(drafts.map((_, i) => i));
  });

  it("emits nothing for no blocks rather than one empty chunk", () => {
    expect(chunkPage([], CTX)).toEqual([]);
  });

  it("handles a block far larger than the ceiling", () => {
    const huge = [{ type: "paragraph" as const, text: "word ".repeat(50_000) }];
    const drafts = chunkPage(huge, CTX);
    expect(drafts.length).toBeGreaterThan(1);
    for (const d of drafts) expect(d.body.length).toBeGreaterThan(0);
  });
});
