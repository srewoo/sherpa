/**
 * Fast non-cryptographic content hashing (PRD 5.2.7, 5.3). Used for content
 * dedupe and change detection on recrawl — not for security. FNV-1a (32-bit)
 * is synchronous and dependency-free, unlike SubtleCrypto.
 */

export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // h *= 16777619, kept in 32-bit range via Math.imul
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
