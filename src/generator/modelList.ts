/**
 * Ask a provider which models the user's key can actually use.
 *
 * The alternative — and what shipped — is a hardcoded list per provider. That
 * list is wrong the moment a provider ships anything, and it is wrong in the
 * two directions that both hurt: it offers models a given key has no access to
 * (org-restricted, tier-gated, region-limited), and it hides ones the user is
 * paying for. A key is the only thing that actually knows, so ask it.
 *
 * The hardcoded list stays as the offline fallback in `options/models.ts`. This
 * is an enhancement over it, never a dependency: no key, no network, an expired
 * key or a provider that changed its listing endpoint all fall back to the
 * static choices rather than leaving an empty dropdown.
 *
 * Egress note: these calls go to the provider the user already chose and
 * authenticated against, carrying nothing but that key. They happen only on the
 * Settings page, only once a key is present, and never on the query path — so
 * they add no new destination beyond the one BYOK already declares.
 */

import type { ByokProvider } from "@/domain/generator.js";

/** Only models that can hold a conversation are useful to Sherpa. */
const CHAT_CAPABLE: Record<ByokProvider, RegExp> = {
  /**
   * OpenAI's listing includes embeddings, audio, image and moderation models,
   * all of which would 404 the chat endpoint if selected.
   */
  openai: /^(gpt|o\d)/i,
  anthropic: /^claude/i,
  gemini: /^(models\/)?gemini/i,
};

/**
 * Ranked newest-capable-first, matching the static list's contract that the
 * first entry is a sensible automatic pick when the provider changes.
 *
 * Providers return their listings in an order nobody documents — creation time,
 * alphabetical, arbitrary — so sorting is ours to do. Descending lexicographic
 * puts `gpt-5` above `gpt-4o` and `claude-opus-5` above `claude-haiku-4-5`,
 * which is right often enough to be a better default than the raw order, and
 * the user can pick anything regardless.
 */
function rank(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
}

interface Listing {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly extract: (json: unknown) => string[];
}

function listing(provider: ByokProvider, apiKey: string): Listing {
  if (provider === "openai") {
    return {
      url: "https://api.openai.com/v1/models",
      headers: { authorization: `Bearer ${apiKey}` },
      extract: (json) =>
        ((json as { data?: { id?: string }[] })?.data ?? [])
          .map((m) => m.id ?? "")
          .filter(Boolean),
    };
  }
  if (provider === "anthropic") {
    return {
      url: "https://api.anthropic.com/v1/models?limit=100",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        // The same opt-in the answer path already sends; without it the browser
        // is refused outright.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      extract: (json) =>
        ((json as { data?: { id?: string }[] })?.data ?? [])
          .map((m) => m.id ?? "")
          .filter(Boolean),
    };
  }
  return {
    // Gemini authenticates by query parameter, not header.
    url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=200`,
    headers: {},
    extract: (json) =>
      ((json as { models?: { name?: string; supportedGenerationMethods?: string[] }[] })?.models ?? [])
        // Embedding models list here too and cannot generate.
        .filter((m) => m.supportedGenerationMethods?.includes("generateContent") !== false)
        .map((m) => (m.name ?? "").replace(/^models\//, ""))
        .filter(Boolean),
  };
}

export interface ModelListResult {
  readonly models: readonly string[];
  /** Set when the list could not be fetched, so the UI can say why. */
  readonly error?: string;
}

/**
 * Fetch the models this key can use. Never throws: a failure is a reported
 * reason plus an empty list, and the caller keeps its static choices.
 */
export async function fetchModels(
  provider: ByokProvider,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<ModelListResult> {
  const key = apiKey.trim();
  if (key === "") return { models: [] };

  const spec = listing(provider, key);
  try {
    const res = await fetcher(spec.url, { headers: spec.headers });
    if (!res.ok) {
      // 401 is the one worth naming: it means the key is wrong, which is a
      // different problem from the provider being unreachable, and the user
      // can fix it immediately.
      return {
        models: [],
        error: res.status === 401 || res.status === 403 ? "Key rejected." : `Provider returned ${res.status}.`,
      };
    }
    const ids = spec.extract(await res.json());
    const usable = rank(ids.filter((id) => CHAT_CAPABLE[provider].test(id)));
    return usable.length > 0 ? { models: usable } : { models: [], error: "No usable models for this key." };
  } catch {
    return { models: [], error: "Could not reach the provider." };
  }
}
