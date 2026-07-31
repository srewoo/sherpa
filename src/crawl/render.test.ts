import { describe, it, expect } from "vitest";
import { wordCount, blocksWordCount, needsRender, MIN_WORDS } from "./render.js";
import type { Block } from "@/domain/content.js";

describe("render fallback trigger", () => {
  it("counts words", () => {
    expect(wordCount("  ")).toBe(0);
    expect(wordCount("one two three")).toBe(3);
  });

  it("sums words across blocks", () => {
    const blocks: Block[] = [
      { type: "paragraph", text: "a b c" },
      { type: "heading", level: 2, text: "d e" },
    ];
    expect(blocksWordCount(blocks)).toBe(5);
  });

  it("flags near-empty pages for rendering", () => {
    expect(needsRender(10)).toBe(true);
    expect(needsRender(MIN_WORDS)).toBe(false);
    expect(needsRender(MIN_WORDS + 1)).toBe(false);
  });
});
