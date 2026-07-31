/**
 * Persisted user settings (PRD 5.8, 5.10.5). The BYOK key lives only in
 * chrome.storage.local and is never sent anywhere but the chosen provider.
 */

import type { AnswerSettings } from "@/generator/select.js";

export interface Settings {
  readonly answer: AnswerSettings;
  /** Refusal floor — best-cosine score below which we don't generate. */
  readonly floor: number;
  readonly activeIndexId: string | undefined;
}

const DEFAULTS: Settings = { answer: { mode: "auto" }, floor: 0.45, activeIndexId: undefined };

const hasStorage = (): boolean => typeof chrome !== "undefined" && Boolean(chrome.storage?.local);

export async function loadSettings(): Promise<Settings> {
  if (!hasStorage()) return DEFAULTS;
  const s = await chrome.storage.local.get(["answer", "floor", "activeIndexId"]);
  return {
    answer: (s["answer"] as AnswerSettings) ?? DEFAULTS.answer,
    floor: typeof s["floor"] === "number" ? (s["floor"] as number) : DEFAULTS.floor,
    activeIndexId: (s["activeIndexId"] as string | undefined) ?? undefined,
  };
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  if (!hasStorage()) return;
  await chrome.storage.local.set(patch);
}
