import { describe, it, expect } from "vitest";
import { chunkPage, estimateTokens, DEFAULT_CHUNK_OPTIONS } from "./chunk.js";
import type { Block, PageContext } from "@/domain/content.js";

const ctx: PageContext = { title: "SSO Setup", breadcrumb: ["Admin", "SSO"] };

function para(text: string): Block {
  return { type: "paragraph", text };
}
function longProse(sentences: number): string {
  return Array.from({ length: sentences }, (_, i) => `Sentence number ${i} here.`).join(" ");
}

describe("estimateTokens", () => {
  it("scales with word count", () => {
    expect(estimateTokens("one two three")).toBeGreaterThan(0);
    expect(estimateTokens(longProse(50))).toBeGreaterThan(estimateTokens("hi"));
  });
});

describe("chunkPage", () => {
  it("prepends the breadcrumb + heading path to embedded text", () => {
    const blocks: Block[] = [
      { type: "heading", level: 2, text: "Troubleshooting", anchor: "ts" },
      para("Check the audience URL first."),
    ];
    const [chunk] = chunkPage(blocks, ctx);
    expect(chunk?.headingPath).toBe("Admin > SSO > Troubleshooting");
    expect(chunk?.text.startsWith("Admin > SSO > Troubleshooting:")).toBe(true);
    expect(chunk?.body).toBe("Check the audience URL first.");
    expect(chunk?.anchor).toBe("ts");
  });

  it("keeps a small page as a single chunk", () => {
    const blocks: Block[] = [para("Short page."), para("Two lines only.")];
    expect(chunkPage(blocks, ctx)).toHaveLength(1);
  });

  it("never straddles a heading boundary", () => {
    // Sections must be long enough that the page as a whole clears the
    // small-page merge threshold (5.4.6) — otherwise the correct behaviour is
    // to collapse it, which the merge tests below cover.
    const blocks: Block[] = [
      { type: "heading", level: 2, text: "A", anchor: "a" },
      para(`Alpha body. ${longProse(40)}`),
      { type: "heading", level: 2, text: "B", anchor: "b" },
      para(`Beta body. ${longProse(40)}`),
    ];
    const chunks = chunkPage(blocks, ctx);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]?.body).toContain("Alpha");
    expect(chunks[0]?.body).not.toContain("Beta");
    const beta = chunks.find((c) => c.body.includes("Beta"));
    expect(beta?.anchor).toBe("b");
  });

  it("merges a whole small page into one chunk instead of fragments (5.4.6)", () => {
    const blocks: Block[] = [
      { type: "heading", level: 2, text: "A", anchor: "a" },
      para("Alpha body."),
      { type: "heading", level: 2, text: "B", anchor: "b" },
      para("Beta body."),
    ];
    const chunks = chunkPage(blocks, ctx);
    expect(chunks).toHaveLength(1);
    // Both sections survive, and the chunk is labelled with the page itself.
    expect(chunks[0]?.body).toContain("Alpha");
    expect(chunks[0]?.body).toContain("Beta");
    expect(chunks[0]?.headingPath).toBe("Admin > SSO > SSO Setup");
  });

  it("leaves a page above the merge threshold split", () => {
    const blocks: Block[] = [
      { type: "heading", level: 2, text: "A", anchor: "a" },
      para(longProse(60)),
      { type: "heading", level: 2, text: "B", anchor: "b" },
      para(longProse(60)),
    ];
    expect(estimateTokens(longProse(120))).toBeGreaterThan(DEFAULT_CHUNK_OPTIONS.mergeBelow);
    expect(chunkPage(blocks, ctx).length).toBeGreaterThan(1);
  });

  it("never splits an atomic block and keeps it intact", () => {
    const code = "```js\n" + "const x = 1;\n".repeat(60) + "```";
    const blocks: Block[] = [
      para(longProse(80)),
      { type: "code", text: code },
    ];
    const chunks = chunkPage(blocks, ctx);
    const codeChunks = chunks.filter((c) => c.body.includes("const x = 1;"));
    expect(codeChunks).toHaveLength(1);
    expect(codeChunks[0]?.body).toContain(code);
  });

  it("splits long prose into multiple chunks near the target size", () => {
    const chunks = chunkPage([para(longProse(400))], ctx);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(estimateTokens(c.body)).toBeLessThanOrEqual(
        DEFAULT_CHUNK_OPTIONS.maxTokens + estimateTokens(longProse(20)),
      );
    }
  });

  it("assigns strictly increasing positions", () => {
    const chunks = chunkPage(
      [para(longProse(400)), { type: "heading", level: 2, text: "Next" }, para("More.")],
      ctx,
    );
    const positions = chunks.map((c) => c.position);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(new Set(positions).size).toBe(positions.length);
  });
});
