/**
 * One-click "delete everything" (PRD 5.10.6). Drops the whole database and
 * clears extension-local settings, including any BYOK key, leaving no residue.
 *
 * The offscreen document holds its own connection, and `deleteDatabase` blocks
 * for as long as any connection is open — so we ask every context to close
 * first, and report honestly when the delete is still blocked rather than
 * claiming success.
 */

import { closeSherpaDb } from "./db.js";
import { DB_NAME } from "./schema.js";

const BLOCKED_GRACE_MS = 3000;

export interface WipeResult {
  readonly deleted: boolean;
  /** Set when the database couldn't be dropped, so the UI can say why. */
  readonly blockedBy?: string;
}

function requestClose(): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.runtime?.id) return Promise.resolve();
  // Fire-and-forget: contexts that aren't listening simply reject.
  return chrome.runtime
    .sendMessage({ type: "db/close" })
    .then(() => undefined)
    .catch(() => undefined);
}

function deleteDatabase(): Promise<WipeResult> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    let blocked = false;

    req.onsuccess = () => resolve({ deleted: true });
    req.onerror = () => reject(req.error ?? new Error("deleteDatabase failed"));
    req.onblocked = () => {
      blocked = true;
    };

    // `onblocked` doesn't end the request — it fires and then keeps waiting.
    // Give the other contexts a moment to close, then tell the truth.
    setTimeout(() => {
      if (blocked) {
        resolve({
          deleted: false,
          blockedBy:
            "Another Sherpa page still has the index open. Close other Sherpa tabs and try again.",
        });
      }
    }, BLOCKED_GRACE_MS);
  });
}

export async function deleteEverything(): Promise<WipeResult> {
  await requestClose();
  await closeSherpaDb();

  const result = await deleteDatabase();

  // Settings (and the API key) go regardless — a blocked database delete must
  // never leave the key behind.
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.clear();
  }
  return result;
}
