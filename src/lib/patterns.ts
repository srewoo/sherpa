/**
 * Include/exclude URL glob matching (PRD 5.1.5).
 *
 * A tiny, dependency-free glob: `*` matches any run of characters, `?` matches
 * exactly one. Patterns are matched against the full canonical URL. Exclude
 * wins over include, matching user intuition ("index everything except /blog").
 */

export interface ScopeRules {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** Compile a glob into an anchored RegExp. Exported for testing. */
export function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (const ch of glob) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else out += escapeRegExp(ch);
  }
  out += "$";
  return new RegExp(out);
}

function matchesAny(url: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(url));
}

/**
 * Decide whether a URL is in scope. An empty include list means "include
 * everything under the crawl root"; exclude always overrides include.
 */
export function inScope(url: string, rules: ScopeRules): boolean {
  if (matchesAny(url, rules.exclude)) return false;
  if (rules.include.length === 0) return true;
  return matchesAny(url, rules.include);
}

/** Sensible defaults surfaced pre-filled in the crawl-setup UI. */
export const DEFAULT_EXCLUDES: readonly string[] = [
  "*/blog/*",
  "*?print=*",
  "*.pdf",
];
