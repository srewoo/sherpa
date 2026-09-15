/**
 * A running total of what BYOK has cost, kept where the user can see it.
 *
 * Tokens and money accumulate per day and per model. Per day because that is
 * the unit a bill is read in and the unit a runaway shows up in; per model
 * because "which of these is actually expensive" is the question anyone asks
 * the moment they see a total at all.
 *
 * `chrome.storage.local` rather than IndexedDB. The record is a handful of
 * numbers, the Options page reads it without opening the database, and it
 * survives an index being deleted — the spend happened whether or not the site
 * it was spent on is still indexed.
 */

import { addUsage, costUsd, ZERO_USAGE, type TokenUsage } from "./usage.js";

/** One day's spend against one model. */
export interface DaySpend {
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** Calls, so an average per answer is available without a second counter. */
  readonly calls: number;
  /** Undefined where no rate is published for the model. Never defaulted to 0. */
  readonly costUsd?: number;
  /** True if any part of the total came from a character-count estimate. */
  readonly estimated: boolean;
}

/** `YYYY-MM-DD` → model → spend. */
export type SpendLedger = Readonly<Record<string, Readonly<Record<string, DaySpend>>>>;

const STORAGE_KEY = "byokSpend";

/**
 * How many days are retained.
 *
 * Thirty, matching the window most card statements are read over. Long enough
 * to answer "what did last month cost"; short enough that an extension's local
 * storage never becomes an unbounded financial record of somebody's work.
 */
export const RETAIN_DAYS = 30;

/**
 * The local calendar day.
 *
 * Local rather than UTC on purpose: the user compares this against their own
 * afternoon, and a total that rolls over at 1am local time reads as a bug.
 */
export function dayKey(at: number = Date.now()): string {
  const d = new Date(at);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

const hasStorage = (): boolean => typeof chrome !== "undefined" && Boolean(chrome.storage?.local);

export async function loadSpend(): Promise<SpendLedger> {
  if (!hasStorage()) return {};
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY]);
    const raw = stored[STORAGE_KEY];
    // Shape-checked rather than cast: this crossed a storage boundary, and a
    // cast on data that did cannot fail when it should. See settings.ts.
    return raw && typeof raw === "object" ? (raw as SpendLedger) : {};
  } catch {
    return {};
  }
}

/**
 * Fold one call into the ledger. Pure, so the merge rules are testable.
 *
 * Cost is summed rather than recomputed from the running token totals, because
 * a rate can change between two calls on the same day. Recomputing would
 * silently reprice yesterday's answers at today's price.
 */
export function applySpend(
  ledger: SpendLedger,
  model: string,
  usage: TokenUsage,
  at: number = Date.now(),
): SpendLedger {
  const key = dayKey(at);
  const day = ledger[key] ?? {};
  const before = day[model];
  const priorUsage: TokenUsage = before
    ? {
        promptTokens: before.promptTokens,
        completionTokens: before.completionTokens,
        estimated: before.estimated,
      }
    : ZERO_USAGE;
  const merged = addUsage(priorUsage, usage);
  const thisCall = costUsd(model, usage);
  const runningCost =
    thisCall === undefined ? before?.costUsd : (before?.costUsd ?? 0) + thisCall;

  const next: DaySpend = {
    promptTokens: merged.promptTokens,
    completionTokens: merged.completionTokens,
    calls: (before?.calls ?? 0) + 1,
    ...(runningCost === undefined ? {} : { costUsd: runningCost }),
    estimated: merged.estimated,
  };
  return prune({ ...ledger, [key]: { ...day, [model]: next } }, at);
}

/** Drop days past the retention window. */
export function prune(ledger: SpendLedger, at: number = Date.now()): SpendLedger {
  const cutoff = dayKey(at - RETAIN_DAYS * 24 * 60 * 60 * 1000);
  const kept: Record<string, Readonly<Record<string, DaySpend>>> = {};
  for (const [day, models] of Object.entries(ledger)) {
    // Lexicographic comparison is a date comparison for `YYYY-MM-DD`, which is
    // the reason for that format rather than anything friendlier to read.
    if (day >= cutoff) kept[day] = models;
  }
  return kept;
}

/** Record one call's spend. Never throws — accounting must not break answering. */
export async function recordSpend(model: string, usage: TokenUsage): Promise<void> {
  if (!hasStorage()) return;
  try {
    const ledger = await loadSpend();
    await chrome.storage.local.set({ [STORAGE_KEY]: applySpend(ledger, model, usage) });
  } catch {
    // The answer is already on screen; a failed counter is not worth an error.
  }
}

export interface SpendTotal {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly calls: number;
  /** Undefined when *no* model in range had a known rate. */
  readonly costUsd?: number;
  /**
   * True when some spend in range came from a model with no published rate, so
   * the cost shown is a floor rather than the whole figure.
   */
  readonly partialCost: boolean;
  readonly estimated: boolean;
}

/** Total the ledger over the last `days` days, inclusive of today. */
export function totalSpend(ledger: SpendLedger, days: number, at: number = Date.now()): SpendTotal {
  const cutoff = dayKey(at - (days - 1) * 24 * 60 * 60 * 1000);
  let promptTokens = 0;
  let completionTokens = 0;
  let calls = 0;
  let cost: number | undefined;
  let partialCost = false;
  let estimated = false;

  for (const [day, models] of Object.entries(ledger)) {
    if (day < cutoff) continue;
    for (const spend of Object.values(models)) {
      promptTokens += spend.promptTokens;
      completionTokens += spend.completionTokens;
      calls += spend.calls;
      estimated = estimated || spend.estimated;
      if (spend.costUsd === undefined) {
        // Spend we know happened and cannot price. Counting it as zero would
        // understate the total and never say so.
        partialCost = true;
      } else {
        cost = (cost ?? 0) + spend.costUsd;
      }
    }
  }
  return {
    promptTokens,
    completionTokens,
    calls,
    ...(cost === undefined ? {} : { costUsd: cost }),
    partialCost,
    estimated,
  };
}

export async function clearSpend(): Promise<void> {
  if (!hasStorage()) return;
  try {
    await chrome.storage.local.remove(STORAGE_KEY);
  } catch {
    /* see recordSpend */
  }
}
