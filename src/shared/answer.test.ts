import { describe, it, expect } from "vitest";
import type { RetrievedArticle, RetrievedChunk } from "@/domain/retrieval.js";
import { articleToSource, cleanTitle, cleanHeadingPath, relevancePercent } from "./answer.js";

function chunk(over: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    indexId: "i",
    vectorId: 0,
    text: "t",
    body: "Some body text about roleplays.",
    url: "https://help.acme.test/support/solutions/articles/1-two-way",
    anchor: undefined,
    headingPath: "Help & Support > Asset Hub > Admin",
    position: 0,
    title: "Plays as an asset [admin]",
    contentHash: "h",
    score: 0.9,
    similarity: 0.46,
    denseRank: 0,
    sparseRank: 1,
    viaNeighbour: false,
    ...over,
  };
}

function article(over: Partial<RetrievedArticle> = {}, chunkOver: Partial<RetrievedChunk> = {}): RetrievedArticle {
  const c = chunk(chunkOver);
  return {
    url: c.url,
    title: c.title,
    headingPath: c.headingPath,
    rankScore: 0.98,
    similarity: 0.46,
    anchor: undefined,
    chunks: [c],
    body: c.body,
    ...over,
  };
}

describe("cleanTitle", () => {
  it("strips a copy widget's confirmation from a stored title", () => {
    expect(cleanTitle("Plays as an asset [admin] Copied!")).toBe("Plays as an asset [admin]");
    expect(cleanTitle("Best practices for mission Copied!")).toBe("Best practices for mission");
  });

  it("strips other copy affordances", () => {
    expect(cleanTitle("Rotating API keys Copy link")).toBe("Rotating API keys");
    expect(cleanTitle("Webhooks Permalink")).toBe("Webhooks");
  });

  it("leaves a legitimate title intact", () => {
    expect(cleanTitle("How to copy a mission")).toBe("How to copy a mission");
    expect(cleanTitle("Share a playlist with your team")).toBe("Share a playlist with your team");
  });

  it("never empties a title that is only noise", () => {
    expect(cleanTitle("Copied!")).toBe("Copied!");
  });
});

describe("cleanHeadingPath", () => {
  it("collapses the doubled crumbs of an older index", () => {
    expect(
      cleanHeadingPath(
        "Help & Support > Help & Support > Help Center Home > Help Center Home > Asset Hub > Asset Hub > Admin",
      ),
    ).toBe("Help & Support › Help Center Home › Asset Hub › Admin");
  });

  it("keeps a legitimately repeated crumb that isn't adjacent", () => {
    expect(cleanHeadingPath("Admin > SSO > Admin")).toBe("Admin › SSO › Admin");
  });

  it("cleans noise inside a crumb too", () => {
    expect(cleanHeadingPath("Asset Hub > Create play Copied!")).toBe("Asset Hub › Create play");
  });
});

describe("relevancePercent", () => {
  it("reports absolute cosine similarity, not the fused rank score", () => {
    // rankScore is 0.98 here — min-max normalised, so the top hit is always
    // near 1 and would read "98% relevant" for every query ever asked.
    expect(relevancePercent(article())).toBe(46);
  });

  it("never invents a figure when similarity is unknown", () => {
    // Deriving one from rank once printed "60% relevant" next to a refusal
    // saying nothing cleared the 45% floor. Retrieval measures cosine for
    // everything it returns, so this path should not arise at all.
    expect(relevancePercent(article({ similarity: undefined }))).toBe(0);
  });

  it("stays within 0–100", () => {
    expect(relevancePercent(article({ similarity: 0 }))).toBe(0);
    expect(relevancePercent(article({ similarity: 1 }))).toBe(100);
  });
});

describe("articleToSource", () => {
  it("numbers citations from 1, matching the [n] markers in the answer", () => {
    expect(articleToSource(article(), 0).index).toBe(1);
    expect(articleToSource(article(), 5).index).toBe(6);
  });

  it("cleans title and breadcrumb on the way to the card", () => {
    const source = articleToSource(
      article({
        title: "Best practices for mission Copied!",
        headingPath: "Help & Support > Help & Support > Mission",
      }),
      0,
    );
    expect(source.title).toBe("Best practices for mission");
    expect(source.breadcrumb).toBe("Help & Support › Mission");
  });

  it("deep-links to the passage with a text fragment (5.9.5)", () => {
    expect(articleToSource(article(), 0).url).toContain("#:~:text=");
  });
});
