import { describe, it, expect } from "vitest";
import { fnv1a } from "./hash.js";

describe("fnv1a", () => {
  it("is deterministic and 8 hex chars", () => {
    expect(fnv1a("hello")).toBe(fnv1a("hello"));
    expect(fnv1a("hello")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("differs for different input, including the empty string", () => {
    expect(fnv1a("a")).not.toBe(fnv1a("b"));
    expect(fnv1a("")).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a("Bulk Import")).not.toBe(fnv1a("bulk import"));
  });
});
