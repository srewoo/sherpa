import { describe, it, expect } from "vitest";
import { dot, l2norm, normalizeInPlace } from "./vecmath.js";

describe("vecmath", () => {
  it("dot of identical unit vectors is ~1, orthogonal is 0", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(dot(a, a)).toBeCloseTo(1);
    expect(dot(a, b)).toBeCloseTo(0);
  });

  it("dot reads a row of a packed matrix via offset", () => {
    const matrix = new Float32Array([1, 0, 0, 1]); // two 2-d rows
    const q = new Float32Array([0, 1]);
    expect(dot(matrix, q, 0)).toBeCloseTo(0); // row 0 = [1,0]
    expect(dot(matrix, q, 2)).toBeCloseTo(1); // row 1 = [0,1]
  });

  it("normalizeInPlace yields unit length and tolerates zero", () => {
    const v = new Float32Array([3, 4]);
    normalizeInPlace(v);
    expect(l2norm(v)).toBeCloseTo(1);
    const z = new Float32Array([0, 0]);
    normalizeInPlace(z);
    expect(z[0]).toBe(0);
  });
});
