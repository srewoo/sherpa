/**
 * Crawl configuration schema (PRD 5.1). Validated with zod because it is
 * external input — it comes from the setup UI and from imported index files,
 * both of which can be malformed.
 */

import { z } from "zod";

export const scopeRulesSchema = z.object({
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
});

export const crawlConfigSchema = z.object({
  /** Canonical crawl root, e.g. https://docs.northwind.com/ */
  root: z.string().url(),
  /** Optional sitemap override; auto-discovered when omitted (PRD 5.1.2). */
  sitemapUrl: z.string().url().optional(),
  scope: scopeRulesSchema.default({ include: [], exclude: [] }),
  maxPages: z.number().int().positive().max(50_000).default(5_000),
  maxDepth: z.number().int().positive().max(50).default(10),
  /** Politeness (PRD 5.2.3): requests/sec and concurrency, both host-scoped. */
  requestsPerSecond: z.number().positive().max(10).default(1),
  concurrency: z.number().int().positive().max(8).default(3),
  /** Abort the crawl after this many consecutive failures (PRD 5.2.5). */
  failureCeiling: z.number().int().positive().default(20),
});

export type ScopeRules = z.infer<typeof scopeRulesSchema>;
export type CrawlConfig = z.infer<typeof crawlConfigSchema>;

/** Parse and normalise raw config, throwing a ZodError on invalid input. */
export function parseCrawlConfig(raw: unknown): CrawlConfig {
  return crawlConfigSchema.parse(raw);
}
