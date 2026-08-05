/**
 * Which tabs the side panel is available in (PRD 5.9.1).
 *
 * Chrome's side panel is per *window*, not per tab: while it is open it shows
 * in whatever tab you switch to, as long as that tab has a panel enabled. A
 * manifest `default_path` enables every tab, which is why Sherpa appeared to
 * open everywhere at once. The only lever for confining it is per-tab
 * `setOptions({enabled})`.
 *
 * That gives one rule, and the rule has to serve two things at once — the panel
 * must stay in the tab it was opened from, *and* the toolbar icon must still
 * work everywhere:
 *
 *   enabled(tab) = panel is closed  OR  tab is the one that opened it
 *
 * While the panel is closed every tab is enabled, so `sidePanel.open()` always
 * has something to open — the click cannot silently do nothing. Once it is
 * open, every tab but its owner is disabled, so switching tabs hides it instead
 * of dragging it along.
 */
export function panelEnabledFor(
  tabId: number,
  ownerTabId: number | null,
  panelOpen: boolean,
): boolean {
  if (!panelOpen) return true;
  return tabId === ownerTabId;
}
