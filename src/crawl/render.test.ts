import { describe, it, expect } from "vitest";
import { wordCount, blocksWordCount, needsRender, MIN_WORDS, RenderTracker } from "./render.js";
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

/**
 * The bug this guards: rendering opens a background tab per page, and on a site
 * where extraction is thin everywhere — a login-gated help centre, unusual
 * markup — every page trips the heuristic. A 1,400-page crawl then opens 1,400
 * tabs and the browser feels hung, for no benefit.
 */
describe("RenderTracker", () => {
  it("allows rendering by default", () => {
    expect(new RenderTracker().allows()).toBe(true);
  });

  it("stops once the hard ceiling is reached", () => {
    const t = new RenderTracker({ max: 3, maxConsecutiveFailures: 99 });
    for (let i = 0; i < 3; i++) {
      expect(t.allows()).toBe(true);
      t.record(true); // even when every render helps
    }
    expect(t.allows()).toBe(false);
  });

  /** The important one: give up early when it is plainly not working. */
  it("gives up after a run of renders that changed nothing", () => {
    const t = new RenderTracker({ max: 1000, maxConsecutiveFailures: 3 });
    t.record(false);
    t.record(false);
    expect(t.allows()).toBe(true);
    t.record(false);
    expect(t.allows()).toBe(false);
    expect(t.givenUp).toBe(true);
  });

  it("forgives failures once a render helps — a site can be mixed", () => {
    const t = new RenderTracker({ max: 1000, maxConsecutiveFailures: 3 });
    t.record(false);
    t.record(false);
    t.record(true); // resets the streak
    t.record(false);
    t.record(false);
    expect(t.allows()).toBe(true);
  });

  it("counts what it spent, so the budget is observable", () => {
    const t = new RenderTracker({ max: 10, maxConsecutiveFailures: 10 });
    t.record(true);
    t.record(false);
    expect(t.rendersUsed).toBe(2);
  });
});
