import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { log, pending, formatDiagnostics, setLogContext, clearDiagnostics, MAX_ENTRIES } from "./log.js";

beforeEach(async () => {
  await clearDiagnostics();
  setLogContext("test");
  // The console is still written to; silence it so the suite stays readable.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("log", () => {
  it("records the event name and its fields separately", () => {
    log.warn("query_rewrite_discarded", { reason: "too_long", cleaned: "x" });
    const entry = pending()[0];
    expect(entry?.event).toBe("query_rewrite_discarded");
    expect(entry?.fields).toMatchObject({ reason: "too_long", cleaned: "x" });
    expect(entry?.level).toBe("warn");
  });

  it("stamps the context, because an extension has three separate consoles", () => {
    setLogContext("offscreen");
    log.info("tier_selected", { tier: "byok" });
    expect(pending()[0]?.context).toBe("offscreen");
  });

  /**
   * These lines are written to be handed to somebody else, which makes them
   * egress — so the same redaction that guards the query log guards them.
   */
  it("masks personal data in string fields", () => {
    log.warn("page_index_failed", { url: "https://d/a", error: "mail to sarah@acme.com failed" });
    const fields = pending()[0]?.fields as Record<string, string>;
    expect(fields["error"]).toContain("[email]");
    expect(fields["error"]).not.toContain("sarah@acme.com");
  });

  it("masks inside nested objects, where a query usually hides", () => {
    log.info("retrieval", { plan: { search: "reset password for a@b.com" } });
    expect(JSON.stringify(pending()[0]?.fields)).not.toContain("a@b.com");
  });

  it("keeps numbers and booleans as they are", () => {
    log.info("crawl_progress", { fetched: 12, done: true });
    expect(pending()[0]?.fields).toMatchObject({ fetched: 12, done: true });
  });

  it("survives an unserialisable field rather than losing the event", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    log.error("crawl_loop_failed", { detail: circular, code: 7 });
    const entry = pending()[0];
    expect(entry?.event).toBe("crawl_loop_failed");
    expect(entry?.fields).toMatchObject({ code: 7 });
  });

  it("caps the buffer so a long crawl cannot grow it without bound", () => {
    for (let i = 0; i < MAX_ENTRIES + 50; i += 1) log.debug("page_fetched", { i });
    expect(pending().length).toBeLessThanOrEqual(MAX_ENTRIES);
    // The tail is what is kept — the recent events are the ones that explain a bug.
    expect((pending().at(-1)?.fields as Record<string, number>)["i"]).toBe(MAX_ENTRIES + 49);
  });
});

describe("formatDiagnostics", () => {
  it("produces one greppable line per event, with the fields appended", () => {
    log.warn("circuit_opened", { name: "llm:answer:openai", failures: 4 });
    const text = formatDiagnostics(pending());
    expect(text).toContain("circuit_opened");
    expect(text).toContain("name=llm:answer:openai");
    expect(text).toContain("failures=4");
  });

  it("says in the file itself that it has been redacted", () => {
    // The user is pasting this into an issue; they are entitled to know what
    // it does and does not contain before they do.
    expect(formatDiagnostics([])).toMatch(/redacted/i);
  });
});
