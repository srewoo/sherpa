/**
 * Redact the personal data people put in questions without meaning to.
 *
 * Two places need this and neither had it. The query log keeps every question
 * verbatim, forever, and surfaces the clusters in a gap report that is designed
 * to be exported as CSV and handed to a docs team — so "why can't sarah.chen@
 * acme.com log in" becomes a row in a spreadsheet that leaves the machine. And
 * BYOK sends the question plus the retrieved chunks to a third party, which is
 * the one moment Sherpa's local-first promise is genuinely suspended.
 *
 * Echo masks at the persistence boundary (`db/pii.py`). The same boundary
 * applies here, with one difference worth being honest about: this cannot be
 * complete. A regex catches the shapes that are recognisably identifiers and
 * misses a name in prose entirely. It is a reduction in exposure, not a
 * guarantee, and nothing in the UI should describe it as more than that.
 */

export type PiiKind = "email" | "phone" | "card" | "ssn" | "ip" | "key" | "uuid";

export interface MaskOptions {
  /**
   * Kinds to redact. Defaults to everything.
   *
   * Narrowable because the two callers want different things. A log wants
   * everything gone. An outbound BYOK prompt is more delicate: redacting a UUID
   * out of a question about a specific record would destroy the question, so
   * that path passes a narrower set.
   */
  readonly kinds?: readonly PiiKind[];
}

interface Pattern {
  readonly kind: PiiKind;
  readonly re: RegExp;
  readonly label: string;
}

/**
 * Order matters.
 *
 * Longer, more specific shapes must run before shorter ones that could match a
 * fragment of them: an API key can contain something that looks like a UUID,
 * and a card number can contain something that looks like a phone number.
 * Running the loose patterns first leaves half-redacted strings, which are
 * worse than either outcome — they leak part of the value and look redacted.
 */
const PATTERNS: readonly Pattern[] = [
  {
    kind: "email",
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    label: "[email]",
  },
  {
    // Provider key prefixes, which are unambiguous and high-consequence. A
    // pasted key in a question would otherwise be logged in clear and, on the
    // BYOK path, sent to a provider that is not the one it belongs to.
    kind: "key",
    re: /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
    label: "[api-key]",
  },
  {
    kind: "card",
    // 13–19 digits in groups, the shape of a card rather than any long number.
    re: /\b(?:\d[ -]?){13,19}\b/g,
    label: "[card]",
  },
  {
    kind: "ssn",
    re: /\b\d{3}-\d{2}-\d{4}\b/g,
    label: "[ssn]",
  },
  {
    kind: "uuid",
    re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
    label: "[id]",
  },
  {
    kind: "phone",
    // Deliberately conservative: at least nine digits with separators, or an
    // explicit international prefix. A looser pattern eats version numbers,
    // error codes and port numbers, which are the substance of the questions
    // this product exists to answer.
    re: /(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?)?\d{3,4}[ .-]\d{3,4}[ .-]\d{3,4}\b/g,
    label: "[phone]",
  },
  {
    kind: "ip",
    re: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
    label: "[ip]",
  },
];

/**
 * Kinds redacted on the way out to a provider.
 *
 * Narrower than the log's set on purpose. An identifier is frequently the
 * *subject* of a support question — "what does error on record
 * 4f2a…-… mean" — and stripping it would send the provider a question nobody
 * asked. The kinds kept here are ones whose presence is almost never load
 * bearing and whose exposure is the most costly.
 */
export const EGRESS_KINDS: readonly PiiKind[] = ["email", "card", "ssn", "key"];

export function maskPii(text: string, options: MaskOptions = {}): string {
  const kinds = options.kinds;
  let out = text;
  for (const pattern of PATTERNS) {
    if (kinds && !kinds.includes(pattern.kind)) continue;
    // A fresh RegExp per call: a module-level /g regex carries `lastIndex`
    // between calls, so a shared one silently skips matches on every second
    // string it sees.
    out = out.replace(new RegExp(pattern.re.source, pattern.re.flags), pattern.label);
  }
  return out;
}

/** True when masking would change the text — for warning before egress. */
export function containsPii(text: string, options: MaskOptions = {}): boolean {
  return maskPii(text, options) !== text;
}
