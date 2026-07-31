/**
 * robots.txt parsing and evaluation (PRD 5.2.4).
 *
 * Standard longest-match semantics: the most specific matching Allow/Disallow
 * rule wins; on an equal-length tie, Allow wins. Groups are selected by
 * user-agent, falling back to the `*` group. We also surface Crawl-delay and
 * any Sitemap: directives, which seed discovery (PRD 5.1.2).
 */

interface Rule {
  readonly allow: boolean;
  readonly path: string;
}

interface Group {
  readonly agents: string[];
  readonly rules: Rule[];
  crawlDelay: number | undefined;
}

export interface Robots {
  readonly groups: readonly Group[];
  readonly sitemaps: readonly string[];
}

/** Parse robots.txt text into an evaluable structure. */
export function parseRobots(text: string): Robots {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let expectingAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    switch (field) {
      case "user-agent": {
        if (!expectingAgent || current === null) {
          current = { agents: [], rules: [], crawlDelay: undefined };
          groups.push(current);
        }
        current.agents.push(value.toLowerCase());
        expectingAgent = true;
        break;
      }
      case "allow":
      case "disallow": {
        if (current === null) break;
        expectingAgent = false;
        if (field === "disallow" && value === "") break; // empty Disallow = allow all
        current.rules.push({ allow: field === "allow", path: value });
        break;
      }
      case "crawl-delay": {
        if (current === null) break;
        expectingAgent = false;
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
        break;
      }
      case "sitemap":
        sitemaps.push(value);
        break;
      default:
        expectingAgent = false;
    }
  }
  return { groups, sitemaps };
}

function pickGroup(robots: Robots, ua: string): Group | undefined {
  const lower = ua.toLowerCase();
  let star: Group | undefined;
  for (const g of robots.groups) {
    for (const a of g.agents) {
      if (a === "*") star = g;
      else if (lower.includes(a)) return g;
    }
  }
  return star;
}

/**
 * Is `path` (URL pathname + search) crawlable for this user-agent? No matching
 * group, or no matching rule, means allowed.
 */
export function isAllowed(robots: Robots, path: string, ua: string): boolean {
  const group = pickGroup(robots, ua);
  if (!group) return true;

  let best: Rule | undefined;
  for (const rule of group.rules) {
    if (rule.path === "" || path.startsWith(rule.path)) {
      if (!best || rule.path.length > best.path.length) best = rule;
      else if (rule.path.length === best.path.length && rule.allow) best = rule;
    }
  }
  return best ? best.allow : true;
}

/** Crawl-delay in seconds for this user-agent, if the site declares one. */
export function crawlDelay(robots: Robots, ua: string): number | undefined {
  return pickGroup(robots, ua)?.crawlDelay;
}
