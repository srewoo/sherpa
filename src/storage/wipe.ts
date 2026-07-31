/**
 * One-click "delete everything" (PRD 5.10.6). Drops the whole database and
 * clears extension-local settings (including any BYOK key), leaving no residue.
 */

import { DB_NAME } from "./schema.js";

export function deleteEverything(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => {
      void chrome.storage.local.clear().then(resolve);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve(); // will complete once connections close
  });
}
