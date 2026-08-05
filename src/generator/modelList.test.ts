import { describe, it, expect } from "vitest";
import { fetchModels } from "./modelList.js";

function jsonFetcher(body: unknown, status = 200): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response) as unknown as typeof fetch;
}

describe("fetchModels", () => {
  it("lists OpenAI chat models the key can use", async () => {
    const res = await fetchModels(
      "openai",
      "sk-test",
      jsonFetcher({ data: [{ id: "gpt-4o" }, { id: "o4-mini" }, { id: "gpt-5" }] }),
    );
    expect(res.models).toContain("gpt-4o");
    expect(res.models).toContain("o4-mini");
    expect(res.error).toBeUndefined();
  });

  /**
   * A listing is not a menu of chat models: OpenAI returns embeddings, audio,
   * image and moderation models on the same endpoint, and picking one would
   * fail every question with a 404 from the chat endpoint.
   */
  it("drops models that cannot hold a conversation", async () => {
    const res = await fetchModels(
      "openai",
      "sk-test",
      jsonFetcher({
        data: [
          { id: "gpt-4o" },
          { id: "text-embedding-3-large" },
          { id: "dall-e-3" },
          { id: "whisper-1" },
          { id: "omni-moderation-latest" },
        ],
      }),
    );
    expect(res.models).toEqual(["gpt-4o"]);
  });

  it("ranks newer models first, so a provider switch picks a sensible default", async () => {
    const res = await fetchModels(
      "anthropic",
      "sk-ant",
      jsonFetcher({
        data: [{ id: "claude-haiku-4-5" }, { id: "claude-opus-5" }, { id: "claude-sonnet-5" }],
      }),
    );
    expect(res.models[0]).toBe("claude-sonnet-5");
    expect(res.models).toHaveLength(3);
  });

  it("strips Gemini's models/ prefix, which the answer path does not use", async () => {
    const res = await fetchModels(
      "gemini",
      "key",
      jsonFetcher({
        models: [
          { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
          { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
        ],
      }),
    );
    expect(res.models).toEqual(["gemini-2.5-pro"]);
  });

  /** A wrong key is a different problem from an unreachable provider. */
  it("names a rejected key rather than reporting a generic failure", async () => {
    const res = await fetchModels("openai", "bad", jsonFetcher({}, 401));
    expect(res.error).toBe("Key rejected.");
    expect(res.models).toEqual([]);
  });

  it("reports an unreachable provider without throwing", async () => {
    const boom = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const res = await fetchModels("openai", "sk-test", boom);
    expect(res.models).toEqual([]);
    expect(res.error).toBe("Could not reach the provider.");
  });

  /** No key means nothing to ask — and nothing to complain about. */
  it("says nothing when there is no key yet", async () => {
    const res = await fetchModels("openai", "   ", jsonFetcher({ data: [] }));
    expect(res).toEqual({ models: [] });
  });

  it("reports a key with no usable models rather than an empty dropdown", async () => {
    const res = await fetchModels("openai", "sk-test", jsonFetcher({ data: [{ id: "whisper-1" }] }));
    expect(res.models).toEqual([]);
    expect(res.error).toBe("No usable models for this key.");
  });

  it("survives a listing shaped differently than expected", async () => {
    const res = await fetchModels("openai", "sk-test", jsonFetcher({ unexpected: true }));
    expect(res.models).toEqual([]);
  });
});
