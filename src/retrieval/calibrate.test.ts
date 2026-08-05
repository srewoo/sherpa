import { describe, it, expect } from "vitest";
import {
  calibrateFloors,
  floorsForIndex,
  rerankForIndex,
  NEGATIVE_MARGIN,
  MAX_SANE_FLOOR,
  PROBE_QUESTIONS,
  OFF_DOMAIN_PROBES,
  HARD_PROBES,
} from "./calibrate.js";
import { DEFAULT_FLOORS } from "./confidence.js";

const NOW = 1_700_000_000_000;

/** Scores shaped like a real index: negatives clustered well above zero. */
const REAL_NEGATIVES = [
  0.52, 0.55, 0.58, 0.59, 0.61, 0.62, 0.63, 0.64, 0.65, 0.66, 0.67, 0.69, 0.7, 0.72, 0.75,
];

describe("calibrateFloors", () => {
  /**
   * The bug this exists to prevent. Measured against three real help centres,
   * no unanswerable question ever scored below 0.482, while the shipped floor
   * was 0.45 — so the refusal path could not fire and the false-answer rate was
   * 100%. A calibrated floor must land above the negatives, not under them.
   */
  it("puts the floor above the noise the corpus actually produces", () => {
    const c = calibrateFloors({ negativeScores: REAL_NEGATIVES }, NOW);
    expect(c.refuse).toBeGreaterThan(Math.max(...REAL_NEGATIVES) - NEGATIVE_MARGIN);
    expect(c.refuse).toBeGreaterThan(DEFAULT_FLOORS.refuse);
  });

  it("keeps confident above refuse so the middle band exists", () => {
    const c = calibrateFloors({ negativeScores: REAL_NEGATIVES }, NOW);
    expect(c.confident).toBeGreaterThan(c.refuse);
  });

  /**
   * One probe brushing a real topic — a docs site with a travel-expenses page
   * answering the Tokyo question — must not drag the floor up for every query.
   */
  it("ignores a single outlier negative", () => {
    const withOutlier = [...REAL_NEGATIVES.slice(0, 14), 0.95];
    const base = calibrateFloors({ negativeScores: REAL_NEGATIVES }, NOW);
    const out = calibrateFloors({ negativeScores: withOutlier }, NOW);
    expect(out.refuse - base.refuse).toBeLessThan(0.1);
  });

  /**
   * Calibrating an index into silence is worse than the bug being fixed: a
   * floor above where the corpus's own content scores refuses everything.
   */
  it("never rises above the index's own content", () => {
    const c = calibrateFloors(
      { negativeScores: REAL_NEGATIVES, positiveScores: [0.6, 0.62, 0.63, 0.64, 0.66, 0.68] },
      NOW,
    );
    expect(c.refuse).toBeLessThanOrEqual(0.62);
  });

  it("falls back to the shipped defaults on too little evidence", () => {
    const c = calibrateFloors({ negativeScores: [0.5, 0.6] }, NOW);
    expect(c.refuse).toBe(DEFAULT_FLOORS.refuse);
    expect(c.confident).toBe(DEFAULT_FLOORS.confident);
    expect(c.samples).toBe(2);
  });

  it("never returns a floor below the shipped default", () => {
    const c = calibrateFloors({ negativeScores: Array(15).fill(0.1) }, NOW);
    expect(c.refuse).toBeGreaterThanOrEqual(DEFAULT_FLOORS.refuse);
  });

  it("caps the floor so a strange corpus cannot silence the index", () => {
    const c = calibrateFloors({ negativeScores: Array(15).fill(0.99) }, NOW);
    expect(c.refuse).toBeLessThanOrEqual(MAX_SANE_FLOOR);
  });

  it("discards non-finite and zero scores rather than averaging them in", () => {
    const c = calibrateFloors(
      { negativeScores: [...REAL_NEGATIVES, 0, Number.NaN, Number.POSITIVE_INFINITY] },
      NOW,
    );
    expect(c.samples).toBe(REAL_NEGATIVES.length);
  });

  it("records when it ran, so a stale calibration is visible", () => {
    expect(calibrateFloors({ negativeScores: REAL_NEGATIVES }, NOW).at).toBe(NOW);
  });
});

describe("floorsForIndex", () => {
  const calibrated = { refuse: 0.72, confident: 0.8 };

  it("prefers the index's own calibration", () => {
    expect(floorsForIndex(calibrated, DEFAULT_FLOORS, false)).toEqual(calibrated);
  });

  /** Every index built before calibration existed still has to work. */
  it("falls back to settings when the index was never calibrated", () => {
    expect(floorsForIndex(undefined, DEFAULT_FLOORS, false)).toEqual(DEFAULT_FLOORS);
  });

  it("lets a hand-tuned setting win", () => {
    const manual = { refuse: 0.5, confident: 0.6 };
    expect(floorsForIndex(calibrated, manual, true)).toEqual(manual);
  });
});

describe("rerankForIndex", () => {
  /**
   * Measured on the same day, on two real corpora: +45 points hit@1 where the
   * titles are near-synonymous, −30 where first-stage ranking was already good.
   * A global switch is wrong in both positions, so the index decides.
   */
  it("lets an index opt in when the global setting is off", () => {
    expect(rerankForIndex(true, false)).toBe(true);
  });

  it("lets an index opt out when the global setting is on", () => {
    expect(rerankForIndex(false, true)).toBe(false);
  });

  /**
   * Undecided must mean "follow Settings", not "off". Every index built before
   * this field existed has `undefined`, and they have to keep behaving exactly
   * as they did.
   */
  it("follows the global setting when the index has no preference", () => {
    expect(rerankForIndex(undefined, true)).toBe(true);
    expect(rerankForIndex(undefined, false)).toBe(false);
  });
});

describe("probe set", () => {
  it("has enough questions for a stable estimate", () => {
    expect(PROBE_QUESTIONS.length).toBeGreaterThanOrEqual(30);
  });

  /**
   * Probes must be plausible sentences. Gibberish scores low for reasons that
   * say nothing about where a real wrong question lands, which is the only
   * thing the floor cares about.
   */
  it("uses well-formed questions, not gibberish", () => {
    for (const q of PROBE_QUESTIONS) {
      expect(q.split(/\s+/).length).toBeGreaterThanOrEqual(5);
    }
  });

  it("combines both probe kinds, since neither alone calibrates correctly", () => {
    expect(PROBE_QUESTIONS).toEqual([...OFF_DOMAIN_PROBES, ...HARD_PROBES]);
    expect(OFF_DOMAIN_PROBES.length).toBeGreaterThanOrEqual(10);
    expect(HARD_PROBES.length).toBeGreaterThanOrEqual(10);
  });

  it("keeps the off-domain probes clear of anything a product documents", () => {
    const productish = /\b(login|password|api|account|dashboard|integration|admin|billing)\b/i;
    for (const q of OFF_DOMAIN_PROBES) expect(productish.test(q)).toBe(false);
  });

  /**
   * The hard probes are deliberately on-topic — that is the entire point, and
   * measuring showed the floor is far too low without them. What they must
   * avoid is being *technical*, because a technical probe risks being genuinely
   * documented: asking "how do I configure SAML" of a corpus that covers SAML
   * would drag the floor up and start refusing real questions.
   */
  it("keeps the hard probes commercial, never technical", () => {
    const technical =
      /\b(saml|sso|api|webhook|oauth|integration|export|import|dashboard|password|login|configure)\b/i;
    for (const q of HARD_PROBES) expect(technical.test(q)).toBe(false);
  });
});
