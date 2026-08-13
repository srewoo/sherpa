import { describe, it, expect } from "vitest";
import { DEFAULT_REFINE } from "@/retrieval/refine.js";
import {
  sweepScatter,
  wouldOffer,
  sweepFloors,
  recommendFloor,
  formatFloorSweep,
  DEFAULT_FLOORS,
  type FloorCase,
} from "./floorSweep.js";

const answerable = (topScore: number, retrieved = true): FloorCase => ({
  topScore,
  answerable: true,
  retrieved,
});
const unanswerable = (topScore: number): FloorCase => ({
  topScore,
  answerable: false,
  retrieved: false,
});

describe("sweepFloors", () => {
  it("counts an unanswerable question above the floor as a false answer", () => {
    const [result] = sweepFloors([unanswerable(0.6)], [0.5]);
    expect(result?.falseAnswers).toBe(1);
    expect(result?.falseAnswerRate).toBe(1);
  });

  /**
   * The half that was never measured: raising the floor buys a lower
   * false-answer rate by refusing questions the docs plainly answer, and
   * without this number that cost is invisible.
   */
  it("counts an answerable, retrieved question below the floor as a missed answer", () => {
    const [result] = sweepFloors([answerable(0.3)], [0.5]);
    expect(result?.missedAnswers).toBe(1);
    expect(result?.missedAnswerRate).toBe(1);
  });

  /** A question retrieval never found is a retrieval failure, not the floor's. */
  it("does not blame the floor for a question retrieval never surfaced", () => {
    const [result] = sweepFloors([answerable(0.1, false)], [0.5]);
    expect(result?.missedAnswers).toBe(0);
  });

  it("shows the trade moving in opposite directions as the floor rises", () => {
    const cases = [answerable(0.5), answerable(0.7), unanswerable(0.45), unanswerable(0.6)];
    const [low, high] = sweepFloors(cases, [0.4, 0.65]);
    expect(low!.falseAnswerRate).toBeGreaterThan(high!.falseAnswerRate);
    expect(low!.missedAnswerRate).toBeLessThan(high!.missedAnswerRate);
  });

  it("treats a score exactly at the floor as answerable", () => {
    // The product's own check is `topScore < floor` → refuse.
    expect(sweepFloors([unanswerable(0.5)], [0.5])[0]?.falseAnswers).toBe(1);
    expect(sweepFloors([answerable(0.5)], [0.5])[0]?.missedAnswers).toBe(0);
  });

  it("reports every floor asked for", () => {
    expect(sweepFloors([answerable(0.5)], DEFAULT_FLOORS)).toHaveLength(DEFAULT_FLOORS.length);
  });

  it("handles a set with no unanswerable questions", () => {
    expect(sweepFloors([answerable(0.5)], [0.4])[0]?.falseAnswerRate).toBe(0);
  });
});

describe("recommendFloor", () => {
  /** Lowest that clears the target — past the knee, strictness only costs answers. */
  it("picks the lowest floor meeting the target, not the strictest", () => {
    const cases = [unanswerable(0.5), answerable(0.6), answerable(0.75)];
    const chosen = recommendFloor(sweepFloors(cases, [0.4, 0.55, 0.7]), 0);
    expect(chosen?.floor).toBe(0.55);
  });

  it("returns nothing when no floor is strict enough — which is the finding", () => {
    const cases = [unanswerable(0.99)];
    expect(recommendFloor(sweepFloors(cases, [0.2, 0.4]), 0)).toBeUndefined();
  });
});

describe("formatFloorSweep", () => {
  it("renders a readable table", () => {
    const text = formatFloorSweep(sweepFloors([answerable(0.5), unanswerable(0.3)], [0.4]));
    expect(text).toContain("false-answer");
    expect(text).toContain("0.40");
  });
});

describe("scatter sweep", () => {
  /** Three pages within a whisker of each other: genuinely several answers. */
  const scattered = { leadingSimilarities: [0.72, 0.71, 0.70], singleIntent: false };
  /** One page clearly ahead: an answer, whatever trails it. */
  const dominant = { leadingSimilarities: [0.82, 0.55, 0.50], singleIntent: true };
  /** Nothing to be ambiguous between. */
  const thin = { leadingSimilarities: [0.72, 0.71], singleIntent: true };

  it("offers on a tight cluster and stays quiet on a clear leader", () => {
    expect(wouldOffer(scattered, 0.03)).toBe(true);
    expect(wouldOffer(dominant, 0.03)).toBe(false);
  });

  it("never offers when there are too few distinct pages", () => {
    expect(wouldOffer(thin, 1)).toBe(false);
  });

  it("reports both sides of the trade at each delta", () => {
    const results = sweepScatter([scattered, dominant, thin], [0.01, 0.03, 0.5]);
    const tight = results.find((r) => r.delta === 0.01);
    const loose = results.find((r) => r.delta === 0.5);

    // Too tight: the genuine ambiguity is missed.
    expect(tight?.missedOfferRate).toBe(1);
    expect(tight?.falseOfferRate).toBe(0);
    // Too loose: the clear winner gets cluttered with chips it doesn't need.
    expect(loose?.missedOfferRate).toBe(0);
    expect(loose?.falseOffers).toBe(1);
  });

  /**
   * The shipped default has to survive its own sweep. A number that offers on
   * a dominant leader is the old bug in new clothes.
   */
  it("keeps the shipped delta quiet on a dominant leader", () => {
    expect(wouldOffer(dominant, DEFAULT_REFINE.scatterDelta)).toBe(false);
    expect(wouldOffer(scattered, DEFAULT_REFINE.scatterDelta)).toBe(true);
  });
});
