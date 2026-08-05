/**
 * Starter questions for the empty state (PRD 5.9.7).
 *
 * Derived from the index's own content, so they're answerable — but the
 * phrasing has to fit the heading. Wrapping everything in "How do I …?"
 * produced "How do I release Notes?" and "How do I new features?", which reads
 * as broken software before the user has asked anything.
 *
 * So each candidate is classified by grammatical shape and phrased
 * accordingly, and anything that doesn't classify cleanly is dropped: two good
 * suggestions beat three nonsensical ones.
 */

/** Verbs help docs actually use in task titles. */
const TASK_VERBS = new Set([
  "add", "archive", "assign", "build", "configure", "connect", "create",
  "customise", "customize", "delete", "disable", "download", "edit", "enable",
  "export", "filter", "generate", "import", "install", "integrate", "invite",
  "manage", "migrate", "publish", "remove", "request", "reset", "rotate",
  "schedule", "send", "set", "share", "sync", "track", "troubleshoot",
  "update", "upload", "use", "view",
]);

/**
 * Pages that make poor suggestions: dated, transient, or navigational. A
 * changelog answers "what shipped in July", not a question anyone opens a help
 * search to ask.
 */
const NOISE =
  /\b(release notes?|changelog|what'?s new|coming soon|deprecat|web release|home|index|overview page|sitemap)\b/i;

const MONTH_YEAR = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b.*\d{4}/i;

export type TitleShape = "question" | "gerund" | "imperative" | "noun" | "unusable";

/**
 * A page no suggestion should come from — a changelog, a dated release post, a
 * navigational stub. Checked against the title *and* the heading path, because
 * falling back to the breadcrumb of a rejected page just relocates the problem:
 * "Release Notes" became "What is Releases?".
 */
export function isNoisePage(title: string, headingPath = ""): boolean {
  const text = `${title} ${headingPath}`;
  return NOISE.test(text) || MONTH_YEAR.test(text);
}

/** Strip a trailing bracketed audience tag: "Plays as an asset [admin]". */
function tidy(title: string): string {
  return title
    .replace(/\s*\[[^\]]*\]\s*$/, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "Creating" → "create", "Setting" → "set". */
function deGerund(word: string): string | null {
  const lower = word.toLowerCase();
  if (!lower.endsWith("ing") || lower.length < 5) return null;

  const stem = lower.slice(0, -3);
  // "setting" → "set", "getting" → "get": undouble a final consonant.
  const undoubled = /(.)\1$/.test(stem) ? stem.slice(0, -1) : null;
  // "creating" → "create": restore a dropped 'e'.
  const restored = `${stem}e`;

  for (const candidate of [stem, undoubled, restored]) {
    if (candidate && TASK_VERBS.has(candidate)) return candidate;
  }
  return null;
}

export function classify(title: string): TitleShape {
  const text = tidy(title);
  if (text.length < 6 || text.length > 70) return "unusable";
  if (NOISE.test(text) || MONTH_YEAR.test(text)) return "unusable";

  if (text.endsWith("?")) return "question";

  const first = text.split(/\s+/)[0] ?? "";
  if (deGerund(first)) return "gerund";
  if (TASK_VERBS.has(first.toLowerCase())) return "imperative";

  // A full sentence masquerading as a heading ("Roleplay ends in any of these
  // cases") makes an awkward question; a short noun phrase makes a good one.
  const words = text.split(/\s+/).length;
  return words <= 5 ? "noun" : "unusable";
}

/**
 * Phrase one title as a question a user would plausibly type, or null when it
 * can't be phrased naturally.
 */
export function toQuestion(title: string): string | null {
  const text = tidy(title);
  switch (classify(text)) {
    case "question":
      return text;
    case "gerund": {
      const [first, ...rest] = text.split(/\s+/);
      const verb = deGerund(first ?? "");
      return verb ? `How do I ${[verb, ...rest].join(" ")}?` : null;
    }
    case "imperative": {
      const [first, ...rest] = text.split(/\s+/);
      return `How do I ${[first?.toLowerCase(), ...rest].join(" ")}?`;
    }
    case "noun":
      return `What is ${text}?`;
    default:
      return null;
  }
}

/**
 * Generic questions worth offering on any help centre — but only when the
 * index actually contains matching content. Suggesting a question the corpus
 * can't answer wastes the user's first impression and pollutes the gap report
 * with a failure we manufactured.
 */
const GENERIC: readonly { readonly test: RegExp; readonly question: string }[] = [
  { test: /\b(getting started|get started|quick ?start|onboarding|first steps)\b/i, question: "How do I get started?" },
  { test: /\b(limit|quota|maximum of|cap(?:ped)? at|file size)\b/i, question: "What are the limits and quotas?" },
  { test: /\b(permission|role|admin access|access level)\b/i, question: "What permissions do I need to be an admin?" },
  { test: /\b(troubleshoot|error code|fails?|failed|not working)\b/i, question: "What should I check when something fails?" },
  { test: /\b(integrat|webhook|api key|sso|saml)\b/i, question: "How do I connect this to other tools?" },
  { test: /\b(import|export|bulk|csv)\b/i, question: "How do I import or export data in bulk?" },
];

export interface StarterSource {
  readonly title: string;
  readonly headingPath: string;
  /** Rough size of the page, so thin stubs lose to substantial articles. */
  readonly weight: number;
}

/**
 * Build the starter list: a couple of concrete, index-derived questions plus a
 * generic one the corpus can demonstrably answer. Sources are drawn from
 * different top-level sections so three suggestions don't all cover one topic.
 */
export function buildStarters(
  sources: readonly StarterSource[],
  corpusSample: string,
  limit = 3,
): string[] {
  const bySection = new Map<string, StarterSource[]>();
  for (const source of sources) {
    const section = source.headingPath.split(">")[0]?.trim().toLowerCase() ?? "";
    const list = bySection.get(section);
    if (list) list.push(source);
    else bySection.set(section, [source]);
  }

  // Best page from each section first, so the list spans the site.
  const spread = [...bySection.values()]
    .map((list) => [...list].sort((a, b) => b.weight - a.weight))
    .sort((a, b) => (b[0]?.weight ?? 0) - (a[0]?.weight ?? 0))
    .map((list) => list[0])
    .filter((s): s is StarterSource => s !== undefined);

  const out: string[] = [];
  const seen = new Set<string>();

  for (const source of spread) {
    if (out.length >= limit - 1) break;
    if (isNoisePage(source.title, source.headingPath)) continue;
    // The breadcrumb is only a fallback when the title itself is unusable for
    // a benign reason — never a way to resurrect a rejected page.
    const question = toQuestion(source.title) ?? toQuestion(lastCrumb(source.headingPath));
    if (!question) continue;
    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(question);
  }

  for (const { test, question } of GENERIC) {
    if (out.length >= limit) break;
    if (!test.test(corpusSample)) continue;
    if (seen.has(question.toLowerCase())) continue;
    seen.add(question.toLowerCase());
    out.push(question);
  }

  return out.slice(0, limit);
}

function lastCrumb(headingPath: string): string {
  return headingPath.split(">").pop()?.trim() ?? "";
}
