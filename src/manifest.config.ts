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
  side_panel: {
    default_path: "src/sidepanel/index.html",
  },
  options_page: "src/options/index.html",
  permissions: ["storage", "unlimitedStorage", "sidePanel", "offscreen", "tabs", "scripting"],
  optional_host_permissions: ["http://*/*", "https://*/*"],
  commands: {
    "open-sherpa": {
      suggested_key: { default: "Ctrl+Shift+K", mac: "Command+Shift+K" },
      description: "Open the Sherpa side panel and focus the question box",
    },
  },
});
