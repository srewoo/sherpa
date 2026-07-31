/**
 * Help-platform detection + extraction profiles (PRD 5.1.7). Generic extraction
 * is the floor; when we recognise a known platform we point at its real content
 * root and strip its specific chrome (TOCs, vote widgets, pagination).
 */

export type Platform =
  | "docusaurus"
  | "gitbook"
  | "zendesk"
  | "document360"
  | "confluence"
  | "intercom"
  | "readme"
  | "generic";

export interface ExtractionProfile {
  readonly rootSelectors: readonly string[];
  readonly junkSelectors: readonly string[];
}

function generator(doc: Document): string {
  return doc.querySelector('meta[name="generator"]')?.getAttribute("content")?.toLowerCase() ?? "";
}

/** Detect the platform from the generator meta first, then DOM signatures. */
export function detectPlatform(doc: Document): Platform {
  const gen = generator(doc);
  if (gen.includes("docusaurus")) return "docusaurus";
  if (gen.includes("gitbook")) return "gitbook";
  if (gen.includes("document360")) return "document360";
  if (gen.includes("confluence")) return "confluence";
  if (gen.includes("readme")) return "readme";

  if (doc.querySelector("#__docusaurus, .theme-doc-markdown")) return "docusaurus";
  if (doc.querySelector('[data-testid="page.desktop"], .gitbook-root')) return "gitbook";
  if (doc.querySelector(".article-body, .article-votes")) return "zendesk";
  if (doc.querySelector("#articleContent, .d360-article")) return "document360";
  if (doc.querySelector("#main-content .wiki-content, #com-atlassian-confluence")) return "confluence";
  if (doc.querySelector(".intercom-force-scroll, .article__body")) return "intercom";
  if (doc.querySelector(".rm-Guides, .rm-Article")) return "readme";
  return "generic";
}

const PROFILES: Record<Platform, ExtractionProfile> = {
  docusaurus: {
    rootSelectors: ["article .theme-doc-markdown", ".theme-doc-markdown", "article", "main"],
    junkSelectors: [".theme-doc-toc-desktop", ".theme-doc-toc-mobile", ".pagination-nav", ".theme-doc-breadcrumbs", ".tableOfContents"],
  },
  gitbook: {
    rootSelectors: ['[data-testid="page.desktop"]', "main", "article"],
    junkSelectors: [".gitbook-toc", "[aria-label='Table of contents']"],
  },
  zendesk: {
    rootSelectors: [".article-body", ".article", "main"],
    junkSelectors: [".article-votes", ".article-relatives", ".article-comments", ".article-return-to-top"],
  },
  document360: {
    rootSelectors: ["#articleContent", ".article-content", "main"],
    junkSelectors: [".article-feedback", ".related-articles", ".article-rating"],
  },
  confluence: {
    rootSelectors: ["#main-content", ".wiki-content", "main"],
    junkSelectors: ["#breadcrumbs", ".aui-nav", ".page-metadata", "#likes-and-labels-container"],
  },
  intercom: {
    rootSelectors: [".article__body", "article", "main"],
    junkSelectors: [".intercom-reaction", ".article__reactions"],
  },
  readme: {
    rootSelectors: [".markdown-body", ".rm-Article", "main", "article"],
    junkSelectors: [".rm-Header", ".rm-Sidebar", ".PageThumbs"],
  },
  generic: {
    rootSelectors: ["main", "article", '[role="main"]'],
    junkSelectors: [],
  },
};

export function profileFor(platform: Platform): ExtractionProfile {
  return PROFILES[platform];
}
