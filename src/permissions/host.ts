/**
 * Per-site host permissions (PRD 5.10.3). Requested at crawl time, not up front,
 * so the install prompt stays minimal and Web Store review is easier (8.4).
 */

/** Origin match pattern for a crawl root, e.g. https://docs.northwind.com/* */
export function originPattern(root: string): string {
  const u = new URL(root);
  return `${u.protocol}//${u.hostname}/*`;
}

export async function hasHostPermission(root: string): Promise<boolean> {
  return chrome.permissions.contains({ origins: [originPattern(root)] });
}

/** Prompt for access to the crawl host. Must be called from a user gesture. */
export async function requestHostPermission(root: string): Promise<boolean> {
  return chrome.permissions.request({ origins: [originPattern(root)] });
}
