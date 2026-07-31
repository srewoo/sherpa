import { useState } from "react";
import { CrawlSetup } from "./pages/CrawlSetup.js";
import { Indexes } from "./pages/Indexes.js";
import { Settings } from "./pages/Settings.js";

/**
 * Full-tab options shell. Crawl setup, indexes and settings are live React
 * wired to the engines; gap report and states remain the static design pages
 * (P1 / reference) shown in an iframe.
 */

type Kind = "live" | "page";
interface Section {
  readonly id: string;
  readonly label: string;
  readonly kind: Kind;
  readonly page?: string;
}

const SECTIONS: readonly Section[] = [
  { id: "setup", label: "Set up an index", kind: "live" },
  { id: "indexes", label: "Indexes", kind: "live" },
  { id: "settings", label: "Settings", kind: "live" },
  { id: "gap", label: "Gap report", kind: "page", page: "pages/gap-report.html" },
  { id: "states", label: "States & auth", kind: "page", page: "pages/states.html" },
];

function pageUrl(page: string): string {
  return typeof chrome !== "undefined" && chrome.runtime?.getURL ? chrome.runtime.getURL(page) : `/${page}`;
}

function Live({ id }: { id: string }): JSX.Element {
  if (id === "indexes") return <Indexes />;
  if (id === "settings") return <Settings />;
  return <CrawlSetup />;
}

export function Options(): JSX.Element {
  const [active, setActive] = useState<Section>(SECTIONS[0]!);

  return (
    <div className="options-shell">
      <nav className="options-nav" aria-label="Sherpa sections">
        <div className="brand" style={{ padding: "4px 8px 16px" }}>
          <svg className="brand-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 20 L9.5 7 L13 14 L15.5 9 L21 20 Z" />
            <path d="M8 20 L11 14.5" />
          </svg>
          <span className="brand-name">Sherpa</span>
        </div>
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" className={s.id === active.id ? "options-navitem active" : "options-navitem"}
            onClick={() => setActive(s)} aria-current={s.id === active.id ? "page" : undefined}>
            {s.label}
          </button>
        ))}
      </nav>
      <main className="options-main">
        {active.kind === "live" ? (
          <div className="options-scroll"><Live id={active.id} /></div>
        ) : (
          <iframe key={active.id} className="options-frame" title={active.label} src={pageUrl(active.page!)} />
        )}
      </main>
    </div>
  );
}
