/** BYOK model choices per provider (PRD 5.8.6). */
import type { ByokProvider } from "@/domain/generator.js";

/**
 * Most capable first in each list, because the first entry is what a provider
 * switch selects — and the reason to configure BYOK at all is that the
 * on-device model can't finish a long procedure.
 *
 * Anthropic IDs are the exact alias strings; a date suffix is not appended
 * (`claude-haiku-4-5`, never `claude-haiku-4-5-20251001`) — the suffixed form
 * was here before and is not the documented alias.
 */
export const PROVIDER_MODELS: Record<ByokProvider, readonly string[]> = {
  openai: ["gpt-4o", "gpt-4o-mini", "o4-mini"],
  anthropic: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash"],
};

export const PROVIDERS: readonly ByokProvider[] = ["openai", "anthropic", "gemini"];

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
