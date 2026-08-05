import { describe, it, expect } from "vitest";
import { FieldedBm25Index, FIELD_WEIGHTS, type FieldedDoc } from "./fieldedBm25.js";
import { Bm25Index } from "./bm25.js";

const DOCS: FieldedDoc[] = [
  {
    id: 1,
    title: "AI Roleplay - AI Scenario Creator",
    section: "Admin > AI Interactive roleplay",
    content: "Set up a scenario for learners to practise against. ".repeat(20),
  },
  {
    id: 2,
    title: "Call AI integration with Salesforce",
    section: "Call AI > Integrations",
    content: "The integration works in two ways: 1-way SFDC and 2-way SFDC. ".repeat(20),
  },
  {
    id: 3,
    title: "Best practices for mission",
    section: "Mission > File upload",
    content: "Video roleplay includes one-way and two-way roleplays. ".repeat(20),
  },
];

describe("FieldedBm25Index", () => {
  it("ranks a title match above a body-only match", () => {
    // The regression this exists for: a flat index buried "AI Roleplay" in the
    // title behind hundreds of body words on other pages.
    const index = FieldedBm25Index.build(DOCS);
    expect(index.search("roleplay", 3)[0]?.id).toBe(1);
  });

  it("beats an unweighted index on the same corpus", () => {
    const flat = new Bm25Index(
      DOCS.map((d) => ({ id: d.id, text: `${d.title} ${d.section} ${d.content}` })),
    );
    const fielded = FieldedBm25Index.build(DOCS);

    // Flat scoring lets the body-heavy documents win; weighting fixes it.
    expect(flat.search("roleplay", 3)[0]?.id).not.toBe(1);
    expect(fielded.search("roleplay", 3)[0]?.id).toBe(1);
  });

  it("still finds a term that appears only in the body", () => {
    expect(FieldedBm25Index.build(DOCS).search("SFDC", 3)[0]?.id).toBe(2);
  });

  it("uses the section field", () => {
    expect(FieldedBm25Index.build(DOCS).search("integrations", 3)[0]?.id).toBe(2);
  });

  it("weights title above section above content", () => {
    expect(FIELD_WEIGHTS.title).toBeGreaterThan(FIELD_WEIGHTS.section);
    expect(FIELD_WEIGHTS.section).toBeGreaterThan(FIELD_WEIGHTS.content);
  });

  it("round-trips through a snapshot", () => {
    const original = FieldedBm25Index.build(DOCS);
    const restored = FieldedBm25Index.fromSnapshot(original.toSnapshot());
    expect(restored.search("roleplay", 3)).toEqual(original.search("roleplay", 3));
    expect(restored.search("SFDC", 3)).toEqual(original.search("SFDC", 3));
  });

  it("returns nothing for a term absent from every field", () => {
    expect(FieldedBm25Index.build(DOCS).search("kubernetes", 3)).toEqual([]);
  });

  it("respects k", () => {
    expect(FieldedBm25Index.build(DOCS).search("roleplay", 1)).toHaveLength(1);
  });
});
