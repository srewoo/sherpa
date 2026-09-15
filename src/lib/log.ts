/**
 * Event logging with fields, and a buffer the user can hand over.
 *
 * There were eighteen `console.*` calls across the extension, all of them prose
 * — "sherpa: stored answer settings are not an object; using defaults" — and
 * all of them useless the moment they mattered. An extension has three separate
 * consoles (the panel, the service worker, the hidden offscreen document), a
 * user reporting a bug can reach roughly none of them, and prose cannot be
 * grepped, counted or diffed between a working install and a broken one.
 *
 * Echo's `structlog` calls are the model: a stable event name plus fields
 * (`logger.warning("circuit_opened", name=..., failures=...)`). The name is the
 * thing you search for and the fields are the evidence. This adds the part a
 * local-first product needs and a server does not — a ring buffer the user can
 * export, because there is no log aggregator to look in and asking someone to
 * open `chrome://extensions`, find an inspect link for a hidden document, and
 * copy a console is not a bug report anyone completes.
 *
 * Everything logged is masked. These lines are written to be handed to somebody
 * else, which makes them egress, and the query text that lands in them is
 * exactly the text `pii.ts` exists to keep out of exports.
 */

import { maskPii } from "./pii.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  readonly at: number;
  readonly level: LogLevel;
  /**
   * A stable, greppable name. `snake_case`, present tense, no interpolation —
   * `tier_selected`, not `"answering with " + tier`. The whole point is that
   * two installs a year apart produce the same string for the same event.
   */
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>>;
  /** Which extension context wrote it; the three have separate consoles. */
  readonly context: string;
}

/**
 * How many entries are kept.
 *
 * Three hundred is a few minutes of a busy crawl and several days of ordinary
 * asking. Large enough that the event which caused a bug is usually still
 * present when the user gets round to exporting; small enough to stay well
 * inside a storage quota that the index itself is competing for.
 */
export const MAX_ENTRIES = 300;

const STORAGE_KEY = "diagnostics";

let context = "unknown";
let buffer: LogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/** Name this context, so exported lines say where they came from. */
export function setLogContext(name: string): void {
  context = name;
}

const hasStorage = (): boolean => typeof chrome !== "undefined" && Boolean(chrome.storage?.local);

/**
 * Redact field values before they are stored.
 *
 * Strings are masked; numbers and booleans pass through; anything else is
 * stringified and masked, because a nested object is exactly where a query or
 * a URL ends up hiding. Keys are left alone — a key is chosen by us, a value
 * comes from the world.
 */
function safeFields(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "number" || typeof value === "boolean" || value === null) {
      out[key] = value;
    } else if (typeof value === "string") {
      out[key] = maskPii(value);
    } else if (value === undefined) {
      out[key] = null;
    } else {
      try {
        out[key] = maskPii(JSON.stringify(value) ?? "");
      } catch {
        // Circular, or something with a throwing getter. The event name and
        // the other fields are still worth keeping.
        out[key] = "[unserialisable]";
      }
    }
  }
  return out;
}

/**
 * Write the buffer out, coalesced.
 *
 * Debounced rather than written per entry: a crawl logs steadily, and a
 * `chrome.storage.local.set` per page fetched would put storage I/O on the
 * crawl's hot path to preserve lines nobody will read. A second of lag risks
 * losing the last few entries if the offscreen document is torn down — which is
 * an acceptable trade against slowing down the thing being diagnosed.
 */
function scheduleFlush(): void {
  if (!hasStorage() || flushTimer !== undefined) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    void flush();
  }, 1000);
}

export async function flush(): Promise<void> {
  if (!hasStorage()) return;
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY]);
    const existing = Array.isArray(stored[STORAGE_KEY]) ? (stored[STORAGE_KEY] as LogEntry[]) : [];
    // Merged and re-sorted, because three contexts write to one key and the
    // interleaving of events between them is usually the story.
    const merged = [...existing, ...buffer]
      .sort((a, b) => a.at - b.at)
      .slice(-MAX_ENTRIES);
    buffer = [];
    await chrome.storage.local.set({ [STORAGE_KEY]: merged });
  } catch {
    // Logging must never be the thing that breaks. Dropping the buffer is the
    // correct failure: retaining it would grow without bound behind a storage
    // error that is not going to clear.
    buffer = [];
  }
}

function write(level: LogLevel, event: string, fields: Readonly<Record<string, unknown>> = {}): void {
  const entry: LogEntry = { at: Date.now(), level, event, fields: safeFields(fields), context };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer = buffer.slice(-MAX_ENTRIES);
  scheduleFlush();

  /**
   * Still printed, because the console is genuinely the better tool while
   * somebody is sitting in front of it. The event name goes first so a filter
   * on it works, and the fields stay structured rather than being interpolated
   * into a sentence.
   */
  const line = `sherpa ${event}`;
  if (level === "error") console.error(line, entry.fields);
  else if (level === "warn") console.warn(line, entry.fields);
  else if (level === "info") console.info(line, entry.fields);
  else console.debug(line, entry.fields);
}

export const log = {
  debug: (event: string, fields?: Readonly<Record<string, unknown>>) => write("debug", event, fields),
  info: (event: string, fields?: Readonly<Record<string, unknown>>) => write("info", event, fields),
  warn: (event: string, fields?: Readonly<Record<string, unknown>>) => write("warn", event, fields),
  error: (event: string, fields?: Readonly<Record<string, unknown>>) => write("error", event, fields),
};

/** Entries not yet written out. Exposed for tests and for a synchronous export. */
export function pending(): readonly LogEntry[] {
  return buffer;
}

export async function readDiagnostics(): Promise<readonly LogEntry[]> {
  if (!hasStorage()) return [...buffer];
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY]);
    const existing = Array.isArray(stored[STORAGE_KEY]) ? (stored[STORAGE_KEY] as LogEntry[]) : [];
    return [...existing, ...buffer].sort((a, b) => a.at - b.at).slice(-MAX_ENTRIES);
  } catch {
    return [...buffer];
  }
}

export async function clearDiagnostics(): Promise<void> {
  buffer = [];
  if (!hasStorage()) return;
  try {
    await chrome.storage.local.remove(STORAGE_KEY);
  } catch {
    /* nothing useful to do, and nothing depends on it */
  }
}

/**
 * The text a user pastes into a bug report.
 *
 * Plain text rather than JSON: it is going into an email or an issue, where
 * JSON is read by nobody and wraps badly. One line per event, fields appended
 * as `key=value`, most recent last so the tail is the interesting part.
 */
export function formatDiagnostics(entries: readonly LogEntry[]): string {
  const header = [
    "Sherpa diagnostics",
    `exported ${new Date().toISOString()}`,
    `${entries.length} events`,
    "Queries and URLs in this file have been redacted (see lib/pii.ts).",
    "",
  ].join("\n");
  const body = entries
    .map((e) => {
      const fields = Object.entries(e.fields)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
      return `${new Date(e.at).toISOString()} ${e.level.toUpperCase().padEnd(5)} [${e.context}] ${e.event}${fields ? ` ${fields}` : ""}`;
    })
    .join("\n");
  return `${header}${body}\n`;
}
