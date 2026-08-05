import { useEffect, useState } from "react";
import { CrawlSetup, type RecrawlTarget } from "./pages/CrawlSetup.js";
import { Indexes } from "./pages/Indexes.js";
import { Settings } from "./pages/Settings.js";
import { GapReport } from "./pages/GapReport.js";
import { Welcome } from "./pages/Welcome.js";

/**
 * Full-tab options shell. Every section is live React wired to the engines; the
 * service worker opens this page at `#welcome` on install for the first-run
 * disclosure (PRD 5.10.4).
 */

/** Absolute URL for a bundled documentation page (see sidepanel/App.tsx). */
function docUrl(page: "help" | "privacy"): string {
  const path = `src/${page}/index.html`;
  return typeof chrome !== "undefined" && chrome.runtime?.getURL
    ? chrome.runtime.getURL(path)
    : `/${path}`;
}

interface Section {
  readonly id: string;
  readonly label: string;
}

const SECTIONS: readonly Section[] = [
  { id: "setup", label: "Set up an index" },
  { id: "indexes", label: "Indexes" },
  { id: "gap", label: "Gap report" },
  { id: "settings", label: "Settings" },
];

export function Options(): JSX.Element {
  const [activeId, setActiveId] = useState<string>(() =>
    typeof location !== "undefined" && location.hash === "#welcome" ? "welcome" : "setup",
  );
  /** Set when Indexes sends the user to setup to re-crawl an existing site. */
  const [recrawl, setRecrawl] = useState<RecrawlTarget | null>(null);

  // Keep the hash in sync so the welcome screen is linkable and survives reload.
  useEffect(() => {
    const onHash = (): void => {
      if (location.hash === "#welcome") setActiveId("welcome");
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (id: string): void => {
    if (id !== "setup") setRecrawl(null);
    setActiveId(id);
    if (typeof location !== "undefined" && location.hash) location.hash = "";
  };

  return (
    <div className="options-shell">
      <nav className="options-nav" aria-label="Sherpa sections">
        <div className="brand" style={{ padding: "4px 8px 16px" }}>
          <svg
            className="brand-mark"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 20 L9.5 7 L13 14 L15.5 9 L21 20 Z" />
            <path d="M8 20 L11 14.5" />
          </svg>
          <span className="brand-name">Sherpa</span>
        </div>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={s.id === activeId ? "options-navitem active" : "options-navitem"}
            onClick={() => go(s.id)}
            aria-current={s.id === activeId ? "page" : undefined}
          >
            {s.label}
          </button>
        ))}
        {/*
          Pushed to the bottom of the nav, away from the sections that do work.
          Both pages ship inside the extension rather than being hosted, so the
          privacy policy is readable offline and needs no network request to
          make its own claim.
        */}
        <div className="options-navfoot">
          <a className="options-navlink" href={docUrl("help")} target="_blank" rel="noreferrer">
            Help
          </a>
          <a className="options-navlink" href={docUrl("privacy")} target="_blank" rel="noreferrer">
            Privacy
          </a>
        </div>
      </nav>
      <main className="options-main">
        <div className="options-scroll">
          {activeId === "welcome" && <Welcome onStart={() => go("setup")} />}
          {activeId === "setup" && <CrawlSetup recrawl={recrawl} onDone={() => setRecrawl(null)} />}
          {activeId === "indexes" && (
            <Indexes
              onRecrawl={(target) => {
                setRecrawl(target);
                setActiveId("setup");
              }}
            />
          )}
          {activeId === "gap" && <GapReport />}
          {activeId === "settings" && <Settings />}
        </div>
      </main>
    </div>
  );
}
