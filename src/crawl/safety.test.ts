import { describe, it, expect } from "vitest";
import { isDestructiveUrl, isBinaryAsset, isUnsafeToFetch } from "./safety.js";

describe("isDestructiveUrl", () => {
  it("blocks the logout link that signed a real user out mid-crawl", () => {
    // help.mindtickle.com/logout was linked from every article and was not in
    // robots.txt. Fetching it destroyed the session, after which every
    // remaining page redirected to a login screen and the crawl collapsed.
    expect(isDestructiveUrl("https://help.mindtickle.com/logout")).toBe(true);
  });

  it("blocks the usual spellings", () => {
    for (const path of [
      "/logout",
      "/log-out",
      "/log_out",
      "/signout",
      "/sign-out",
      "/users/sign_out",
      "/session/destroy",
      "/account/deactivate",
      "/newsletter/unsubscribe",
    ]) {
      expect(isDestructiveUrl(`https://d.test${path}`), path).toBe(true);
    }
  });

  it("blocks it in the query string too", () => {
    expect(isDestructiveUrl("https://d.test/home?action=logout")).toBe(true);
    expect(isDestructiveUrl("https://d.test/p?do=delete&id=3")).toBe(true);
  });

  it("does not block an article that merely discusses logging out", () => {
    // The words appear in help content constantly; only URLs matter.
    expect(isDestructiveUrl("https://d.test/solutions/articles/how-to-log-out-safely")).toBe(false);
    expect(isDestructiveUrl("https://d.test/docs/logouts-explained")).toBe(false);
    expect(isDestructiveUrl("https://d.test/guide/signoutside-the-app")).toBe(false);
  });

  it("tolerates a malformed URL", () => {
    expect(isDestructiveUrl("not a url")).toBe(false);
  });
});

describe("isBinaryAsset", () => {
  it("skips the Freshdesk attachment that failed CORS", () => {
    expect(isBinaryAsset("https://help.mindtickle.com/helpdesk/attachments/3101979879")).toBe(true);
  });

  it("skips documents, archives, media and fonts", () => {
    for (const path of [
      "/f/report.pdf",
      "/data/User%20data.csv",
      "/x/sheet.xlsx",
      "/dl/bundle.zip",
      "/img/diagram.png",
      "/v/demo.mp4",
      "/font/inter.woff2",
    ]) {
      expect(isBinaryAsset(`https://d.test${path}`), path).toBe(true);
    }
  });

  it("still allows pages whose path merely contains a keyword", () => {
    expect(isBinaryAsset("https://d.test/docs/uploads-guide")).toBe(false);
    expect(isBinaryAsset("https://d.test/solutions/articles/csv-import-tips")).toBe(false);
  });

  it("handles a query string after the extension", () => {
    expect(isBinaryAsset("https://d.test/a/report.pdf?download=1")).toBe(true);
  });
});

describe("isUnsafeToFetch", () => {
  it("is the union of both, and lets ordinary articles through", () => {
    expect(isUnsafeToFetch("https://d.test/logout")).toBe(true);
    expect(isUnsafeToFetch("https://d.test/a.pdf")).toBe(true);
    expect(isUnsafeToFetch("https://d.test/solutions/articles/3000117623-plays")).toBe(false);
  });
});
