import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadSettings } from "./settings.js";

/** A minimal chrome.storage.local stub — the only API loadSettings touches. */
function stubStorage(data: Record<string, unknown>): void {
  (globalThis as Record<string, unknown>)["chrome"] = {
    storage: { local: { get: async () => data, set: async () => {} } },
  };
}

describe("answer settings are validated, not asserted", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("reads a well-formed byok config", async () => {
    stubStorage({
      answer: { mode: "byok", provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test" },
    });
    expect((await loadSettings()).answer).toEqual({
      mode: "byok",
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "sk-test",
    });
  });

  /**
   * The failure this guards.
   *
   * A stored record without `mode` used to be cast straight to AnswerSettings,
   * so `mode` came out undefined — not "byok", so `byokIssue` reported *no
   * issue*, Nano was selected, and no notice was raised. The panel then said
   * "on-device" beside an Options page showing OpenAI, with a saved key sitting
   * in storage, and nothing anywhere reported a problem.
   */
  it("infers byok when the mode is missing but a key is saved", async () => {
    stubStorage({ answer: { provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test" } });
    const { answer } = await loadSettings();
    expect(answer.mode).toBe("byok");
    expect(answer.apiKey).toBe("sk-test");
    expect(console.warn).toHaveBeenCalled();
  });

  it("falls back to auto when the mode is missing and no key is saved", async () => {
    stubStorage({ answer: { provider: "openai", model: "gpt-4o-mini", apiKey: "" } });
    expect((await loadSettings()).answer.mode).toBe("auto");
  });

  it("survives a stored value that is not an object at all", async () => {
    stubStorage({ answer: "byok" });
    expect((await loadSettings()).answer).toEqual({ mode: "auto" });
    expect(console.warn).toHaveBeenCalled();
  });

  it("drops fields of the wrong type rather than passing them on", async () => {
    stubStorage({ answer: { mode: "byok", provider: "openai", model: 42, apiKey: null } });
    const { answer } = await loadSettings();
    expect(answer.mode).toBe("byok");
    expect(answer.model).toBeUndefined();
    expect(answer.apiKey).toBeUndefined();
  });

  it("defaults cleanly when nothing has been saved", async () => {
    stubStorage({});
    expect((await loadSettings()).answer).toEqual({ mode: "auto" });
  });
});
