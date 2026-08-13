/**
 * Tier 2 — Bring your own key (PRD 5.8.6). The user's key is read from
 * chrome.storage.local and sent only to their chosen provider. This is the one
 * path where queries + retrieved chunks leave the device, gated behind the
 * explicit BYOK warning in the UI.
 */

import type { AnswerChunk, AnswerGenerator, AnswerRequest, ByokProvider, TierAvailability } from "@/domain/generator.js";
import { buildGroundedPrompt } from "./prompt.js";
import { BYOK_PACK } from "./context.js";

export interface ByokConfig {
  readonly provider: ByokProvider;
  readonly model: string;
  readonly apiKey: string;
}

const SYSTEM = "You are a documentation assistant. Answer strictly from the provided context and cite sources as [n].";

/**
 * Output ceiling for a BYOK answer.
 *
 * Was 1,024 — enough for a paragraph, and not enough for the multi-step
 * procedures that are most of a help centre. A truncated answer looks complete,
 * which is the failure mode this whole tier exists to avoid; the tokens are the
 * user's own and they chose to spend them.
 */
const MAX_ANSWER_TOKENS = 4096;

async function* sseData(res: Response): AsyncIterable<string> {
  if (!res.ok || !res.body) throw new Error(`provider error ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}

function request(cfg: ByokConfig, prompt: string): Request {
  if (cfg.provider === "openai") {
    return new Request("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        stream: true,
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
      }),
    });
  }
  if (cfg.provider === "anthropic") {
    return new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: MAX_ANSWER_TOKENS,
        stream: true,
        system: SYSTEM,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:streamGenerateContent?alt=sse&key=${cfg.apiKey}`;
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    }),
  });
}

function extractDelta(provider: ByokProvider, data: string): string {
  if (data === "[DONE]") return "";
  try {
    const json = JSON.parse(data) as Record<string, unknown>;
    if (provider === "openai") {
      const choices = json["choices"] as { delta?: { content?: string } }[] | undefined;
      return choices?.[0]?.delta?.content ?? "";
    }
    if (provider === "anthropic") {
      const delta = json["delta"] as { text?: string } | undefined;
      return delta?.text ?? "";
    }
    const candidates = json["candidates"] as { content?: { parts?: { text?: string }[] } }[] | undefined;
    return candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  } catch {
    return "";
  }
}

export class ByokGenerator implements AnswerGenerator {
  readonly tier = "byok" as const;
  readonly pack = BYOK_PACK;
  constructor(private readonly cfg: ByokConfig) {}

  availability(): Promise<TierAvailability> {
    return Promise.resolve({
      tier: this.tier,
      state: this.cfg.apiKey ? "available" : "unavailable",
      detail: `${this.cfg.provider} · ${this.cfg.model}`,
    });
  }

  async *answer(req: AnswerRequest): AsyncIterable<AnswerChunk> {
    const context = req.context;
    const res = await fetch(request(this.cfg, buildGroundedPrompt(req.query, context)));
    for await (const data of sseData(res)) {
      const delta = extractDelta(this.cfg.provider, data);
      if (delta) yield { delta };
    }
  }

  /**
   * A short prompt with no grounding, for query understanding.
   *
   * Reuses the same streaming request the answer path uses and joins the
   * pieces, rather than adding a second per-provider request shape to keep in
   * step. These prompts produce a sentence or two, so the streaming overhead is
   * irrelevant and the saving in duplicated provider quirks is not.
   */
  async complete(prompt: string): Promise<string> {
    const res = await fetch(request(this.cfg, prompt));
    let out = "";
    for await (const data of sseData(res)) {
      out += extractDelta(this.cfg.provider, data) ?? "";
    }
    return out.trim();
  }
}
