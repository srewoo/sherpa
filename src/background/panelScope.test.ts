import { describe, it, expect } from "vitest";
import { panelEnabledFor } from "./panelScope.js";

const OWNER = 7;
const OTHER = 8;

describe("panelEnabledFor", () => {
  /**
   * The regression that made the toolbar icon dead: with the panel disabled by
   * default there was nothing for `sidePanel.open()` to open, so the click did
   * nothing and said nothing. While the panel is closed, every tab must be
   * eligible.
   */
  it("enables every tab while the panel is closed, so the icon always works", () => {
    expect(panelEnabledFor(OWNER, null, false)).toBe(true);
    expect(panelEnabledFor(OTHER, null, false)).toBe(true);
    expect(panelEnabledFor(OTHER, OWNER, false)).toBe(true);
  });

  it("keeps an open panel in the tab that opened it", () => {
    expect(panelEnabledFor(OWNER, OWNER, true)).toBe(true);
  });

  /** The original complaint: the panel followed the user across every tab. */
  it("hides an open panel in every other tab", () => {
    expect(panelEnabledFor(OTHER, OWNER, true)).toBe(false);
  });

  it("releases every tab when an open panel has no owner", () => {
    // Owner closed its tab: nothing should stay disabled and unreachable.
    expect(panelEnabledFor(OTHER, null, true)).toBe(false);
    expect(panelEnabledFor(OWNER, null, true)).toBe(false);
  });
});
