import { describe, it, expect } from "vitest";
import { classify, toQuestion, buildStarters, type StarterSource } from "./starters.js";

describe("toQuestion", () => {
  it("does not force a noun phrase into 'How do I …' (regression)", () => {
    // These three shipped as "How do I release Notes?", "How do I new
    // features?" and "How do I archive assets API?".
    expect(toQuestion("Release Notes")).toBeNull(); // filtered as changelog noise
    expect(toQuestion("New features")).toBe("What is New features?");
    expect(toQuestion("Archive assets API")).toBe("How do I archive assets API?");
  });

  it("turns a gerund heading into a natural question", () => {
    expect(toQuestion("Creating a mission")).toBe("How do I create a mission?");
    expect(toQuestion("Setting up SSO")).toBe("How do I set up SSO?");
    expect(toQuestion("Managing user roles")).toBe("How do I manage user roles?");
  });

  it("turns an imperative title into a question", () => {
    expect(toQuestion("Configure single sign-on")).toBe("How do I configure single sign-on?");
    expect(toQuestion("Import users from a CSV")).toBe("How do I import users from a CSV?");
  });

  it("keeps a title that is already a question", () => {
    expect(toQuestion("How does Salesforce integration work?")).toBe(
      "How does Salesforce integration work?",
    );
  });

  it("phrases a short noun phrase as 'What is …'", () => {
    expect(toQuestion("Asset Hub")).toBe("What is Asset Hub?");
  });

  it("drops audience tags and parentheticals", () => {
    expect(toQuestion("Create a play as an asset [admin]")).toBe(
      "How do I create a play as an asset?",
    );
    expect(toQuestion("Configure roleplay (Beta)")).toBe("How do I configure roleplay?");
  });

  it("rejects what it can't phrase naturally", () => {
    // A sentence-shaped heading makes an awkward question.
    expect(toQuestion("Roleplay ends in any of these cases")).toBeNull();
    expect(toQuestion("Web release - July 2026")).toBeNull();
    expect(toQuestion("Changelog")).toBeNull();
    expect(toQuestion("Coming soon: attribute changes")).toBeNull();
    expect(toQuestion("Home")).toBeNull();
    expect(toQuestion("FAQ")).toBeNull(); // too short to be useful
  });
});

describe("classify", () => {
  it("recognises each shape", () => {
    expect(classify("Creating a mission")).toBe("gerund");
    expect(classify("Configure SSO now")).toBe("imperative");
    expect(classify("What is a mission?")).toBe("question");
    expect(classify("Asset Hub")).toBe("noun");
    expect(classify("Release notes")).toBe("unusable");
  });
});

describe("buildStarters", () => {
  const sources: StarterSource[] = [
    { title: "Creating a mission", headingPath: "Missions > Setup", weight: 4000 },
    { title: "Mission scoring", headingPath: "Missions > Scoring", weight: 3900 },
    { title: "Configure single sign-on", headingPath: "Admin > SSO", weight: 3000 },
    { title: "Release Notes", headingPath: "Updates > Releases", weight: 9000 },
  ];

  it("spreads suggestions across sections rather than one topic", () => {
    const out = buildStarters(sources, "", 3);
    // Both Missions pages outrank the Admin one, but only one should appear.
    expect(out.filter((q) => q.toLowerCase().includes("mission"))).toHaveLength(1);
    expect(out).toContain("How do I configure single sign-on?");
  });

  it("never suggests a changelog even when it is the biggest page", () => {
    expect(buildStarters(sources, "", 3).some((q) => /release notes/i.test(q))).toBe(false);
  });

  it("adds a generic question only when the corpus can answer it", () => {
    const withLimits = buildStarters(sources, "each file has a maximum of 200 MB", 3);
    expect(withLimits).toContain("What are the limits and quotas?");

    const without = buildStarters(sources, "nothing relevant here", 3);
    expect(without).not.toContain("What are the limits and quotas?");
  });

  it("respects the limit and returns no duplicates", () => {
    const out = buildStarters(sources, "getting started guide with limits and permissions", 3);
    expect(out).toHaveLength(3);
    expect(new Set(out).size).toBe(3);
  });

  it("returns fewer than the limit rather than padding with nonsense", () => {
    const poor: StarterSource[] = [
      { title: "Release Notes", headingPath: "Updates", weight: 100 },
      { title: "Home", headingPath: "Home", weight: 100 },
    ];
    expect(buildStarters(poor, "", 3)).toEqual([]);
  });
});
