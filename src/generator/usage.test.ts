import { describe, it, expect } from "vitest";
import {
  addUsage,
  costUsd,
  estimateTokens,
  formatUsd,
  mergeReported,
  rateFor,
  usageFromFrame,
  ZERO_USAGE,
} from "./usage.js";
import { applySpend, dayKey, prune, totalSpend, type SpendLedger } from "./spendStore.js";

describe("usageFromFrame", () => {
  it("reads OpenAI's final usage frame", () => {
    const frame = JSON.stringify({ usage: { prompt_tokens: 900, completion_tokens: 120 } });
    expect(usageFromFrame("openai", frame)).toEqual({
      promptTokens: 900,
      completionTokens: 120,
      estimated: false,
    });
  });

  it("reads Anthropic's input tokens from message_start and output from message_delta", () => {
    // Split across two frames, which is why merging rather than replacing
    // matters — reading only one leaves half the count at zero forever.
    const start = JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 800, output_tokens: 1 } } });
    const delta = JSON.stringify({ type: "message_delta", usage: { output_tokens: 210 } });
    let usage = mergeReported(ZERO_USAGE, usageFromFrame("anthropic", start)!);
    usage = mergeReported(usage, usageFromFrame("anthropic", delta)!);
    expect(usage).toEqual({ promptTokens: 800, completionTokens: 210, estimated: false });
  });

  it("reads Gemini's usageMetadata", () => {
    const frame = JSON.stringify({ usageMetadata: { promptTokenCount: 700, candidatesTokenCount: 90 } });
    expect(usageFromFrame("gemini", frame)?.promptTokens).toBe(700);
  });

  it("returns nothing for an ordinary content frame", () => {
    expect(usageFromFrame("openai", JSON.stringify({ choices: [{ delta: { content: "hi" } }] }))).toBeUndefined();
    expect(usageFromFrame("openai", "[DONE]")).toBeUndefined();
    expect(usageFromFrame("openai", "not json at all")).toBeUndefined();
  });
});

describe("mergeReported", () => {
  /**
   * Every provider reports cumulative totals for the turn, so summing them
   * would multiply a Gemini answer's tokens by the number of chunks it arrived
   * in — a 40x overstatement of somebody's bill.
   */
  it("supersedes rather than sums, so cumulative frames don't multiply", () => {
    let usage = ZERO_USAGE;
    for (const n of [10, 25, 60]) {
      usage = mergeReported(usage, { promptTokens: 500, completionTokens: n, estimated: false });
    }
    expect(usage).toEqual({ promptTokens: 500, completionTokens: 60, estimated: false });
  });

  it("does not let a partial frame reset a field already reported", () => {
    const withInput = mergeReported(ZERO_USAGE, { promptTokens: 800, completionTokens: 1, estimated: false });
    const after = mergeReported(withInput, { promptTokens: 0, completionTokens: 210, estimated: false });
    expect(after.promptTokens).toBe(800);
  });
});

describe("estimateTokens and addUsage", () => {
  it("estimates at four characters per token", () => {
    expect(estimateTokens("12345678")).toBe(2);
  });

  it("marks any total containing an estimate as estimated", () => {
    const exact = { promptTokens: 10, completionTokens: 10, estimated: false };
    const guess = { promptTokens: 10, completionTokens: 10, estimated: true };
    expect(addUsage(exact, exact).estimated).toBe(false);
    expect(addUsage(exact, guess).estimated).toBe(true);
  });
});

describe("costUsd", () => {
  it("prices a model whose rate is published", () => {
    // claude-opus-5: $5/MTok in, $25/MTok out.
    const cost = costUsd("claude-opus-5", { promptTokens: 1_000_000, completionTokens: 1_000_000, estimated: false });
    expect(cost).toBeCloseTo(30);
  });

  it("returns undefined — never zero — for a model with no published rate", () => {
    // Zero is a claim that the answer was free. Unknown is not free.
    expect(costUsd("some-model-we-cannot-cite", { promptTokens: 5000, completionTokens: 500, estimated: false })).toBeUndefined();
    expect(rateFor("some-model-we-cannot-cite")).toBeUndefined();
  });

  it("carries the date each rate was checked, so a stale one is visible", () => {
    expect(rateFor("claude-opus-5")?.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("formatUsd", () => {
  it("shows enough precision for a single cheap turn to move the counter", () => {
    expect(formatUsd(0.0004)).toBe("$0.0004");
    expect(formatUsd(1.5)).toBe("$1.50");
    expect(formatUsd(0)).toBe("$0.00");
  });
});

describe("the spend ledger", () => {
  const at = Date.parse("2026-09-11T10:00:00");
  const usage = { promptTokens: 1000, completionTokens: 200, estimated: false };

  it("accumulates tokens, calls and cost per day and model", () => {
    let ledger: SpendLedger = {};
    ledger = applySpend(ledger, "claude-opus-5", usage, at);
    ledger = applySpend(ledger, "claude-opus-5", usage, at);
    const day = ledger[dayKey(at)]?.["claude-opus-5"];
    expect(day?.calls).toBe(2);
    expect(day?.promptTokens).toBe(2000);
    expect(day?.costUsd).toBeCloseTo(2 * (1000 * 5 + 200 * 25) / 1_000_000);
  });

  it("keeps models apart within a day", () => {
    let ledger: SpendLedger = {};
    ledger = applySpend(ledger, "claude-opus-5", usage, at);
    ledger = applySpend(ledger, "claude-haiku-4-5", usage, at);
    expect(Object.keys(ledger[dayKey(at)] ?? {}).sort()).toEqual(["claude-haiku-4-5", "claude-opus-5"]);
  });

  it("records tokens for an unpriced model without inventing a cost", () => {
    const ledger = applySpend({}, "mystery-model", usage, at);
    const day = ledger[dayKey(at)]?.["mystery-model"];
    expect(day?.promptTokens).toBe(1000);
    expect(day?.costUsd).toBeUndefined();
  });

  it("says the total is partial when some spend could not be priced", () => {
    let ledger: SpendLedger = {};
    ledger = applySpend(ledger, "claude-opus-5", usage, at);
    ledger = applySpend(ledger, "mystery-model", usage, at);
    const total = totalSpend(ledger, 1, at);
    expect(total.calls).toBe(2);
    expect(total.costUsd).toBeGreaterThan(0);
    // The figure is a floor, and the UI has to be able to say so.
    expect(total.partialCost).toBe(true);
  });

  it("drops days past the retention window", () => {
    const old = at - 60 * 24 * 60 * 60 * 1000;
    const ledger = applySpend({ [dayKey(old)]: { m: { promptTokens: 1, completionTokens: 1, calls: 1, estimated: false } } }, "claude-opus-5", usage, at);
    expect(ledger[dayKey(old)]).toBeUndefined();
    expect(ledger[dayKey(at)]).toBeDefined();
  });

  it("totals only the requested window", () => {
    const yesterday = at - 24 * 60 * 60 * 1000;
    let ledger: SpendLedger = {};
    ledger = applySpend(ledger, "claude-opus-5", usage, yesterday);
    ledger = applySpend(ledger, "claude-opus-5", usage, at);
    expect(totalSpend(ledger, 1, at).calls).toBe(1);
    expect(totalSpend(ledger, 7, at).calls).toBe(2);
  });

  it("keeps an empty ledger empty", () => {
    expect(prune({}, at)).toEqual({});
    expect(totalSpend({}, 30, at)).toMatchObject({ calls: 0, partialCost: false });
    expect(totalSpend({}, 30, at).costUsd).toBeUndefined();
  });
});
