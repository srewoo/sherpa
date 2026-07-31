/** Crawl-time contracts (PRD 5.2). Kept transport-agnostic so the engine can
 * be driven by a real fetch in the offscreen doc or a mock in tests. */

export interface FetchResult {
  /** The URL we requested. */
  readonly url: string;
  /** The URL after redirects — used for auth-wall and canonical detection. */
  readonly finalUrl: string;
  readonly status: number;
  /** Response body, or null for non-HTML / error responses. */
  readonly html: string | null;
  readonly etag: string | undefined;
  readonly lastmod: string | undefined;
  /** `X-Robots-Tag` header verbatim, when present (PRD 5.2.4). */
  readonly robotsTag?: string | undefined;
}

/** A blocked-on-auth signal surfaced to the UI (PRD 5.2.8). */
export interface AuthWall {
  readonly host: string;
  readonly kind: "session" | "basic";
}

export type Fetcher = (url: string) => Promise<FetchResult>;

/** Extract in-page links from HTML relative to `baseUrl`. Injected so the
 * engine stays DOM-free and testable; the offscreen impl uses DOMParser. */
export type LinkExtractor = (html: string, baseUrl: string) => string[];
