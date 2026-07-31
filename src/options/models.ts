/** BYOK model choices per provider (PRD 5.8.6). */
import type { ByokProvider } from "@/domain/generator.js";

export const PROVIDER_MODELS: Record<ByokProvider, readonly string[]> = {
  openai: ["gpt-4o-mini", "gpt-4o", "o4-mini"],
  anthropic: ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5-20251001"],
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro"],
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
