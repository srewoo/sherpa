import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "@/ui/styles.css";

/**
 * Tell the worker the panel is up, and — by this port dropping when the panel
 * closes — when it is not. There is no API to ask whether the side panel is
 * open, and the worker needs the answer to keep the panel confined to the tab
 * it was opened from while still letting the toolbar icon work everywhere else
 * (see background/panelScope.ts).
 */
if (typeof chrome !== "undefined" && chrome.runtime?.id) {
  chrome.runtime.connect({ name: "sherpa-panel" });
}

const container = document.getElementById("root");
if (!container) throw new Error("side panel root element missing");
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
