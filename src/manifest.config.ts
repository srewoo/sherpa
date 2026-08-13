import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "../package.json";

/**
 * MV3 manifest (PRD §6). Key choices:
 *  - side panel hosts the chat (5.9.1); the toolbar action opens it;
 *  - an offscreen document runs the crawl/embed loop, dodging the 30s worker
 *    timeout (5.2.1) — the permission is declared here, the doc created lazily;
 *  - host access is NOT requested up front. `optional_host_permissions` lets us
 *    ask per-site at crawl time (5.10.3), keeping the install prompt minimal.
 */
export default defineManifest({
  manifest_version: 3,
  name: "Sherpa — Local Help Search",
  version: pkg.version,
  description:
    "Crawl a documentation site, index it entirely in your browser, and answer questions from that index — no servers, no per-query cost.",
  minimum_chrome_version: "116",
  icons: {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png",
  },
  action: {
    default_title: "Open Sherpa",
    default_icon: {
      "16": "icons/icon-16.png",
      "48": "icons/icon-48.png",
    },
  },
  background: {
    service_worker: "src/background/service-worker.ts",
    type: "module",
  },
  /**
   * A fallback path only. The panel is registered *per tab* by the service
   * worker (`openPanelForTab`), which disables this global default on install
   * so the panel opens in the tab the user asked from rather than every tab at
   * once. Kept so `sidePanel.open` always has a path to fall back on.
   */
  side_panel: {
    default_path: "src/sidepanel/index.html",
  },
  options_page: "src/options/index.html",
  /**
   * `alarms` + `idle` back the scheduled refresh (5.6.6): the alarm asks "is
   * anything due?" on a short cycle, and idle state decides whether the machine
   * is free enough to act on the answer. Neither can read page content.
   */
  permissions: [
    "storage",
    "unlimitedStorage",
    "sidePanel",
    "offscreen",
    "tabs",
    "scripting",
    "alarms",
    "idle",
  ],
  /**
   * No required host permissions. Every origin Sherpa touches is asked for at
   * the moment it is needed, and only then.
   *
   * The three BYOK provider APIs were briefly declared here as *required*, which
   * had every installer accept access to OpenAI, Anthropic and Google for a
   * feature that is off by default and that most users never enable — and it
   * contradicted the note above. They are requested at runtime instead
   * (`requestProviderPermission`), which works without a declaration of their
   * own: Chrome only requires that a requested pattern be contained by a single
   * declared one, and `https://…/*` below contains each provider origin.
   *
   * The cost is one click in Settings for BYOK users. That is the right side of
   * the trade for an extension whose headline claim is that nothing leaves the
   * device unless you ask.
   */
  optional_host_permissions: ["http://*/*", "https://*/*"],
  /**
   * onnxruntime-web compiles the embedding model to WebAssembly, which MV3's
   * default CSP blocks outright. `wasm-unsafe-eval` is the narrow opt-in for
   * that and grants nothing else; script-src stays 'self', so no remote code
   * can load (5.10.1). The WASM binaries and model weights are bundled under
   * web_accessible_resources rather than fetched from a CDN.
   */
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
  web_accessible_resources: [
    {
      resources: ["ort/*", "models/*"],
      matches: ["<all_urls>"],
    },
  ],
  commands: {
    "open-sherpa": {
      suggested_key: { default: "Ctrl+Shift+K", mac: "Command+Shift+K" },
      description: "Open the Sherpa side panel and focus the question box",
    },
  },
});
