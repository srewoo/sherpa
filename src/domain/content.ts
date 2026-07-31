/**
 * Shared content types produced by extraction (PRD 5.3) and consumed by
 * chunking (PRD 5.4). Kept free of any Chrome or storage concerns so the
 * extraction and retrieval pipelines can be unit-tested in isolation.
 */

export type BlockType = "heading" | "paragraph" | "code" | "list" | "table";

/** One structural block of a cleaned page, in document order. */
export interface Block {
  readonly type: BlockType;
  /** Rendered text/markdown. Lists keep their bullets; tables keep pipes. */
  readonly text: string;
  /** 1–6 for headings; undefined otherwise. */
  readonly level?: number;
  /** For headings: the in-page anchor id, so citations deep-link (PRD 5.3.7). */
  readonly anchor?: string;
}

/** Page-level context threaded into every chunk's embedded text. */
export interface PageContext {
  readonly title: string;
  /** Breadcrumb trail, e.g. ["Admin", "SSO"] (PRD 5.3.6). */
  readonly breadcrumb: readonly string[];
}

/**
 * A chunk before storage keys are attached. The caller adds page URL, page
 * title and content hash (PRD 5.4.5) once the vector index position is known.
 */
export interface ChunkDraft {
  /** What gets embedded: breadcrumb + heading path prefix, then body. */
  readonly text: string;
  /** The raw body without the prefix — what we show the user. */
  readonly body: string;
  /** "Admin > SSO > Troubleshooting" (PRD 5.4.4). */
  readonly headingPath: string;
  /** Anchor of the nearest enclosing heading, for deep links. */
  readonly anchor: string | undefined;
  /** Ordinal within the page, for neighbour expansion (PRD 5.7.5). */
  readonly position: number;
}
