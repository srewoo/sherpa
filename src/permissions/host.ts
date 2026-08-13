/**
 * Per-site host permissions (PRD 5.10.3). Requested at crawl time, not up front,
 * so the install prompt stays minimal and Web Store review is easier (8.4).
 */

/**
 * Origin match patterns for a crawl root — `http://` and `https://` for the one
 * host, e.g. http://docs.northwind.com plus https://docs.northwind.com, each
 * path-wildcarded.
 *
 * Covering both schemes is load-bearing rather than lazy. Scope (`underRoot`)
 * compares hostname and path and ignores the scheme, so a site that links to
 * itself as `http://` — legacy absolute links, older help-centre content, a
 * sitemap written before the TLS migration — puts `http://` URLs in the frontier
 * even when the root is `https://`. Granting only the root's own scheme leaves
 * those fetches unprivileged, and an unprivileged extension fetch is a plain
 * cross-origin request: blocked by CORS before the redirect to `https` ever
 * happens. Pinning the scheme therefore fails exactly the pages that need it,
 * with an error that looks like the site's fault.
 *
 * Two patterns rather than one scheme-wildcard pattern, and that is not
 * cosmetic. Chrome checks a requested pattern against
 * `optional_host_permissions` by asking whether some *single* declared pattern
 * contains it; it does not union the declarations. The manifest declares the
 * http and https wildcards as two separate entries, so a request whose scheme
 * is `*` — meaning http *and* https — is contained by neither on its own, and
 * `permissions.request` rejects the entire call with "Only permissions
 * specified in the manifest may be requested." Split by scheme, each pattern
 * sits inside its own declaration and the grant is identical: a `*` scheme
 * matches only http and https anyway.
 *
 * This widens nothing beyond the one host — the hostname stays exact.
 */
export function originPatterns(root: string): string[] {
  const u = new URL(root);
  return [`http://${u.hostname}/*`, `https://${u.hostname}/*`];
}

export async function hasHostPermission(root: string): Promise<boolean> {
  return chrome.permissions.contains({ origins: originPatterns(root) });
}

/** Prompt for access to the crawl host. Must be called from a user gesture. */
export async function requestHostPermission(root: string): Promise<boolean> {
  return chrome.permissions.request({ origins: originPatterns(root) });
}

/**
 * The API origin each BYOK provider is called on.
 *
 * BYOK needs a host permission for the same reason a crawl does, and for the
 * reason spelled out above: an extension fetch to an origin it has no
 * permission for is a plain cross-origin request, and it dies on CORS. OpenAI
 * sends no permissive CORS headers to browser origins, so without the grant the
 * request fails at the network layer with nothing but "Failed to fetch" — which
 * reads as a broken key, or as nothing at all.
 *
 * Anthropic's `anthropic-dangerous-direct-browser-access` header in `byok.ts`
 * addresses the *provider's* half of this for that one provider. The grant is
 * the browser's half, and every provider needs it.
 */
export const PROVIDER_ORIGINS: Readonly<Record<string, string>> = {
  openai: "https://api.openai.com/*",
  anthropic: "https://api.anthropic.com/*",
  gemini: "https://generativelanguage.googleapis.com/*",
};

export function providerOrigin(provider: string): string | undefined {
  return PROVIDER_ORIGINS[provider];
}

export async function hasProviderPermission(provider: string): Promise<boolean> {
  const origin = providerOrigin(provider);
  if (!origin) return false;
  try {
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    // No permissions API in this context — don't claim a grant we can't see.
    return false;
  }
}

/**
 * Prompt for access to the provider's API. Must be called from a user gesture,
 * which is why it lives behind an explicit button in Settings rather than being
 * fired from the debounced save.
 */
export async function requestProviderPermission(provider: string): Promise<boolean> {
  const origin = providerOrigin(provider);
  if (!origin) return false;
  try {
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}
