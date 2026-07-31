import { describe, it, expect } from "vitest";
import { estimateIndexBytes, preflight, BYTES_PER_PAGE } from "./quota.js";

describe("quota preflight", () => {
  it("estimates index size from page count", () => {
    expect(estimateIndexBytes(2000)).toBe(2000 * BYTES_PER_PAGE);
  });

  it("fits when free space exceeds the estimate", () => {
    const p = preflight(1000, { usage: 10_000_000, quota: 100_000_000 });
    expect(p.fits).toBe(true);
    expect(p.available).toBe(90_000_000);
  });

  it("refuses when the estimate won't fit", () => {
    const p = preflight(5000, { usage: 95_000_000, quota: 100_000_000 });
    expect(p.needed).toBe(estimateIndexBytes(5000));
    expect(p.fits).toBe(false);
  });

  it("never reports negative available space", () => {
    expect(preflight(1, { usage: 200, quota: 100 }).available).toBe(0);
  });
});
